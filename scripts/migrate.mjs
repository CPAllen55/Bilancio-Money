/**
 * Applies pending migrations from ./drizzle to a Neon branch (dev | prod).
 * Used instead of `drizzle-kit migrate`, whose CLI loader is broken on Node 24.
 *
 *   npm run db:migrate         # dev branch
 *   npm run db:migrate:prod    # production branch
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Argument first, env second. `TARGET=x cmd` does not work in PowerShell, so
// the npm scripts pass the branch as an argument instead. Defaults to dev:
// migrating production should always be something you asked for explicitly.
const target = (process.argv[2] ?? process.env.TARGET ?? "dev").toLowerCase();
const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!url) {
  console.error(`No connection string for target "${target}". Check .env.`);
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log(`Migrations applied to ${target}.`);

  // System categories are reference data, not schema, so they are seeded here
  // rather than baked into a migration file. Idempotent: re-running updates
  // labels and colours without disturbing anyone's own categories, which have
  // a user_id and are matched by a different index entirely.
  const system = JSON.parse(
    readFileSync(new URL("../src/db/system-categories.json", import.meta.url), "utf8"),
  );

  // Two passes: every row has to exist before any of them can point at a
  // parent, and a single pass would depend on the JSON being ordered correctly.
  for (const c of system) {
    await client.query(
      `insert into categories (user_id, slug, label, colour, sort_order, is_system, kind)
       values (null, $1, $2, $3, $4, true, $5)
       on conflict (slug) where user_id is null
       do update set label = excluded.label,
                     colour = excluded.colour,
                     sort_order = excluded.sort_order,
                     kind = excluded.kind`,
      [c.slug, c.label, c.colour, c.sortOrder, c.kind ?? "spend"],
    );
  }

  for (const c of system) {
    if (c.parent) {
      await client.query(
        `update categories child
            set parent_id = parent.id
           from categories parent
          where child.slug = $1
            and child.user_id is null
            and parent.slug = $2
            and parent.user_id is null`,
        [c.slug, c.parent],
      );
    } else {
      // Explicit, so a category promoted to a parent in the JSON actually loses
      // its old parent rather than silently keeping it.
      await client.query(
        `update categories set parent_id = null where slug = $1 and user_id is null`,
        [c.slug],
      );
    }
  }

  // A category dropped from the JSON has to actually go, or the seed is only
  // ever additive: it would keep its row, keep appearing in every dropdown, and
  // — if it was a parent whose children have been reparented — sit in the
  // Categories tab as an empty heading nobody can get rid of.
  //
  // Archived rather than deleted. A transaction override or a merchant rule may
  // point at it, and those are the user's own decisions; deleting the row would
  // either break the reference or silently discard them. Archived rows are
  // filtered out on read, so the effect is the same and nothing is destroyed.
  // Re-adding a slug to the JSON brings it straight back.
  const slugs = system.map((c) => c.slug);
  const { rows: archived } = await client.query(
    `update categories
        set archived_at = now()
      where user_id is null and is_system and archived_at is null
        and slug <> all($1::text[])
      returning slug`,
    [slugs],
  );
  const { rows: restored } = await client.query(
    `update categories
        set archived_at = null
      where user_id is null and is_system and archived_at is not null
        and slug = any($1::text[])
      returning slug`,
    [slugs],
  );

  const parents = system.filter((c) => !c.parent).length;
  console.log(`${system.length} system categories seeded (${parents} parents, ${system.length - parents} sub-categories).`);
  if (archived.length) console.log(`Archived ${archived.length}: ${archived.map((r) => r.slug).join(", ")}`);
  if (restored.length) console.log(`Restored ${restored.length}: ${restored.map((r) => r.slug).join(", ")}`);
} finally {
  await client.end();
}

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

  for (const c of system) {
    await client.query(
      `insert into categories (user_id, slug, label, colour, sort_order, is_system)
       values (null, $1, $2, $3, $4, true)
       on conflict (slug) where user_id is null
       do update set label = excluded.label,
                     colour = excluded.colour,
                     sort_order = excluded.sort_order`,
      [c.slug, c.label, c.colour, c.sortOrder],
    );
  }
  console.log(`${system.length} system categories seeded.`);
} finally {
  await client.end();
}

/**
 * Applies pending migrations from ./drizzle to a Neon branch (dev | prod).
 * Used instead of `drizzle-kit migrate`, whose CLI loader is broken on Node 24.
 *
 *   npm run db:migrate         # dev branch
 *   npm run db:migrate:prod    # production branch
 */
import "dotenv/config";
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
} finally {
  await client.end();
}

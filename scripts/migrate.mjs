/**
 * Applies pending migrations from ./drizzle to the Neon branch named by the
 * TARGET env var (dev | prod). Used instead of `drizzle-kit migrate`, whose
 * CLI loader is broken on Node 24.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const target = (process.env.TARGET ?? "dev").toLowerCase();
const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!url) {
  console.error(`No connection string for TARGET=${target}. Check .env.`);
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

import "dotenv/config";
import type { Config } from "drizzle-kit";

// Migrations run from this machine, not from the Worker: drizzle-kit is a Node
// tool and Hyperdrive only exists inside the Workers runtime. So this uses the
// direct Neon connection string from .env, never the Hyperdrive binding.
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL_DEV! },
} satisfies Config;

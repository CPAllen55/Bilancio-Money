import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "./schema";

// One client per request. Workers are short-lived, so never cache a client
// across requests - always close it via ctx.waitUntil(close()).
export function getDb(env: Env) {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  const connect = client.connect();
  return {
    db: drizzle(client, { schema }),
    ready: connect,
    close: () => client.end(),
  };
}

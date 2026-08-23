import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "./schema";

/**
 * A second Hyperdrive binding, pointed at the same database with caching left
 * on. Optional: until it exists in wrangler.jsonc every call falls back to the
 * uncached one, so adding this changes nothing on its own.
 *
 * Declared here rather than in wrangler's generated types because it is
 * genuinely optional — the code has to work with it absent.
 */
type EnvWithCache = Env & { HYPERDRIVE_CACHED?: Hyperdrive };

/**
 * One client per request. Workers are short-lived, so never cache a client
 * across requests — always close it via ctx.waitUntil(close()).
 *
 * ── Which binding, and why there are two ──────────────────────────────────
 *
 * Hyperdrive can cache the results of read queries, which is worth having: the
 * dashboards re-run the same expensive aggregate whenever somebody moves
 * between tabs and comes back. But it caches by query text and parameters with
 * no idea a write has happened, so a read straight after a write can return the
 * value from before it. That is not a theoretical risk here — it is what made
 * the Budgeting tab appear to forget a planning method the moment it was
 * chosen, and why caching was turned off for the whole database.
 *
 * Off for everything is heavier than it needs to be, though, because the two
 * kinds of query want opposite things:
 *
 *   - The dashboards read a lot and write nothing. A figure a minute out of
 *     date is invisible, and these are the queries that cost real money —
 *     two years of transactions aggregated per page view.
 *
 *   - Settings — planning methods, categories, metal holdings — are small,
 *     cheap, and read straight back after being written. Caching buys nothing
 *     there and costs the only bug anybody noticed.
 *
 * So `cached: true` opts a route into the caching binding. Everything else
 * keeps the uncached one, which is the safe default and the present behaviour.
 *
 * Worth being clear about what this buys: Hyperdrive keys its cache on the
 * query AND its parameters, and every expensive query here is scoped to one
 * user's account ids. Two people reading their own Overview share nothing. The
 * hits come from one person revisiting a tab, reloading, or keeping two open —
 * real, but a long way from the order-of-magnitude that pre-computed monthly
 * rollups would be.
 */
export function getDb(env: Env, opts?: { cached?: boolean }) {
  const withCache = env as EnvWithCache;
  const binding = opts?.cached && withCache.HYPERDRIVE_CACHED
    ? withCache.HYPERDRIVE_CACHED
    : env.HYPERDRIVE;

  const client = new Client({ connectionString: binding.connectionString });
  const connect = client.connect();
  return {
    db: drizzle(client, { schema }),
    ready: connect,
    close: () => client.end(),
  };
}

/**
 * Closing bank connections once access has ended.
 *
 * Plaid bills every connection for every calendar month it exists in, whether
 * or not anybody is paying us for it. An account whose trial ran out, or whose
 * subscription stopped, is view-only -- nothing new can be added -- but its
 * connections would go on costing a fee a month, indefinitely, for a person
 * who has left. This closes them.
 *
 * Closed, not deleted. The connection is removed at Plaid, which ends the fee
 * and kills the token, and the row is stamped `closed_at`. The accounts and
 * transactions under it stay, so somebody who comes back still has their
 * history; connecting the same bank again replaces the closed connection (see
 * /exchange in plaid-routes). Only the person themselves deletes data, by
 * disconnecting a bank or deleting their account.
 *
 * Runs once a day from the cron trigger in wrangler.jsonc. Waits
 * LAPSE_GRACE_DAYS after access ends, so a subscriber a few days late does not
 * come back to a Banks page asking them to connect everything again.
 */

import { and, eq, isNull, lt, or, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { items, users } from "./db/schema";
import { openToken } from "./crypto";
import { removeItem, PlaidError } from "./plaid";
import { LAPSE_GRACE_DAYS } from "./entitlement";
import { isDemoItem } from "./plaid-routes";

/* A ceiling per run, so one day with a large cohort ending cannot run the
   invocation out of subrequests. Anything left is picked up tomorrow. */
const MAX_PER_RUN = 200;

/* Plaid answers these when there is nothing left to remove. The connection is
   gone either way, which is the outcome this job wants. */
const ALREADY_GONE = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

export async function closeLapsedConnections(env: Env, now: Date = new Date()):
  Promise<{ closed: number; failed: number }> {
  const cutoff = new Date(now.getTime() - LAPSE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const { db, ready, close } = getDb(env);
  let closed = 0, failed = 0;
  try {
    await ready;

    /* Who has lost access, and lost it long enough ago. A trial that has not
       started has no end date and no connections; `free` and `active` never
       match. planUntil for a lapsed account is the moment it stopped. */
    const gone = await db.select({ id: users.id }).from(users).where(or(
      and(eq(users.plan, "trial"), lt(users.planUntil, cutoff)),
      and(eq(users.plan, "lapsed"), lt(users.planUntil, cutoff)),
    ));
    if (!gone.length) return { closed, failed };

    const open = await db.select().from(items).where(and(
      inArray(items.userId, gone.map((u) => u.id)),
      isNull(items.closedAt),
    )).limit(MAX_PER_RUN);

    for (const item of open) {
      if (isDemoItem(item.plaidItemId)) continue;
      try {
        await removeItem(env, await openToken(env, item.accessTokenCiphertext, item.accessTokenIv));
      } catch (err) {
        if (!(err instanceof PlaidError && ALREADY_GONE.has(err.errorCode ?? ""))) {
          failed++;
          console.error(`lapse: could not close item ${item.id}:`, err instanceof Error ? err.message : err);
          continue;   // left open; tried again tomorrow
        }
      }
      await db.update(items).set({ closedAt: now }).where(eq(items.id, item.id));
      closed++;
    }

    console.log(`lapse: closed ${closed} connection(s), ${failed} failed, ${gone.length} account(s) past access`);
    return { closed, failed };
  } finally {
    await close().catch(() => {});
  }
}

/**
 * /api/plaid/* — linking a bank, and pulling what it knows.
 *
 * Every route here is authenticated and scoped to the caller's own user row.
 * Nothing accepts an item_id or account_id from the client: ownership is
 * always derived from the session, never asserted by the request.
 */

import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { accounts, items, transactions } from "./db/schema";
import { requireUser } from "./auth";
import { openToken, sealToken } from "./crypto";
import {
  removeItem,
  PlaidError,
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  getInstitution,
  syncTransactions,
  type PlaidTransaction,
} from "./plaid";

/** Money is stored as integer minor units. Never floats — see README. */
const toCents = (n: number | null | undefined): bigint | null =>
  n === null || n === undefined ? null : BigInt(Math.round(n * 100));

const plaid = new Hono<{ Bindings: Env }>();

/** Turns a PlaidError into a response without leaking our credentials. */
export function plaidFailure(err: unknown) {
  if (err instanceof PlaidError) {
    console.error(`Plaid ${err.errorType ?? "error"} ${err.errorCode ?? ""}: ${err.message} (request_id ${err.requestId ?? "?"})`);
    return {
      error: "plaid_error",
      code: err.errorCode ?? null,
      message: err.message,
    };
  }
  console.error("Plaid call failed:", err instanceof Error ? err.message : err);
  return { error: "plaid_error", code: null, message: "Could not reach Plaid." };
}

/* ---------------------------------------------------------------- link token */

plaid.post("/link-token", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const { link_token, expiration } = await createLinkToken(c.env, auth.user.clerkUserId);
    return c.json({ linkToken: link_token, expiration });
  } catch (err) {
    return c.json(plaidFailure(err), 502);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------ exchange */

plaid.post("/exchange", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let publicToken: unknown;
    try {
      ({ publicToken } = await c.req.json());
    } catch {
      return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
    }
    if (typeof publicToken !== "string" || !publicToken) {
      return c.json({ error: "bad_request", reason: "publicToken is required" }, 400);
    }

    const exchanged = await exchangePublicToken(c.env, publicToken);
    const accountsRes = await getAccounts(c.env, exchanged.access_token);

    let institutionName: string | null = null;
    const institutionId = accountsRes.item.institution_id;
    if (institutionId) {
      try {
        institutionName = (await getInstitution(c.env, institutionId)).institution.name;
      } catch {
        // Cosmetic only — never fail a link because the name lookup did.
      }
    }

    const sealed = await sealToken(c.env, exchanged.access_token);

    const [item] = await db
      .insert(items)
      .values({
        userId: auth.user.id,
        plaidItemId: exchanged.item_id,
        institutionId,
        institutionName,
        accessTokenCiphertext: sealed.ciphertext,
        accessTokenIv: sealed.iv,
        keyVersion: sealed.keyVersion,
      })
      // Relinking the same institution replaces the token rather than duplicating
      // the item — and re-encrypts, since the IV must never be reused.
      .onConflictDoUpdate({
        target: items.plaidItemId,
        set: {
          accessTokenCiphertext: sealed.ciphertext,
          accessTokenIv: sealed.iv,
          keyVersion: sealed.keyVersion,
          institutionName,
          status: "good",
        },
      })
      .returning();

    await upsertAccounts(db, item.id, accountsRes.accounts);

    return c.json({
      ok: true,
      item: { id: item.id, institution: institutionName, accounts: accountsRes.accounts.length },
    });
  } catch (err) {
    return c.json(plaidFailure(err), 502);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

async function upsertAccounts(
  db: ReturnType<typeof getDb>["db"],
  itemId: string,
  list: Awaited<ReturnType<typeof getAccounts>>["accounts"],
) {
  if (!list.length) return;
  const now = new Date();
  for (const a of list) {
    await db
      .insert(accounts)
      .values({
        itemId,
        plaidAccountId: a.account_id,
        name: a.name,
        officialName: a.official_name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        currentBalance: toCents(a.balances.current),
        availableBalance: toCents(a.balances.available),
        limitAmount: toCents(a.balances.limit),
        isoCurrencyCode: a.balances.iso_currency_code ?? "USD",
        balanceAsOf: now,
      })
      .onConflictDoUpdate({
        target: accounts.plaidAccountId,
        set: {
          name: a.name,
          officialName: a.official_name,
          currentBalance: toCents(a.balances.current),
          availableBalance: toCents(a.balances.available),
          limitAmount: toCents(a.balances.limit),
          balanceAsOf: now,
        },
      });
  }
}

/* ---------------------------------------------------------------------- sync */

plaid.post("/sync", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Only this user's items. The client never names which.
    const mine = await db.select().from(items).where(eq(items.userId, auth.user.id));
    if (!mine.length) return c.json({ ok: true, items: 0, added: 0, modified: 0, removed: 0 });

    let added = 0, modified = 0, removed = 0;
    let more = false;
    const pending: string[] = [];
    const failed: { bank: string; message: string }[] = [];

    for (const item of mine) {
      // Budget per item, not shared. Shared, the first bank could spend the
      // whole allowance on every call and the second would never be reached —
      // which is exactly what happened: two connections sat at "never synced"
      // through repeated syncs while the first one re-read pages it already had.
      let written = 0;
      try {
      const accessToken = await openToken(c.env, item.accessTokenCiphertext, item.accessTokenIv);

      // Map Plaid's account ids onto ours once per item, not per transaction.
      const owned = await db.select().from(accounts).where(eq(accounts.itemId, item.id));
      const byPlaidId = new Map(owned.map((a) => [a.plaidAccountId, a.id]));

      let cursor = item.transactionsCursor;
      let hasMore = true;
      let notReady = false;

      while (hasMore) {
        let page;
        try {
          page = await syncWithRetry(c.env, accessToken, cursor);
        } catch (err) {
          // Plaid has accepted the item but has not finished pulling history
          // from the institution yet. That is a wait, not a failure — say so
          // rather than throwing a 502 at somebody who did nothing wrong.
          if (err instanceof PlaidError && err.errorCode === "PRODUCT_NOT_READY") {
            pending.push(item.institutionName ?? "your bank");
            notReady = true;
            break;
          }
          throw err;
        }

        added += await writeTransactions(db, byPlaidId, page.added);
        modified += await writeTransactions(db, byPlaidId, page.modified);

        if (page.removed.length) {
          const ids = page.removed.map((r) => r.transaction_id);
          const gone = await db
            .delete(transactions)
            .where(
              and(
                inArray(transactions.plaidTransactionId, ids),
                inArray(transactions.accountId, [...byPlaidId.values()]),
              ),
            )
            .returning({ id: transactions.id });
          removed += gone.length;
        }

        cursor = page.next_cursor;
        hasMore = page.has_more;

        // Saved per page, as soon as that page's rows are durably written.
        //
        // This used to happen once, after every page of an item had been read.
        // That sounds safer and is the opposite: two years of history did not
        // fit in one request, so the run died having written everything and
        // recorded nothing, and every retry began again from an empty cursor
        // and died in the same place. A sync cursor is a position in an ordered
        // stream — saving it after the page it belongs to is exactly correct,
        // and it makes a long backfill resumable instead of all-or-nothing.
        await db
          .update(items)
          .set({ transactionsCursor: cursor, lastSyncedAt: new Date(), status: "good" })
          .where(eq(items.id, item.id));

        written += page.added.length + page.modified.length;
        // Enough from this item for one request. The rest is still there, the
        // cursor knows where, and the caller is told to come back.
        if (written >= SYNC_ROW_BUDGET) { more = true; break; }
      }

      // Nothing was fetched, so there is no progress to record — leaving
      // lastSyncedAt unset keeps "never synced" honest.
      if (notReady) continue;
      if (hasMore) more = true;

      } catch (err) {
        // One bank failing must not abort the others. Previously any error
        // threw out of the whole route, so a single unhealthy connection
        // stopped every other connection from ever syncing — and the failure
        // looked like a general outage rather than one bank needing attention.
        const detail = err instanceof PlaidError
          ? `${err.errorCode ?? err.errorType ?? "error"}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        console.error(`sync failed for item ${item.id} (${item.institutionName}):`, detail);
        failed.push({ bank: item.institutionName ?? "A bank", message: detail });
      }
    }

    return c.json({
      ok: true,
      items: mine.length,
      added,
      modified,
      removed,
      // True when history remains and the client should call again. A backfill
      // of two years arrives over several requests rather than one long one.
      more,
      // Non-empty when Plaid is still preparing history for those institutions.
      pending,
      // Banks that errored. Reported rather than thrown, so the ones that
      // worked still count and the user is told which needs attention.
      failed,
    });
  } catch (err) {
    return c.json(plaidFailure(err), 502);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * How many rows one /sync request will write before handing back.
 *
 * A Worker has a request budget, and a two-year backfill can exceed it. Rather
 * than race that limit, the run stops at a sensible size, saves where it got
 * to, and reports that there is more — the client calls again until there is
 * not. Slower to finish, but it always finishes.
 */
const SYNC_ROW_BUDGET = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * /transactions/sync is not ready the instant an item is created — Plaid still
 * has to pull history from the institution, and answers PRODUCT_NOT_READY until
 * it has. A few seconds usually covers it, so a short retry turns "link, then
 * fail, then click again" into "link, then it works".
 *
 * The real answer for production is Plaid's SYNC_UPDATES_AVAILABLE webhook, so
 * Plaid tells us when data is ready instead of us guessing. This keeps the
 * common case working until that exists.
 */
async function syncWithRetry(env: Env, accessToken: string, cursor: string | null) {
  const waits = [1500, 3000, 5000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncTransactions(env, accessToken, cursor);
    } catch (err) {
      const retryable = err instanceof PlaidError && err.errorCode === "PRODUCT_NOT_READY";
      if (!retryable || attempt >= waits.length) throw err;
      await sleep(waits[attempt]);
    }
  }
}

/**
 * How many rows go into one INSERT.
 *
 * This used to be one statement per transaction. At ninety days of history that
 * was 286 round trips and it fit; at two years it was 637 and the request died
 * partway, having written every row but never reaching the line that saves the
 * cursor — so the next attempt started from the beginning and died in the same
 * place. A backfill that cannot finish is worse than one that is slow.
 */
const WRITE_BATCH = 200;

/** Plaid owns these columns, so a resync overwrites them wholesale. */
const OVERWRITE_ON_CONFLICT = {
  accountId: sql`excluded.account_id`,
  amount: sql`excluded.amount`,
  isoCurrencyCode: sql`excluded.iso_currency_code`,
  date: sql`excluded.date`,
  authorizedDate: sql`excluded.authorized_date`,
  name: sql`excluded.name`,
  merchantName: sql`excluded.merchant_name`,
  merchantEntityId: sql`excluded.merchant_entity_id`,
  pending: sql`excluded.pending`,
  pendingTransactionId: sql`excluded.pending_transaction_id`,
  paymentChannel: sql`excluded.payment_channel`,
  categoryPrimary: sql`excluded.category_primary`,
  categoryDetailed: sql`excluded.category_detailed`,
  raw: sql`excluded.raw`,
  syncedAt: sql`excluded.synced_at`,
};

async function writeTransactions(
  db: ReturnType<typeof getDb>["db"],
  byPlaidId: Map<string, string>,
  list: PlaidTransaction[],
): Promise<number> {
  const now = new Date();
  const rows = [];
  for (const t of list) {
    const accountId = byPlaidId.get(t.account_id);
    if (!accountId) continue; // an account we do not hold; skip rather than orphan

    rows.push({
      accountId,
      plaidTransactionId: t.transaction_id,
      amount: BigInt(Math.round(t.amount * 100)),
      isoCurrencyCode: t.iso_currency_code ?? "USD",
      date: t.date,
      authorizedDate: t.authorized_date,
      name: t.name,
      merchantName: t.merchant_name,
      merchantEntityId: t.merchant_entity_id,
      pending: t.pending,
      pendingTransactionId: t.pending_transaction_id,
      paymentChannel: t.payment_channel,
      categoryPrimary: t.personal_finance_category?.primary ?? null,
      categoryDetailed: t.personal_finance_category?.detailed ?? null,
      raw: t,
      syncedAt: now,
    });
  }
  if (!rows.length) return 0;

  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const chunk = rows.slice(i, i + WRITE_BATCH);
    try {
      await db
        .insert(transactions)
        .values(chunk)
        // User edits live in transaction_overrides precisely so this cannot
        // erase them.
        .onConflictDoUpdate({
          target: transactions.plaidTransactionId,
          set: OVERWRITE_ON_CONFLICT,
        });
    } catch (e) {
      console.error(`batch of ${chunk.length} transactions failed to write:`, e);
      throw e;
    }
  }
  return rows.length;
}

/* --------------------------------------------------------------------- items */

/** What the front end needs to show "you have linked these banks". */
plaid.get("/items", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const mine = await db.select().from(items).where(eq(items.userId, auth.user.id));
    const out = [];
    for (const item of mine) {
      const owned = await db.select().from(accounts).where(eq(accounts.itemId, item.id));
      out.push({
        id: item.id,
        institution: item.institutionName,
        status: item.status,
        lastSyncedAt: item.lastSyncedAt,
        // A linked-but-never-synced item should not look identical to one
        // holding a year of history.
        awaitingFirstSync: item.lastSyncedAt === null,
        accounts: owned.map((a) => ({
          id: a.id,
          name: a.name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          // cents out as a number; the front end formats it
          currentBalance: a.currentBalance === null ? null : Number(a.currentBalance),
        })),
      });
    }
    return c.json({ ok: true, items: out });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Disconnects a bank: revoked at Plaid, then erased here.
 *
 * Order matters. Plaid first, because if we deleted our row and then failed to
 * reach Plaid we would have thrown away the only copy of the token that can
 * revoke the connection — leaving it live forever with no way to reach it. If
 * Plaid refuses, nothing is deleted and the caller can try again.
 *
 * Everything under the item goes with it by cascade: accounts, their
 * transactions, and any category overrides on those transactions. Categories
 * and merchant rules survive, because they are yours rather than the bank's,
 * and they will be waiting if you reconnect.
 */
plaid.delete("/items/:id", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Scoped by user as well as id, so an id belonging to someone else reads as
    // "no such item" rather than as a permission error worth probing.
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, c.req.param("id")), eq(items.userId, auth.user.id)))
      .limit(1);
    if (!item) return c.json({ error: "not_found" }, 404);

    try {
      await removeItem(c.env, await openToken(c.env, item.accessTokenCiphertext, item.accessTokenIv));
    } catch (err) {
      return c.json(plaidFailure(err), 502);
    }

    await db.delete(items).where(eq(items.id, item.id));
    return c.json({ ok: true, removed: item.institutionName ?? "That bank" });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default plaid;

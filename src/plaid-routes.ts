/**
 * /api/plaid/* — linking a bank, and pulling what it knows.
 *
 * Every route here is authenticated and scoped to the caller's own user row.
 * Nothing accepts an item_id or account_id from the client: ownership is
 * always derived from the session, never asserted by the request.
 */

import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { accounts, items, transactions } from "./db/schema";
import { requireUser } from "./auth";
import { openToken, sealToken } from "./crypto";
import {
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
function plaidFailure(err: unknown) {
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
    const pending: string[] = [];

    for (const item of mine) {
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
      }

      // Nothing was fetched, so there is no progress to record — leaving
      // lastSyncedAt unset keeps "never synced" honest.
      if (notReady) continue;

      // Store the cursor only after the whole item succeeded, so a mid-sync
      // failure resumes from the last good point rather than skipping a page.
      await db
        .update(items)
        .set({ transactionsCursor: cursor, lastSyncedAt: new Date(), status: "good" })
        .where(eq(items.id, item.id));
    }

    return c.json({
      ok: true,
      items: mine.length,
      added,
      modified,
      removed,
      // Non-empty when Plaid is still preparing history for those institutions.
      pending,
    });
  } catch (err) {
    return c.json(plaidFailure(err), 502);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

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

async function writeTransactions(
  db: ReturnType<typeof getDb>["db"],
  byPlaidId: Map<string, string>,
  list: PlaidTransaction[],
): Promise<number> {
  let n = 0;
  for (const t of list) {
    const accountId = byPlaidId.get(t.account_id);
    if (!accountId) continue; // an account we do not hold; skip rather than orphan

    const values = {
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
      syncedAt: new Date(),
    };

    await db
      .insert(transactions)
      .values(values)
      // Plaid owns these rows; a resync overwrites them. User edits live in
      // transaction_overrides precisely so this cannot erase them.
      .onConflictDoUpdate({ target: transactions.plaidTransactionId, set: values })
      .catch((e) => {
        console.error(`transaction ${t.transaction_id} failed to write:`, e);
        throw e;
      });
    n++;
  }
  return n;
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

export default plaid;

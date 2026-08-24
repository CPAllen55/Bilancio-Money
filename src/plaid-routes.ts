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
  updateItemWebhook,
  verifyWebhook,
  removeItem,
  PlaidError,
  createLinkToken,
  createUpdateLinkToken,
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

/**
 * POST /api/plaid/link-token/update — repair an existing connection.
 *
 * Without this a bank that asks for a fresh login is unrecoverable: the sync
 * fails forever, and the only control on the page is Disconnect, which throws
 * away the Item and every transaction under it to fix a expired password.
 *
 * No separate "it worked" call is needed afterwards. A successful sync already
 * sets the Item back to good, so repairing it and syncing is the whole repair.
 */
plaid.post("/link-token/update", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let itemId: unknown;
    try { ({ itemId } = await c.req.json()); }
    catch { return c.json({ error: "bad_request", reason: "body must be JSON" }, 400); }
    if (typeof itemId !== "string" || !itemId) {
      return c.json({ error: "bad_request", reason: "itemId is required" }, 400);
    }

    // Joined on the user, so an id from somewhere else matches nothing rather
    // than handing back a link token onto a stranger's bank.
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.userId, auth.user.id)));
    if (!item) return c.json({ error: "not_found" }, 404);

    try {
      const token = await openToken(c.env, item.accessTokenCiphertext, item.accessTokenIv);
      const { link_token, expiration } = await createUpdateLinkToken(
        c.env, auth.user.clerkUserId, token,
      );
      return c.json({ linkToken: link_token, expiration, institution: item.institutionName });
    } catch (err) {
      return c.json(plaidFailure(err), 502);
    }
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

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

/**
 * How many rows one /sync request will write per item before handing back.
 *
 * A Worker has a request budget, and a two-year backfill can exceed it. Rather
 * than race that limit, the run stops at a sensible size, saves where it got
 * to, and reports that there is more — the caller comes back until there is
 * not. Slower to finish, but it always finishes.
 *
 * Per item, deliberately. Shared, the first bank could spend the whole
 * allowance on every call and the second would never be reached.
 */
// Lowered from 600 after a two-item sync still hit the request limit: each
// row carries the whole Plaid payload in a jsonb column, so a "row" is far
// heavier than the count suggests. Smaller rounds, more of them — the client
// loops until done and the cursor makes every round durable.
const SYNC_ROW_BUDGET = 250;

interface ItemSyncResult {
  added: number;
  modified: number;
  removed: number;
  /** History remains; call again. */
  more: boolean;
  /** Plaid is still preparing this item's history. */
  notReady: boolean;
}

/**
 * Pulls one item forward from its cursor.
 *
 * Shared by the sync button and the webhook, so "fetch what is new" means the
 * same thing however it was triggered.
 */
async function syncOneItem(
  env: Env,
  db: ReturnType<typeof getDb>["db"],
  item: typeof items.$inferSelect,
): Promise<ItemSyncResult> {
  const out: ItemSyncResult = { added: 0, modified: 0, removed: 0, more: false, notReady: false };
  const accessToken = await openToken(env, item.accessTokenCiphertext, item.accessTokenIv);

  // Register the webhook if Plaid does not already have this URL for the item.
  // New items carry it from the link token; ones linked before webhooks existed
  // would otherwise never send anything, and would still be waiting on a button.
  if (env.PLAID_WEBHOOK_URL && item.webhookUrl !== env.PLAID_WEBHOOK_URL) {
    try {
      await updateItemWebhook(env, accessToken, env.PLAID_WEBHOOK_URL);
      await db.update(items).set({ webhookUrl: env.PLAID_WEBHOOK_URL }).where(eq(items.id, item.id));
    } catch (err) {
      // Not fatal: syncing still works by hand. Logged so it is visible.
      console.error(`could not register webhook for item ${item.id}:`, err);
    }
  }

  // Map Plaid's account ids onto ours once per item, not per transaction.
  const owned = await db.select().from(accounts).where(eq(accounts.itemId, item.id));
  const byPlaidId = new Map(owned.map((a) => [a.plaidAccountId, a.id]));

  let cursor = item.transactionsCursor;
  let hasMore = true;
  let written = 0;

  while (hasMore) {
    let page;
    try {
      page = await syncWithRetry(env, accessToken, cursor);
    } catch (err) {
      // Plaid has accepted the item but has not finished pulling history from
      // the institution yet. That is a wait, not a failure.
      if (err instanceof PlaidError && err.errorCode === "PRODUCT_NOT_READY") {
        out.notReady = true;
        return out;
      }
      throw err;
    }

    out.added += await writeTransactions(db, byPlaidId, page.added);
    out.modified += await writeTransactions(db, byPlaidId, page.modified);

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
      out.removed += gone.length;
    }

    cursor = page.next_cursor;
    hasMore = page.has_more;

    // Saved per page, as soon as that page's rows are durably written. A sync
    // cursor is a position in an ordered stream, so recording it after the page
    // it belongs to is exactly right — and it makes a long backfill resumable
    // rather than all-or-nothing.
    await db
      .update(items)
      .set({ transactionsCursor: cursor, lastSyncedAt: new Date(), status: "good" })
      .where(eq(items.id, item.id));

    written += page.added.length + page.modified.length;
    if (written >= SYNC_ROW_BUDGET) { out.more = true; return out; }
  }

  return out;
}

plaid.post("/sync", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Only this user's items. The client never names which.
    const mine = await db.select().from(items).where(eq(items.userId, auth.user.id));
    if (!mine.length) return c.json({ ok: true, items: 0, added: 0, modified: 0, removed: 0 });

    let added = 0, modified = 0, removed = 0, more = false;
    const pending: string[] = [];
    const failed: { bank: string; message: string }[] = [];

    for (const item of mine) {
      try {
        const r = await syncOneItem(c.env, db, item);
        added += r.added; modified += r.modified; removed += r.removed;
        if (r.more) more = true;
        if (r.notReady) pending.push(item.institutionName ?? "your bank");
      } catch (err) {
        // One bank failing must not abort the others. Thrown, a single
        // unhealthy connection stopped every other one from ever syncing and
        // reported itself as a general outage.
        const detail = err instanceof PlaidError
          ? `${err.errorCode ?? err.errorType ?? "error"}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        console.error(`sync failed for item ${item.id} (${item.institutionName}):`, detail);
        failed.push({ bank: item.institutionName ?? "A bank", message: detail });
      }
    }

    return c.json({ ok: true, items: mine.length, added, modified, removed, more, pending, failed });
  } catch (err) {
    return c.json(plaidFailure(err), 502);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------ webhook */

/**
 * POST /api/plaid/webhook — Plaid telling us an item has news.
 *
 * The one that matters is SYNC_UPDATES_AVAILABLE: Plaid finished pulling more
 * history and there is something to fetch. Without it, the only way to discover
 * that a backfill had completed was to press the button and see, which is why
 * four months could sit empty with the item reporting itself fully synced.
 *
 * Unauthenticated by necessity — Plaid has no session — so the signature is the
 * only thing standing between this and anyone who guesses the URL. It is
 * checked before the body is looked at.
 *
 * Returns 200 immediately and syncs in the background. Plaid retries on a slow
 * or failed response, and a backfill takes far longer than it will wait.
 */
plaid.post("/webhook", async (c) => {
  const raw = await c.req.text();

  if (!(await verifyWebhook(c.env, c.req.header("Plaid-Verification"), raw))) {
    console.error("rejected a webhook that did not verify");
    return c.json({ error: "bad_signature" }, 401);
  }

  let body: { webhook_type?: string; webhook_code?: string; item_id?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }

  const { webhook_type: type, webhook_code: code, item_id: plaidItemId } = body;
  if (!plaidItemId) return c.json({ ok: true, ignored: "no item_id" });

  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const [item] = await db
      .select().from(items).where(eq(items.plaidItemId, plaidItemId)).limit(1);
    // An item we do not hold — most likely one that was disconnected while a
    // webhook was in flight. Acknowledged so Plaid stops retrying it.
    if (!item) return c.json({ ok: true, ignored: "unknown item" });

    if (type === "TRANSACTIONS") {
      // SYNC_UPDATES_AVAILABLE is the modern one; the *_UPDATE codes are the
      // legacy family and mean the same thing here — go and read the cursor.
      const wantsSync = code === "SYNC_UPDATES_AVAILABLE" ||
        code === "INITIAL_UPDATE" || code === "HISTORICAL_UPDATE" ||
        code === "DEFAULT_UPDATE" || code === "TRANSACTIONS_REMOVED";

      if (wantsSync) {
        // Drained in the background across as many rounds as it takes, so a
        // completed backfill lands without anybody pressing anything.
        c.executionCtx.waitUntil((async () => {
          try {
            let round = 0;
            let current = item;
            for (;;) {
              const r = await syncOneItem(c.env, db, current);
              console.log(`webhook sync ${code} item ${item.id}: +${r.added} ~${r.modified} -${r.removed}`);
              if (!r.more || ++round >= 40) break;
              const [fresh] = await db
                .select().from(items).where(eq(items.id, item.id)).limit(1);
              if (!fresh) break;   // disconnected mid-backfill
              current = fresh;     // pick up the cursor the last round saved
            }
          } catch (err) {
            console.error(`webhook sync failed for item ${item.id}:`, err);
          }
        })());
      }
    }

    if (type === "ITEM") {
      // The item needs the user to re-authenticate, or has been revoked. Recorded
      // so the Banks tab can say so instead of showing a connection that quietly
      // stopped returning anything.
      const status =
        code === "ERROR" || code === "USER_PERMISSION_REVOKED" ? "login_required"
        : code === "PENDING_EXPIRATION" ? "pending_expiration"
        : null;
      if (status) {
        await db.update(items).set({ status }).where(eq(items.id, item.id));
        console.log(`item ${item.id} marked ${status} by webhook ${code}`);
      }
    }

    return c.json({ ok: true });
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

/**
 * How many rows go into one INSERT.
 *
 * This used to be one statement per transaction. At ninety days of history that
 * was 286 round trips and it fit; at two years it was 637 and the request died
 * partway, having written every row but never reaching the line that saves the
 * cursor — so the next attempt started from the beginning and died in the same
 * place. A backfill that cannot finish is worse than one that is slow.
 */
const WRITE_BATCH = 100;

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

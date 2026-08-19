/**
 * /api/summary and /api/transactions — the numbers the dashboard actually draws.
 *
 * These deliberately mirror the shapes the demo computes in the browser, so
 * porting a view is a matter of changing where the data comes from rather than
 * rewriting the chart.
 *
 * SIGN CONVENTION — the one thing to get right here.
 * Plaid, and therefore our `transactions.amount` column, uses POSITIVE for
 * money leaving the account. The dashboard uses the opposite. Everything below
 * is normalised once, at the boundary, into:
 *     income  — positive, money in
 *     expense — positive, money out
 * so no consumer has to remember which way round Plaid was.
 */

import { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { accounts, items, transactionOverrides, transactions } from "./db/schema";
import { requireUser } from "./auth";
import { CATEGORIES, CATEGORY_IDS, classify, type CategoryId } from "./categories";

const summary = new Hono<{ Bindings: Env }>();

/** Accounts you spend from. A mortgage balance is not a wallet. */
const SPENDING_ACCOUNT_TYPES = ["depository", "credit"];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

interface Window {
  start: Date;
  end: Date;
  label: string;
}

/**
 * Resolves a range name into dates, plus the comparable window before it.
 * "Comparable" matters: comparing a half-finished month against a whole one
 * makes every number look like a collapse, so the previous window is truncated
 * to the same number of days.
 */
function resolveRange(range: string, today: Date): { current: Window; previous: Window; daysElapsed: number; daysInPeriod: number } {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();

  if (range === "last-month") {
    const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 0));
    const pStart = new Date(Date.UTC(y, m - 2, 1)), pEnd = new Date(Date.UTC(y, m - 1, 0));
    const days = end.getUTCDate();
    return {
      current: { start, end, label: "Last month" },
      previous: { start: pStart, end: pEnd, label: "The month before" },
      daysElapsed: days, daysInPeriod: days,
    };
  }

  if (range === "last-3" || range === "last-6") {
    const months = range === "last-3" ? 3 : 6;
    const start = new Date(Date.UTC(y, m - months + 1, 1));
    const end = new Date(Date.UTC(y, m, d));
    const pStart = new Date(Date.UTC(y, m - months * 2 + 1, 1));
    const pEnd = new Date(Date.UTC(y, m - months + 1, 0));
    return {
      current: { start, end, label: `Last ${months} months` },
      previous: { start: pStart, end: pEnd, label: `The ${months} months before` },
      daysElapsed: months * 30, daysInPeriod: months * 30,
    };
  }

  if (range === "ytd") {
    const start = new Date(Date.UTC(y, 0, 1)), end = new Date(Date.UTC(y, m, d));
    const pStart = new Date(Date.UTC(y - 1, 0, 1)), pEnd = new Date(Date.UTC(y - 1, m, d));
    return {
      current: { start, end, label: "Year to date" },
      previous: { start: pStart, end: pEnd, label: "Same period last year" },
      daysElapsed: Math.round((end.getTime() - start.getTime()) / 86400000) + 1,
      daysInPeriod: 365,
    };
  }

  // Default: this month, compared against the same days of last month.
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m, d));
  const pStart = new Date(Date.UTC(y, m - 1, 1));
  const pEnd = new Date(Date.UTC(y, m - 1, Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate())));
  return {
    current: { start, end, label: "This month" },
    previous: { start: pStart, end: pEnd, label: "Same days last month" },
    daysElapsed: d,
    daysInPeriod: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}

interface Totals {
  income: number;
  expense: number;
  net: number;
  byCategory: Record<string, number>;
  transfersExcluded: number;
}

function emptyTotals(): Totals {
  return {
    income: 0, expense: 0, net: 0,
    byCategory: Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0])),
    transfersExcluded: 0,
  };
}

interface Row {
  amount: bigint;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  overrideCategory: string | null;
}

function tally(rows: Row[]): Totals {
  const out = emptyTotals();
  for (const r of rows) {
    // Flip Plaid's sign: negative means money came in.
    const signed = -Number(r.amount);
    const { kind, category } = classify(r.categoryPrimary, r.categoryDetailed);

    if (kind === "transfer") { out.transfersExcluded++; continue; }

    if (signed > 0) { out.income += signed; continue; }

    const spent = -signed;
    out.expense += spent;
    // A user override beats whatever Plaid said.
    const bucket = (r.overrideCategory ?? category) as CategoryId | null;
    if (bucket && bucket in out.byCategory) out.byCategory[bucket] += spent;
  }
  out.net = out.income - out.expense;
  return out;
}

/** Every account id this user owns, optionally narrowed to one. */
async function ownedAccountIds(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
  only: string | null,
  spendingOnly: boolean,
): Promise<string[]> {
  const rows = await db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .innerJoin(items, eq(accounts.itemId, items.id))
    .where(eq(items.userId, userId));

  return rows
    .filter((r) => (spendingOnly ? SPENDING_ACCOUNT_TYPES.includes(r.type) : true))
    // `only` is checked against rows we already proved are the user's, so a
    // guessed id cannot reach another user's data — it just matches nothing.
    .filter((r) => (only && only !== "all" ? r.id === only : true))
    .map((r) => r.id);
}

async function rowsIn(
  db: ReturnType<typeof getDb>["db"],
  accountIds: string[],
  userId: string,
  w: Window,
): Promise<Row[]> {
  if (!accountIds.length) return [];
  return db
    .select({
      amount: transactions.amount,
      categoryPrimary: transactions.categoryPrimary,
      categoryDetailed: transactions.categoryDetailed,
      overrideCategory: sql<string | null>`${transactionOverrides.categoryId}::text`,
    })
    .from(transactions)
    .leftJoin(
      transactionOverrides,
      and(
        eq(transactionOverrides.transactionId, transactions.id),
        eq(transactionOverrides.userId, userId),
      ),
    )
    .where(
      and(
        inArray(transactions.accountId, accountIds),
        gte(transactions.date, ymd(w.start)),
        lte(transactions.date, ymd(w.end)),
        eq(transactions.pending, false),
      ),
    );
}

/* -------------------------------------------------------------------- summary */

summary.get("/summary", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const range = c.req.query("range") ?? "this-month";
    const account = c.req.query("account") ?? "all";
    const { current, previous, daysElapsed, daysInPeriod } = resolveRange(range, new Date());

    const ids = await ownedAccountIds(db, auth.user.id, account, true);
    const [nowRows, prevRows] = await Promise.all([
      rowsIn(db, ids, auth.user.id, current),
      rowsIn(db, ids, auth.user.id, previous),
    ]);

    const now = tally(nowRows);
    const before = tally(prevRows);

    // Safe to spend: what is left of what came in, and whether the burn rate is
    // ahead of the calendar. Only meaningful for a month-shaped window.
    const daysLeft = Math.max(0, daysInPeriod - daysElapsed);
    const remaining = Math.max(0, now.income - now.expense);
    const paceTarget = now.income * (daysElapsed / daysInPeriod);

    return c.json({
      ok: true,
      range: { key: range, label: current.label, start: ymd(current.start), end: ymd(current.end) },
      comparison: { label: previous.label, start: ymd(previous.start), end: ymd(previous.end) },
      totals: now,
      previous: before,
      safeToSpend: {
        remaining,
        perDay: daysLeft > 0 ? Math.round(remaining / daysLeft) : remaining,
        daysLeft,
        daysElapsed,
        daysInPeriod,
        spent: now.expense,
        budget: now.income,
        onPace: now.expense <= paceTarget,
      },
      categories: CATEGORIES,
      accountsCounted: ids.length,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* --------------------------------------------------------------- transactions */

summary.get("/transactions", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const range = c.req.query("range") ?? "this-month";
    const account = c.req.query("account") ?? "all";
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    const { current } = resolveRange(range, new Date());

    const ids = await ownedAccountIds(db, auth.user.id, account, false);
    if (!ids.length) return c.json({ ok: true, transactions: [], total: 0 });

    const where = and(
      inArray(transactions.accountId, ids),
      gte(transactions.date, ymd(current.start)),
      lte(transactions.date, ymd(current.end)),
    );

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: transactions.id,
          date: transactions.date,
          name: transactions.name,
          merchantName: transactions.merchantName,
          amount: transactions.amount,
          pending: transactions.pending,
          accountId: transactions.accountId,
          categoryPrimary: transactions.categoryPrimary,
          categoryDetailed: transactions.categoryDetailed,
          overrideCategory: sql<string | null>`${transactionOverrides.categoryId}::text`,
        })
        .from(transactions)
        .leftJoin(
          transactionOverrides,
          and(
            eq(transactionOverrides.transactionId, transactions.id),
            eq(transactionOverrides.userId, auth.user.id),
          ),
        )
        .where(where)
        .orderBy(desc(transactions.date))
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(transactions).where(where),
    ]);

    return c.json({
      ok: true,
      total,
      transactions: rows.map((r) => {
        const { kind, category } = classify(r.categoryPrimary, r.categoryDetailed);
        return {
          id: r.id,
          date: r.date,
          name: r.merchantName ?? r.name,
          rawName: r.name,
          // normalised: positive is money in
          amount: -Number(r.amount),
          pending: r.pending,
          accountId: r.accountId,
          kind,
          category: r.overrideCategory ?? category,
          categorySource: r.overrideCategory ? "user" : "plaid",
        };
      }),
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default summary;

/**
 * /api/summary, /api/transactions and /api/trend — the numbers the dashboard
 * draws, shaped to match what the demo computes in the browser.
 *
 * SIGN CONVENTION — the one thing to get right here.
 * Plaid, and therefore `transactions.amount`, uses POSITIVE for money leaving
 * the account. The dashboard uses the opposite. Everything below is normalised
 * once, at the boundary, into income (positive, money in) and expense
 * (positive, money out), so no consumer has to remember which way Plaid went.
 *
 * CATEGORY RESOLUTION — override, then rule, then Plaid's guess. All three at
 * read time: Plaid owns the transaction rows and a resync overwrites them, so
 * nothing user-owned is ever written into one.
 */

import { Hono } from "hono";
import { and, desc, eq, gte, isNull, lte, or, inArray, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  accounts, categories, items, merchantRules, transactionOverrides, transactions,
} from "./db/schema";
import { requireUser } from "./auth";
import { classify, merchantKey } from "./categories";

const summary = new Hono<{ Bindings: Env }>();

/** Accounts you spend from. A mortgage balance is not a wallet. */
const SPENDING_ACCOUNT_TYPES = ["depository", "credit"];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------- category context -- */

export interface CategoryRow {
  id: string; slug: string; label: string; colour: string; sortOrder: number; isSystem: boolean;
}

export interface CategoryContext {
  list: CategoryRow[];
  slugById: Map<string, string>;
  /** normalised merchant key -> category slug */
  ruleBySlugKey: Map<string, string>;
}

/**
 * A user sees system categories plus their own. Loading both together means the
 * rest of the code never has to care which kind it is holding.
 */
export async function loadCategories(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<CategoryContext> {
  const rows = await db
    .select({
      id: categories.id, slug: categories.slug, label: categories.label,
      colour: categories.colour, sortOrder: categories.sortOrder, isSystem: categories.isSystem,
    })
    .from(categories)
    .where(
      and(
        or(isNull(categories.userId), eq(categories.userId, userId)),
        isNull(categories.archivedAt),
      ),
    )
    .orderBy(categories.sortOrder, categories.label);

  const slugById = new Map(rows.map((r) => [r.id, r.slug]));

  const rules = await db
    .select({ matchKey: merchantRules.matchKey, categoryId: merchantRules.categoryId })
    .from(merchantRules)
    .where(eq(merchantRules.userId, userId));

  const ruleBySlugKey = new Map<string, string>();
  for (const r of rules) {
    const slug = slugById.get(r.categoryId);
    if (slug) ruleBySlugKey.set(r.matchKey, slug);
  }

  return { list: rows, slugById, ruleBySlugKey };
}

interface Categorisable {
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  merchantName: string | null;
  name: string;
  overrideCategoryId: string | null;
}

/** Override beats rule beats Plaid. */
function resolveSlug(row: Categorisable, ctx: CategoryContext): { kind: string; slug: string | null } {
  const base = classify(row.categoryPrimary, row.categoryDetailed);

  // An override is an explicit statement about this one transaction, so it wins
  // even over "this merchant is always X" and even for transfers.
  if (row.overrideCategoryId) {
    const slug = ctx.slugById.get(row.overrideCategoryId);
    if (slug) return { kind: "spend", slug };
  }

  if (base.kind === "spend") {
    const ruled = ctx.ruleBySlugKey.get(merchantKey(row.merchantName, row.name));
    if (ruled) return { kind: "spend", slug: ruled };
  }

  return base;
}

/* ------------------------------------------------------------------ ranges -- */

interface Window { start: Date; end: Date; label: string; }

/**
 * Resolves a range name into dates, plus the comparable window before it.
 * "Comparable" matters: measuring a half-finished month against a whole one
 * makes every number look like a collapse.
 */
function resolveRange(range: string, today: Date) {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();

  if (range === "last-month") {
    const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 0));
    return {
      current: { start, end, label: "Last month" },
      previous: { start: new Date(Date.UTC(y, m - 2, 1)), end: new Date(Date.UTC(y, m - 1, 0)), label: "The month before" },
      daysElapsed: end.getUTCDate(), daysInPeriod: end.getUTCDate(),
    };
  }

  if (range === "last-3" || range === "last-6") {
    const months = range === "last-3" ? 3 : 6;
    return {
      current: { start: new Date(Date.UTC(y, m - months + 1, 1)), end: new Date(Date.UTC(y, m, d)), label: `Last ${months} months` },
      previous: { start: new Date(Date.UTC(y, m - months * 2 + 1, 1)), end: new Date(Date.UTC(y, m - months + 1, 0)), label: `The ${months} months before` },
      daysElapsed: months * 30, daysInPeriod: months * 30,
    };
  }

  if (range === "ytd") {
    return {
      current: { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y, m, d)), label: "Year to date" },
      previous: { start: new Date(Date.UTC(y - 1, 0, 1)), end: new Date(Date.UTC(y - 1, m, d)), label: "Same period last year" },
      daysElapsed: Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000) + 1,
      daysInPeriod: 365,
    };
  }

  const lastDayPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    current: { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m, d)), label: "This month" },
    previous: { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m - 1, Math.min(d, lastDayPrev))), label: "Same days last month" },
    daysElapsed: d,
    daysInPeriod: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}

/* ------------------------------------------------------------------ totals -- */

interface Totals {
  income: number; expense: number; net: number;
  byCategory: Record<string, number>;
  transfersExcluded: number;
}

const emptyTotals = (ctx: CategoryContext): Totals => ({
  income: 0, expense: 0, net: 0,
  byCategory: Object.fromEntries(ctx.list.map((c) => [c.slug, 0])),
  transfersExcluded: 0,
});

interface AmountRow extends Categorisable { amount: bigint; }

function tally(rows: AmountRow[], ctx: CategoryContext): Totals {
  const out = emptyTotals(ctx);
  for (const r of rows) {
    const signed = -Number(r.amount); // flip Plaid's sign: negative meant money in
    const { kind, slug } = resolveSlug(r, ctx);

    if (kind === "transfer") { out.transfersExcluded++; continue; }
    if (signed > 0) { out.income += signed; continue; }

    const spent = -signed;
    out.expense += spent;
    if (slug && slug in out.byCategory) out.byCategory[slug] += spent;
  }
  out.net = out.income - out.expense;
  return out;
}

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
    // `only` is matched against rows already proved to be this user's, so a
    // guessed id cannot reach anyone else's data — it simply matches nothing.
    .filter((r) => (only && only !== "all" ? r.id === only : true))
    .map((r) => r.id);
}

const rowFields = {
  amount: transactions.amount,
  categoryPrimary: transactions.categoryPrimary,
  categoryDetailed: transactions.categoryDetailed,
  merchantName: transactions.merchantName,
  name: transactions.name,
  overrideCategoryId: transactionOverrides.categoryId,
};

function withOverrides(db: ReturnType<typeof getDb>["db"], userId: string) {
  return db
    .select(rowFields)
    .from(transactions)
    .leftJoin(
      transactionOverrides,
      and(
        eq(transactionOverrides.transactionId, transactions.id),
        eq(transactionOverrides.userId, userId),
      ),
    );
}

/* ----------------------------------------------------------------- summary -- */

summary.get("/summary", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const range = c.req.query("range") ?? "this-month";
    const account = c.req.query("account") ?? "all";
    const { current, previous, daysElapsed, daysInPeriod } = resolveRange(range, new Date());

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, true),
    ]);

    const inWindow = (w: Window) =>
      ids.length
        ? withOverrides(db, auth.user.id).where(
            and(
              inArray(transactions.accountId, ids),
              gte(transactions.date, ymd(w.start)),
              lte(transactions.date, ymd(w.end)),
              eq(transactions.pending, false),
            ),
          )
        : Promise.resolve([] as AmountRow[]);

    const [nowRows, prevRows] = await Promise.all([inWindow(current), inWindow(previous)]);
    const now = tally(nowRows as AmountRow[], ctx);
    const before = tally(prevRows as AmountRow[], ctx);

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
        daysLeft, daysElapsed, daysInPeriod,
        spent: now.expense, budget: now.income,
        onPace: now.expense <= paceTarget,
      },
      categories: ctx.list,
      accountsCounted: ids.length,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------ transactions -- */

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

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, false),
    ]);
    if (!ids.length) return c.json({ ok: true, transactions: [], total: 0, categories: ctx.list });

    const where = and(
      inArray(transactions.accountId, ids),
      gte(transactions.date, ymd(current.start)),
      lte(transactions.date, ymd(current.end)),
    );

    const [rows, totalRows] = await Promise.all([
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
          overrideCategoryId: transactionOverrides.categoryId,
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
      total: totalRows[0].total,
      categories: ctx.list,
      transactions: rows.map((r) => {
        const { kind, slug } = resolveSlug(r, ctx);
        const key = merchantKey(r.merchantName, r.name);
        return {
          id: r.id,
          date: r.date,
          name: r.merchantName ?? r.name,
          rawName: r.name,
          merchantKey: key,
          amount: -Number(r.amount), // normalised: positive is money in
          pending: r.pending,
          accountId: r.accountId,
          kind,
          category: slug,
          categorySource: r.overrideCategoryId
            ? "user"
            : ctx.ruleBySlugKey.has(key)
              ? "rule"
              : "plaid",
        };
      }),
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------- trend -- */

const TREND_RANGES = [3, 6, 9, 12, 24, 36];

function monthKeys(count: number, today: Date): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

summary.get("/trend", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const asked = Number(c.req.query("months") ?? 12);
    const n = TREND_RANGES.includes(asked) ? asked : 12;
    const account = c.req.query("account") ?? "all";

    const today = new Date();
    // n months of bars need n+12 months of data: every column is measured
    // against the same month a year earlier.
    const span = monthKeys(n + 12, today);
    const visible = span.slice(-n);
    const prior = span.slice(0, n);

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, true),
    ]);

    const monthExpr = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
    // Grouped by merchant as well as category, because a merchant rule can send
    // one shop's spending to a different bucket than Plaid chose. Merchant
    // cardinality is far lower than transaction count, so this still collapses.
    const merchantExpr = sql<string>`coalesce(${transactions.merchantName}, ${transactions.name})`;

    const rows = ids.length
      ? await db
          .select({
            ym: monthExpr,
            categoryPrimary: transactions.categoryPrimary,
            categoryDetailed: transactions.categoryDetailed,
            merchant: merchantExpr,
            overrideCategoryId: transactionOverrides.categoryId,
            outCents: sql<string>`coalesce(sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end), 0)::text`,
            inCents: sql<string>`coalesce(sum(case when ${transactions.amount} < 0 then -${transactions.amount} else 0 end), 0)::text`,
          })
          .from(transactions)
          .leftJoin(
            transactionOverrides,
            and(
              eq(transactionOverrides.transactionId, transactions.id),
              eq(transactionOverrides.userId, auth.user.id),
            ),
          )
          .where(
            and(
              inArray(transactions.accountId, ids),
              gte(transactions.date, `${span[0]}-01`),
              eq(transactions.pending, false),
            ),
          )
          .groupBy(
            monthExpr, transactions.categoryPrimary, transactions.categoryDetailed,
            merchantExpr, transactionOverrides.categoryId,
          )
      : [];

    const blank = () => ({
      total: 0, income: 0, expense: 0,
      byCategory: Object.fromEntries(ctx.list.map((cat) => [cat.slug, 0])) as Record<string, number>,
    });
    const buckets = new Map(span.map((ym) => [ym, blank()]));

    for (const r of rows) {
      const b = buckets.get(r.ym);
      if (!b) continue;
      const { kind, slug } = resolveSlug(
        {
          categoryPrimary: r.categoryPrimary,
          categoryDetailed: r.categoryDetailed,
          merchantName: r.merchant,
          name: r.merchant,
          overrideCategoryId: r.overrideCategoryId,
        },
        ctx,
      );
      if (kind === "transfer") continue;

      b.income += Number(r.inCents);
      const out = Number(r.outCents);
      if (out > 0) {
        b.expense += out;
        if (slug && slug in b.byCategory) b.byCategory[slug] += out;
      }
    }
    for (const b of buckets.values()) b.total = b.expense;

    const shape = (keys: string[]) => keys.map((ym) => ({ month: ym, ...buckets.get(ym)! }));
    const visibleMonths = shape(visible);

    return c.json({
      ok: true,
      months: n,
      series: visibleMonths,
      priorSeries: shape(prior),
      sparklines: {
        income: visibleMonths.map((m) => m.income),
        expense: visibleMonths.map((m) => m.expense),
        net: visibleMonths.map((m) => m.income - m.expense),
        savingsRate: visibleMonths.map((m) =>
          m.income ? Math.round(((m.income - m.expense) / m.income) * 1000) / 10 : 0,
        ),
      },
      categories: ctx.list,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default summary;

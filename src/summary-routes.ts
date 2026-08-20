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
import { and, asc, desc, eq, gte, isNull, lte, or, inArray, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  accounts, categories, items, merchantRules, transactionOverrides, transactions,
} from "./db/schema";
import { requireUser } from "./auth";
import { classify, merchantKey } from "./categories";
import { buildPlan } from "./projection";

const summary = new Hono<{ Bindings: Env }>();

/** Accounts you spend from. A mortgage balance is not a wallet. */
const SPENDING_ACCOUNT_TYPES = ["depository", "credit"];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/* ------------------------------------------------------- category context -- */

export interface CategoryRow {
  id: string; slug: string; label: string; colour: string; sortOrder: number; isSystem: boolean;
  kind: string;
  parentId: string | null;
  parentSlug: string | null;
  parentLabel: string | null;
}

export interface CategoryContext {
  list: CategoryRow[];
  slugById: Map<string, string>;
  /** leaf slug -> its parent's slug. A parent maps to itself, so rolling up is
   *  always the same lookup whether the category has a parent or not. */
  parentOfSlug: Map<string, string>;
  /** slug -> "spend" | "income". Which side of the ledger it belongs on. */
  kindOfSlug: Map<string, string>;
  /** normalised merchant key -> category slug */
  ruleBySlugKey: Map<string, string>;
}

/**
 * Money out can only land in a spending bucket and money in only in an income
 * one, whatever the category says.
 *
 * Without this, an expense filed under an income category rolls up into the
 * Income parent and gets drawn as a bar in the spending chart — income belongs
 * behind the bars as a level, never as one of them. Anything mismatched falls
 * back to the catch-all on the correct side, so the stack still sums to the
 * total rather than quietly losing the amount.
 */
export function bucketFor(
  slug: string | null,
  side: "spend" | "income",
  ctx: CategoryContext,
): string {
  if (slug && ctx.kindOfSlug.get(slug) === side) return slug;
  if (side === "spend") return "other";

  // Money arriving against a spending category is almost always a refund — a
  // return to a shop, a reversed charge. Calling it "Other Income" overstates
  // earnings and quietly lifts the savings rate; "Refunds" is truer, and wrong
  // in an obvious enough way to get corrected.
  return slug && ctx.kindOfSlug.get(slug) === "spend" ? "refunds" : "other-income";
}

export { ownedAccountIds };

/**
 * A user sees system categories plus their own. Loading both together means the
 * rest of the code never has to care which kind it is holding.
 */
export async function loadCategories(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<CategoryContext> {
  const raw = await db
    .select({
      id: categories.id, slug: categories.slug, label: categories.label,
      colour: categories.colour, sortOrder: categories.sortOrder,
      isSystem: categories.isSystem, kind: categories.kind, parentId: categories.parentId,
    })
    .from(categories)
    .where(
      and(
        or(isNull(categories.userId), eq(categories.userId, userId)),
        isNull(categories.archivedAt),
      ),
    )
    .orderBy(categories.sortOrder, categories.label);

  const byId = new Map(raw.map((r) => [r.id, r]));
  const rows: CategoryRow[] = raw.map((r) => {
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    return {
      ...r,
      parentSlug: parent ? parent.slug : null,
      parentLabel: parent ? parent.label : null,
    };
  });

  const slugById = new Map(rows.map((r) => [r.id, r.slug]));

  // A parent maps to itself, so a rollup is one lookup regardless of depth.
  const parentOfSlug = new Map(rows.map((r) => [r.slug, r.parentSlug ?? r.slug]));
  const kindOfSlug = new Map(rows.map((r) => [r.slug, r.kind]));

  const rules = await db
    .select({ matchKey: merchantRules.matchKey, categoryId: merchantRules.categoryId })
    .from(merchantRules)
    .where(eq(merchantRules.userId, userId));

  const ruleBySlugKey = new Map<string, string>();
  for (const r of rules) {
    const slug = slugById.get(r.categoryId);
    if (slug) ruleBySlugKey.set(r.matchKey, slug);
  }

  return { list: rows, slugById, parentOfSlug, kindOfSlug, ruleBySlugKey };
}

/**
 * Rolls leaf totals up to their parents. Leaves with no parent stand alone.
 *
 * `kind` keeps the two ledgers apart: seeding every parent would put an empty
 * "Income" bar in the spending chart and vice versa.
 */
export function rollUp(
  byCategory: Record<string, number>,
  ctx: CategoryContext,
  kind: "spend" | "income" = "spend",
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of ctx.list) if (!c.parentId && c.kind === kind) out[c.slug] = 0;
  for (const [slug, value] of Object.entries(byCategory)) {
    if (!value) continue;
    // Belt and braces: an entry from the other side of the ledger is dropped
    // rather than inventing a parent for it.
    if (ctx.kindOfSlug.get(slug) !== kind) continue;
    const parent = ctx.parentOfSlug.get(slug) ?? slug;
    out[parent] = (out[parent] ?? 0) + value;
  }
  return out;
}

interface Categorisable {
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  merchantName: string | null;
  name: string;
  overrideCategoryId: string | null;
}

/**
 * Override beats rule beats Plaid.
 *
 * The kind follows the chosen category rather than being assumed. Filing
 * something as a transfer has to actually make it a transfer, or the row would
 * be labelled "To Savings" and still counted as spending — which is precisely
 * the double-count that keeping transfers out of the totals exists to avoid.
 */
function resolveSlug(row: Categorisable, ctx: CategoryContext): { kind: string; slug: string | null } {
  const base = classify(row.categoryPrimary, row.categoryDetailed);

  // An override is an explicit statement about this one transaction, so it
  // wins over both a merchant rule and Plaid's guess.
  if (row.overrideCategoryId) {
    const slug = ctx.slugById.get(row.overrideCategoryId);
    if (slug) return { kind: ctx.kindOfSlug.get(slug) ?? "spend", slug };
  }

  // Rules do not apply to transfers: a merchant rule is about what something
  // is, and a transfer between your own accounts is not a purchase.
  if (base.kind === "spend") {
    const ruled = ctx.ruleBySlugKey.get(merchantKey(row.merchantName, row.name));
    if (ruled) return { kind: ctx.kindOfSlug.get(ruled) ?? "spend", slug: ruled };
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

  // month:YYYY-MM — one named calendar month, whole. Every other range is an
  // aggregate ending today, which cannot answer "what did March cost me".
  const named = /^month:(\d{4})-(\d{2})$/.exec(range);
  if (named) {
    const ny = Number(named[1]), nm = Number(named[2]) - 1;
    const start = new Date(Date.UTC(ny, nm, 1));
    const end = new Date(Date.UTC(ny, nm + 1, 0));
    const days = end.getUTCDate();
    return {
      current: {
        start, end,
        label: `${MONTH_LABELS[nm]} ${ny}`,
      },
      previous: {
        start: new Date(Date.UTC(ny, nm - 1, 1)),
        end: new Date(Date.UTC(ny, nm, 0)),
        label: `${MONTH_LABELS[(nm + 11) % 12]}`,
      },
      // A month that has already ended is complete, so pace is not a question.
      // A month still running is measured against the days gone.
      daysElapsed: (ny === y && nm === m) ? d : days,
      daysInPeriod: days,
    };
  }

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
  /** Income broken down too — "where did it come from" is a real question. */
  byIncomeCategory: Record<string, number>;
  /** Money moved between your own accounts. Reported, never counted as spend. */
  byTransferCategory: Record<string, number>;
  transfersMoved: number;
  transfersExcluded: number;
}

const emptyTotals = (ctx: CategoryContext): Totals => ({
  income: 0, expense: 0, net: 0,
  byCategory: Object.fromEntries(ctx.list.filter((c) => c.kind === "spend").map((c) => [c.slug, 0])),
  byIncomeCategory: Object.fromEntries(ctx.list.filter((c) => c.kind === "income").map((c) => [c.slug, 0])),
  byTransferCategory: Object.fromEntries(ctx.list.filter((c) => c.kind === "transfer").map((c) => [c.slug, 0])),
  transfersMoved: 0,
  transfersExcluded: 0,
});

interface AmountRow extends Categorisable { amount: bigint; }

/**
 * Which line of the Categories tab a single transaction lands on.
 *
 * Deliberately shared between the totals and the drill-down, so expanding a
 * category shows exactly the rows that built its number. Two copies of this
 * rule would disagree the first time either was edited, and the symptom — a
 * category whose transactions do not add up to its own total — is precisely
 * the kind of thing that makes someone stop believing the rest of the app.
 *
 * `signed` is normalised on the way out: positive is money in.
 */
export function displayBucket(
  amount: bigint,
  row: Categorisable,
  ctx: CategoryContext,
): { kind: string; bucket: string | null; signed: number } {
  const signed = -Number(amount); // flip Plaid's sign: negative meant money in
  const { kind, slug } = resolveSlug(row, ctx);

  // Your own money changing pocket. Reported under its transfer category,
  // never added to income or expense.
  if (kind === "transfer") return { kind, bucket: slug, signed };

  // Which bucket a row lands in follows the money, not the label. Somebody
  // can file a refund under any category they like; it is still money in.
  return signed > 0
    ? { kind: "income", bucket: bucketFor(slug, "income", ctx), signed }
    : { kind: "spend", bucket: bucketFor(slug, "spend", ctx), signed };
}

function tally(rows: AmountRow[], ctx: CategoryContext): Totals {
  const out = emptyTotals(ctx);
  for (const r of rows) {
    const { kind, bucket, signed } = displayBucket(r.amount, r, ctx);

    if (kind === "transfer") {
      out.transfersExcluded++;
      const moved = Math.abs(signed);
      out.transfersMoved += moved;
      if (bucket && bucket in out.byTransferCategory) out.byTransferCategory[bucket] += moved;
      continue;
    }

    if (kind === "income") {
      out.income += signed;
      out.byIncomeCategory[bucket!] = (out.byIncomeCategory[bucket!] ?? 0) + signed;
      continue;
    }

    out.expense += -signed;
    out.byCategory[bucket!] = (out.byCategory[bucket!] ?? 0) + -signed;
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

/* ------------------------------------------------------------------ budget -- */

/** Every calendar month a window touches, both ends included. */
function monthsIn(start: Date, end: Date): string[] {
  const out: string[] = [];
  let y = start.getUTCFullYear(), m = start.getUTCMonth();
  const lastY = end.getUTCFullYear(), lastM = end.getUTCMonth();
  while (y < lastY || (y === lastY && m <= lastM)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (++m === 12) { m = 0; y++; }
  }
  return out;
}

/**
 * What the range should have cost, by the same calculation the forecast uses.
 *
 * Whole months, not days elapsed. A budget spread across the days so far would
 * compare a half-finished month against half a budget and report you on track
 * every single time, which is the one thing a budget exists to prevent. Three
 * days into the month you have a whole month's expectation and have spent three
 * days of it, and the number says so.
 *
 * Past months are priced at what they were expected to cost, not at what they
 * did. Otherwise the budget would equal the actual by construction and the
 * comparison would say nothing at all.
 */
async function budgetFor(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
  ids: string[],
  ctx: CategoryContext,
  current: Window,
  today: Date,
) {
  const months = monthsIn(current.start, current.end);
  const plan = await buildPlan(db, userId, ids, ctx, months, today);
  const planned = months.map((m) => plan.for(m));

  const byCategory: Record<string, number> = {};
  for (const p of planned) {
    for (const [slug, v] of Object.entries(p.byCategory)) {
      byCategory[slug] = (byCategory[slug] ?? 0) + v;
    }
  }

  const available = plan.method !== "insufficient-data";
  const income = planned.reduce((s, p) => s + p.income, 0);
  const expense = planned.reduce((s, p) => s + p.expense, 0);

  return {
    available,
    method: plan.method,
    growthPct: plan.growthPct,
    monthsOfHistory: plan.monthsOfHistory,
    comparableMonths: plan.comparableMonths,
    months: months.length,
    income, expense,
    net: income - expense,
    savingsRate: income > 0 ? ((income - expense) / income) * 100 : null,
    byCategory,
    byParent: rollUp(byCategory, ctx),
  };
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

    const [nowRows, prevRows, budget] = await Promise.all([
      inWindow(current),
      inWindow(previous),
      budgetFor(db, auth.user.id, ids, ctx, current, new Date()),
    ]);
    const now = tally(nowRows as AmountRow[], ctx);
    const before = tally(prevRows as AmountRow[], ctx);

    const daysLeft = Math.max(0, daysInPeriod - daysElapsed);
    const remaining = Math.max(0, now.income - now.expense);
    const paceTarget = now.income * (daysElapsed / daysInPeriod);

    return c.json({
      ok: true,
      range: { key: range, label: current.label, start: ymd(current.start), end: ymd(current.end) },
      comparison: { label: previous.label, start: ymd(previous.start), end: ymd(previous.end) },
      totals: {
        ...now,
        byParent: rollUp(now.byCategory, ctx),
        byIncomeParent: rollUp(now.byIncomeCategory, ctx, "income"),
      },
      previous: {
        ...before,
        byParent: rollUp(before.byCategory, ctx),
        byIncomeParent: rollUp(before.byIncomeCategory, ctx, "income"),
      },
      safeToSpend: {
        remaining,
        perDay: daysLeft > 0 ? Math.round(remaining / daysLeft) : remaining,
        daysLeft, daysElapsed, daysInPeriod,
        spent: now.expense, budget: now.income,
        onPace: now.expense <= paceTarget,
      },
      budget,
      categories: ctx.list,
      accountsCounted: ids.length,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------ transactions -- */

/**
 * How many rows a drill-down will read before giving up on being exact.
 * Comfortably above a year of ordinary spending; low enough that a pathological
 * range cannot stall a request.
 */
const DRILL_SCAN_CAP = 4000;

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
    // Drill-down: the rows behind one line of the Categories tab. Not a SQL
    // filter, because the effective category is not a column — it is resolved
    // per row from an override, a merchant rule, or Plaid's guess. So the range
    // is read whole and filtered here, exactly as the totals are.
    const bucket = c.req.query("bucket") ?? null;

    // Filter on the description as the reader sees it: the merchant name where
    // Plaid supplies one, the raw bank string otherwise. Matching on the raw
    // column instead would offer a menu of names that are not on screen.
    const merchant = c.req.query("merchant") ?? null;

    // Absent means "newest first", which is the useful default for a ledger.
    const amountQ = c.req.query("amount");
    const amountSort = amountQ === "asc" || amountQ === "desc" ? amountQ : null;

    // An empty period means everything, so the window is simply not applied.
    const allTime = range === "all";
    const { current } = resolveRange(allTime ? "this-month" : range, new Date());

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, false),
    ]);
    if (!ids.length) return c.json({ ok: true, transactions: [], total: 0, categories: ctx.list });

    const displayName = sql<string>`coalesce(${transactions.merchantName}, ${transactions.name})`;

    // The period, and nothing else. The description menu is built from this, so
    // that choosing one name does not collapse the menu to that single name.
    const inPeriod = allTime
      ? inArray(transactions.accountId, ids)
      : and(
          inArray(transactions.accountId, ids),
          gte(transactions.date, ymd(current.start)),
          lte(transactions.date, ymd(current.end)),
        );

    const where = merchant ? and(inPeriod, eq(displayName, merchant)) : inPeriod;

    const page = db
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
      // Ascending and descending mean what the reader sees, not what is stored.
      // The column keeps Plaid's convention — positive is money LEAVING — so
      // the displayed value is its negation and the two directions swap here.
      // Ascending therefore puts the largest spend at the top and income at the
      // bottom, which is the arithmetic being asked for even though it reads
      // backwards at a glance.
      //
      // Date is the tiebreak, so a page boundary cannot repeat or drop a row
      // when many share an amount.
      .orderBy(
        amountSort === "asc" ? desc(transactions.amount)
        : amountSort === "desc" ? asc(transactions.amount)
        : desc(transactions.date),
        desc(transactions.date),
      );

    let rows;
    let total;

    if (bucket) {
      // A parent drills into everything beneath it, a leaf into just itself.
      // parentOfSlug maps a parent to itself, so one pass covers both.
      const wanted = new Set<string>([bucket]);
      for (const [slug, parent] of ctx.parentOfSlug) if (parent === bucket) wanted.add(slug);

      // Capped rather than unbounded: this runs inside a request, and a range
      // wide enough to exceed the cap is one nobody is reading line by line.
      const all = await page.limit(DRILL_SCAN_CAP);
      const matching = all.filter((r) => {
        const { bucket: landed } = displayBucket(r.amount, r, ctx);
        return landed !== null && wanted.has(landed);
      });
      total = matching.length;
      rows = matching.slice(offset, offset + limit);
    } else {
      const [pageRows, totalRows] = await Promise.all([
        page.limit(limit).offset(offset),
        db.select({ total: sql<number>`count(*)::int` }).from(transactions).where(where),
      ]);
      rows = pageRows;
      total = totalRows[0].total;
    }

    // Every description in the period, for the menu on that column. Capped:
    // past a few hundred a dropdown is not how anybody finds a merchant.
    const merchantRows = await db
      .selectDistinct({ name: displayName })
      .from(transactions)
      .where(inPeriod)
      .orderBy(displayName)
      .limit(400);

    return c.json({
      ok: true,
      total,
      merchants: merchantRows.map((r) => r.name).filter(Boolean),
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

export interface MonthBucket {
  total: number;
  income: number;
  expense: number;
  byCategory: Record<string, number>;
}

/**
 * Monthly income and spending, with categories resolved.
 *
 * Grouped by merchant as well as category, because a merchant rule can send one
 * shop's spending to a different bucket than Plaid chose — the grouping has to
 * be fine enough for rules to still apply. Merchant cardinality is far lower
 * than transaction count, so this still collapses the work substantially.
 *
 * Shared by /trend and /forecast: two implementations of "what did each month
 * cost" would eventually disagree, and the forecast is built on the history.
 */
export async function monthlyBuckets(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
  accountIds: string[],
  ctx: CategoryContext,
  span: string[],
): Promise<Map<string, MonthBucket>> {
  const blank = (): MonthBucket => ({
    total: 0, income: 0, expense: 0,
    byCategory: Object.fromEntries(ctx.list.map((cat) => [cat.slug, 0])),
  });
  const buckets = new Map(span.map((ym) => [ym, blank()]));
  if (!accountIds.length || !span.length) return buckets;

  const monthExpr = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
  const merchantExpr = sql<string>`coalesce(${transactions.merchantName}, ${transactions.name})`;

  const rows = await db
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
        eq(transactionOverrides.userId, userId),
      ),
    )
    .where(
      and(
        inArray(transactions.accountId, accountIds),
        gte(transactions.date, `${span[0]}-01`),
        eq(transactions.pending, false),
      ),
    )
    .groupBy(
      monthExpr, transactions.categoryPrimary, transactions.categoryDetailed,
      merchantExpr, transactionOverrides.categoryId,
    );

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
      // Spending can only land in a spending bucket. An expense filed under an
      // income category would otherwise stack as an "Income" bar in the chart,
      // and income belongs behind the bars as a level, never as one of them.
      const bucket = bucketFor(slug, "spend", ctx);
      b.byCategory[bucket] = (b.byCategory[bucket] ?? 0) + out;
    }
  }
  for (const b of buckets.values()) b.total = b.expense;
  return buckets;
}

export function monthKeys(count: number, today: Date): string[] {
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

    const buckets = await monthlyBuckets(db, auth.user.id, ids, ctx, span);
    // byParent alongside byCategory: nine stacked segments read as a shape,
    // twenty-two read as noise.
    const shape = (keys: string[]) =>
      keys.map((ym) => {
        const b = buckets.get(ym)!;
        return { month: ym, ...b, byParent: rollUp(b.byCategory, ctx) };
      });
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

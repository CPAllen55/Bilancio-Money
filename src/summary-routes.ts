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
import {
  and, asc, desc, eq, gte, ilike, isNull, lte, notExists, notInArray, or, inArray, sql,
  type SQL,
} from "drizzle-orm";
import { getDb } from "./db/client";
import {
  accounts, categories, items, merchantRules, transactionOverrides, transactions,
  transactionSplits,
} from "./db/schema";
import { requireUser } from "./auth";
import { classify, merchantKey } from "./categories";
import { buildShapedPlan, learnWindow, loadOverrides } from "./plan";
import { judgeAll, type Charge, type Verdict } from "./recurring";
import { partsOf, type Split } from "./splits";

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
function resolveSlug(
  row: Categorisable,
  ctx: CategoryContext,
): { kind: string; slug: string | null; explicit: boolean } {
  // Computed once: the merchant rule looks it up, and the wholesale clubs are
  // told apart from ordinary superstores by the same normalised name.
  const key = merchantKey(row.merchantName, row.name);
  const base = classify(row.categoryPrimary, row.categoryDetailed, key);

  // An override is an explicit statement about this one transaction, so it
  // wins over both a merchant rule and Plaid's guess.
  if (row.overrideCategoryId) {
    const slug = ctx.slugById.get(row.overrideCategoryId);
    if (slug) return { kind: ctx.kindOfSlug.get(slug) ?? "spend", slug, explicit: true };
  }

  // Rules do not apply to transfers: a merchant rule is about what something
  // is, and a transfer between your own accounts is not a purchase.
  if (base.kind === "spend") {
    const ruled = ctx.ruleBySlugKey.get(key);
    if (ruled) return { kind: ctx.kindOfSlug.get(ruled) ?? "spend", slug: ruled, explicit: false };
  }

  return { ...base, explicit: false };
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

  // span:YYYY-MM..YYYY-MM — an explicit run of whole months. The trend chart is
  // zoomed to an arbitrary window, and "the transactions behind what I am
  // looking at" has to mean exactly the months on screen, not the nearest
  // named range to them.
  const span = /^span:(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/.exec(range);
  if (span) {
    const [sy, sm, ey, em] = [Number(span[1]), Number(span[2]) - 1, Number(span[3]), Number(span[4]) - 1];
    const start = new Date(Date.UTC(sy, sm, 1));
    const end = new Date(Date.UTC(ey, em + 1, 0));
    const months = (ey - sy) * 12 + (em - sm) + 1;
    return {
      current: { start, end, label: `${MONTH_LABELS[sm]} ${sy} to ${MONTH_LABELS[em]} ${ey}` },
      previous: {
        start: new Date(Date.UTC(sy, sm - months, 1)),
        end: new Date(Date.UTC(sy, sm, 0)),
        label: "The period before",
      },
      daysElapsed: months * 30, daysInPeriod: months * 30,
    };
  }

  // last-N months, N being any of the offered spans.
  // hard-coded cases so a new span is an entry in a menu rather than a branch.
  const lastN = /^last-(3|6|12|24)$/.exec(range);
  if (lastN) {
    const months = Number(lastN[1]);
    return {
      current: { start: new Date(Date.UTC(y, m - months + 1, 1)), end: new Date(Date.UTC(y, m, d)), label: months === 24 ? "Last 2 years" : months === 12 ? "Last 12 months" : `Last ${months} months` },
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

interface AmountRow extends Categorisable { id: string; amount: bigint; }

/** Splits by transaction id. Absent means the transaction is whole. */
type SplitMap = Map<string, Split[]>;

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
  const { kind, slug, explicit } = resolveSlug(row, ctx);

  // Your own money changing pocket. Reported under its transfer category,
  // never added to income or expense.
  if (kind === "transfer") return { kind, bucket: slug, signed };

  /* Somebody re-filing one row by hand has told us something the direction of
   * the money cannot tell us back.
   *
   * The case that showed this up: money arriving from a partner, covering a
   * bill already paid. Before, an inbound row met a spending category and was
   * quietly rebucketed as a refund — you chose Home and the app showed Refunds,
   * which is the app disagreeing with you in silence. Now it lands on Home as a
   * negative and cancels the part of the bill it was paying back, which is what
   * a reimbursement is.
   *
   * Only an override earns this. Plaid's guess and a merchant rule are still
   * overruled by the way the cash actually travelled: those are generalisations
   * about a merchant, and a generalisation must not be able to invent income.
   */
  if (explicit && slug) return { kind, bucket: slug, signed };

  // Otherwise the bucket follows the money, not the label. Somebody can file a
  // refund under any category they like; it is still money in.
  return signed > 0
    ? { kind: "income", bucket: bucketFor(slug, "income", ctx), signed }
    : { kind: "spend", bucket: bucketFor(slug, "spend", ctx), signed };
}

/**
 * What one transaction contributes, one entry per category it touches.
 *
 * With no splits stored this yields a single part carrying the whole amount,
 * so an ordinary transaction goes through exactly the arithmetic it always
 * did. There is no separate unsplit path to keep in step.
 *
 * A carved-off part is fed back through displayBucket as though it were an
 * override, because that is what it is: somebody pointing at this one
 * transaction and naming a category. Reusing the override path rather than
 * writing a second one means a split inherits every rule an override already
 * obeys — a part filed under a transfer category leaves the totals, a part
 * filed under an income category is allowed to be money coming back. The rule
 * is stated once and both callers read it.
 */
function partsFor(
  r: AmountRow,
  splits: SplitMap,
): { amount: bigint; row: Categorisable }[] {
  const stored = splits.get(r.id);
  if (!stored || !stored.length) return [{ amount: r.amount, row: r }];
  return partsOf(Number(r.amount), stored).map((p) => ({
    amount: BigInt(p.cents),
    row: p.categoryId === null ? r : { ...r, overrideCategoryId: p.categoryId },
  }));
}

export function tally(rows: AmountRow[], ctx: CategoryContext, splits: SplitMap): Totals {
  const out = emptyTotals(ctx);
  for (const r of rows) {
    for (const part of partsFor(r, splits)) {
      const { kind, bucket, signed } = displayBucket(part.amount, part.row, ctx);

      if (kind === "transfer") {
        /* Counted per part rather than per transaction: a piece of a purchase
           moved to a transfer category is its own excluded item, and the money
           beside the count is the money that left the totals with it. */
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

/**
 * The rows every figure in this file is built from.
 *
 * One function because the alternative was four copies of the same three
 * conditions, and four copies of a condition are four chances to disagree —
 * which is exactly what happened. The totals excluded pending transactions and
 * the transactions list did not, so a September that had $793.65 in the ledger
 * showed $184 on the Overview, and a category bar read "$0 spent" directly
 * above the $499.19 charge it was refusing to count.
 *
 * ── Pending rows count ──────────────────────────────────────────────────────
 *
 * They are money that has left, or is leaving, and the bank already counts
 * them: Plaid's `current` balance includes pending charges, which is why Net
 * Worth has always included them too. Excluding them from spending meant every
 * month was understated for as long as its newest charges took to settle —
 * worst in the first days of a month, which is exactly when somebody is
 * looking to see how the month is going.
 *
 * The objection to counting them is that a pending amount can still change: a
 * fuel hold settles at a different figure, a restaurant adds a tip. That is
 * real and it is much the smaller error. A figure that is briefly approximate
 * beats one that is confidently wrong, and it self-corrects — sync replaces the
 * pending row with the settled one and deletes the original by id, so nothing
 * is ever counted twice.
 *
 * The one place that still wants settled rows only is the recurring rule, which
 * reads amounts and dates to decide whether a charge repeats and can use
 * neither until they are final. It says so where it asks.
 */
function ledgerRows(accountIds: string[], from?: Date | string, to?: Date | string) {
  const ymdOf = (d: Date | string) => (typeof d === "string" ? d : ymd(d));
  return and(
    inArray(transactions.accountId, accountIds),
    from ? gte(transactions.date, ymdOf(from)) : undefined,
    to ? lte(transactions.date, ymdOf(to)) : undefined,
  );
}

const rowFields = {
  id: transactions.id,
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

/**
 * The splits for whatever a where-clause matched.
 *
 * Loaded by joining that same predicate rather than by listing the ids it
 * returned: a wide range is thousands of transactions, and sending thousands
 * of uuids back to Postgres to ask about the handful that are split is a very
 * large question with a very small answer. Splits are rare, so this reads a
 * few rows however big the window is.
 */
async function loadSplits(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
  where: SQL | undefined,
): Promise<SplitMap> {
  const rows = await db
    .select({
      transactionId: transactionSplits.transactionId,
      categoryId: transactionSplits.categoryId,
      cents: transactionSplits.cents,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(and(eq(transactionSplits.userId, userId), where));

  const out: SplitMap = new Map();
  for (const r of rows) {
    const one = { categoryId: r.categoryId, cents: Number(r.cents) };
    const list = out.get(r.transactionId);
    if (list) list.push(one); else out.set(r.transactionId, [one]);
  }
  return out;
}

/* ---------------------------------------------------------- subscriptions -- */

/* How far back to look for a repeating charge.
 *
 * Eighteen months, which is six more than the longest range the Transactions
 * tab offers. The rule wants three consecutive months and the reader may be
 * looking at a page from a year ago, so the window has to cover the run around
 * whatever is on screen rather than the run up to today.
 *
 * The row cap is a backstop against a merchant string that turns out to match
 * half the ledger. It drops the oldest first, which is the right end to lose:
 * the rule reads consecutive pairs, so losing the tail of a long run leaves
 * the recent run intact and the verdict unchanged. */
const SUBSCRIPTION_MONTHS = 18;
const SUBSCRIPTION_SCAN_CAP = 6000;

/**
 * Which of the merchants on this page are charging on a subscription.
 *
 * Asked of the merchants on the page rather than of the whole ledger: the
 * question is only ever "is this row a subscription", and a user with four
 * years of history has no interest in paying to evaluate merchants that are
 * not on screen. One extra query, bounded by the names it was given.
 */
async function subscriptionsFor(
  db: ReturnType<typeof getDb>["db"],
  ids: string[],
  displayName: ReturnType<typeof sql<string>>,
  names: string[],
  today: Date,
): Promise<{ byKey: Map<string, Verdict>; names: Set<string> }> {
  if (!names.length || !ids.length) return { byKey: new Map(), names: new Set() };

  const from = new Date(today);
  from.setUTCMonth(from.getUTCMonth() - SUBSCRIPTION_MONTHS);

  const history = await db
    .select({
      date: transactions.date,
      amount: transactions.amount,
      name: transactions.name,
      merchantName: transactions.merchantName,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, ids),
        gte(transactions.date, ymd(from)),
        inArray(displayName, names),
        /* The one place in this file that excludes pending, and the only one
           that should: this rule decides whether a charge repeats by comparing
           amounts and the gaps between dates, and a charge that has not settled
           has a final version of neither. It is a question about the shape of a
           history, not a figure anybody adds up, so leaving a row out here does
           not put a total out of step with the ledger. */
        eq(transactions.pending, false),
      ),
    )
    .orderBy(desc(transactions.date))
    .limit(SUBSCRIPTION_SCAN_CAP);

  const charges = new Map<string, Charge[]>();
  /* key -> the display names that normalise to it. merchantKey folds case,
     punctuation and long digit runs together, so one verdict can cover several
     spellings — and the filter below works in SQL on the display name, which
     is the column, so it needs them all back. */
  const spellings = new Map<string, Set<string>>();

  for (const r of history) {
    const key = merchantKey(r.merchantName, r.name);
    if (!key) continue;
    // The column is Plaid's way round already: positive means money left.
    const list = charges.get(key);
    if (list) list.push({ date: r.date, cents: Number(r.amount) });
    else charges.set(key, [{ date: r.date, cents: Number(r.amount) }]);

    const shown = r.merchantName ?? r.name;
    const seen = spellings.get(key);
    if (seen) seen.add(shown);
    else spellings.set(key, new Set([shown]));
  }

  const byKey = judgeAll(charges);
  const subNames = new Set<string>();
  for (const key of byKey.keys()) {
    for (const n of spellings.get(key) ?? []) subNames.add(n);
  }
  return { byKey, names: subNames };
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
  const { learn } = learnWindow(today);

  /* The same plan the Budgeting tab draws, from the same function.
   *
   * This used to run its own machinery — buildPlan, a per-category method, a
   * seasonal growth rate — and the result was that Budgeting and the Overview
   * could show different budgets for the same month and both be behaving
   * correctly. Four dashboards agreeing is not something that can be
   * maintained by keeping four implementations in step; they have to be one
   * implementation. */
  const [buckets, overrides] = await Promise.all([
    monthlyBuckets(db, userId, ids, ctx, [...new Set([...learn, ...months])].sort()),
    loadOverrides(db, userId),
  ]);
  const planned = buildShapedPlan(ctx.list, buckets, learn, months, overrides);

  // Summed across the window. The per-month shape is what the charts want and
  // is computed by the same call.
  const byCategory: Record<string, number> = {};
  for (const [slug, perMonth] of Object.entries(planned.byCategory)) {
    const total = months.reduce((s, m) => s + (perMonth[m] ?? 0), 0);
    if (total > 0) byCategory[slug] = total;
  }

  const income = months.reduce((s, m) => s + (planned.income[m] ?? 0), 0);
  const expense = Object.values(byCategory).reduce((s, v) => s + v, 0);

  /* With one method there is nothing that cannot produce a figure — a category
     with no history plans zero and says so through its own shape rather than
     by being listed as undecided. The field stays so the callers that read it
     keep working; it is simply always empty now. */
  const unplanned: string[] = [];

  return {
    // A plan needs history to be worth anything. Below six complete months the
    // shape has nothing to fit and every figure is really just a recent median.
    available: planned.monthsOfHistory > 0 && (expense > 0 || income > 0),
    method: "shaped" as const,
    growthPct: null,
    monthsOfHistory: planned.monthsOfHistory,
    comparableMonths: planned.monthsOfHistory,
    months: months.length,
    income, expense,
    net: income - expense,
    savingsRate: income > 0 ? ((income - expense) / income) * 100 : null,
    byCategory,
    byParent: rollUp(byCategory, ctx),
    unplanned,
  };
}

/* ----------------------------------------------------------------- summary -- */

summary.get("/summary", async (c) => {
  // Read-only and expensive: safe to serve from Hyperdrive's cache when a
  // caching binding exists. See getDb.
  const { db, ready, close } = getDb(c.env, { cached: true });
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

    /* Named rather than inlined so the splits can be fetched against the very
       same predicate. Two conditions that have to select the same rows and are
       written out twice are two conditions that will one day differ. */
    const windowWhere = (w: Window) => ledgerRows(ids, w.start, w.end);

    const inWindow = (w: Window) =>
      ids.length
        ? withOverrides(db, auth.user.id).where(windowWhere(w))
        : Promise.resolve([] as AmountRow[]);

    const splitsIn = (w: Window) =>
      ids.length
        ? loadSplits(db, auth.user.id, windowWhere(w))
        : Promise.resolve(new Map() as SplitMap);

    const [nowRows, prevRows, nowSplits, prevSplits, budget] = await Promise.all([
      inWindow(current),
      inWindow(previous),
      splitsIn(current),
      splitsIn(previous),
      budgetFor(db, auth.user.id, ids, ctx, current, new Date()),
    ]);
    const now = tally(nowRows as AmountRow[], ctx, nowSplits);
    const before = tally(prevRows as AmountRow[], ctx, prevSplits);

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
    /* Only the bucketed path can answer this. The other one pages in SQL and
       never has the whole set in hand, so it returns an empty list rather
       than a wrong one built from a page. */
    let vendors: { key: string; name: string; logo: string | null; cents: number; count: number }[] = [];

    // Filter on the description as the reader sees it: the merchant name where
    // Plaid supplies one, the raw bank string otherwise. Matching on the raw
    // column instead would offer a menu of names that are not on screen.
    const merchant = c.req.query("merchant") ?? null;

    const subQ = c.req.query("subscription");
    const subFilter = subQ === "yes" || subQ === "no" ? subQ : null;

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
    /* The same function the totals use. This list is what somebody checks a
       total against, so "the rows on this page" and "the rows in that figure"
       have to be one definition rather than two that look alike. */
    const inPeriod = allTime
      ? ledgerRows(ids)
      : ledgerRows(ids, current.start, current.end);

    /* Any part of a description, not the whole of it.
     *
     * This matched exactly, which was honest while the only way to set it was
     * to pick a whole name out of a menu. The heading can be typed into now,
     * and somebody typing "venmo" means every Venmo row — not the one whose
     * bank spelling happens to be exactly that, which is a string nobody knows
     * without looking it up first.
     *
     * The wildcards are escaped, so a description containing % or _ still finds
     * itself rather than matching half the ledger. */
    /* Every description in the period. This used to be fetched at the end,
       purely to fill the menu on that column; it is needed up front now
       because the subscription verdicts are worked out from it, and the page
       query may have to filter on them.

       Still capped, but the cap stopped being the limit of what is reachable
       when the heading became typeable — anything past it is found by typing
       part of it. */
    const merchantRows = await db
      .selectDistinct({ name: displayName })
      .from(transactions)
      .where(inPeriod)
      .orderBy(displayName)
      .limit(400);
    const periodNames = merchantRows.map((r) => r.name).filter(Boolean);

    /* Judged across the period's merchants rather than the page's.
     *
     * The page's would be enough to label the rows, and was, until the column
     * became a filter: filtering the page by a verdict computed from the page
     * is circular. So the question is asked of everything in the window, once,
     * and both the filter and the labels read the same answer. */
    const subs = await subscriptionsFor(db, ids, displayName, periodNames, new Date());

    const textWhere = merchant
      ? and(inPeriod, ilike(displayName, "%" + merchant.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%"))
      : inPeriod;

    /* Applied in SQL on the display name, so the count, the totals and the
       paging all agree with the rows. An empty set is handled rather than
       passed to inArray, which would build an IN () — a syntax error in
       Postgres, not an empty result. */
    const subNames = [...subs.names];
    const where =
      !subFilter ? textWhere
      : subFilter === "yes"
        ? (subNames.length ? and(textWhere, inArray(displayName, subNames)) : sql`false`)
        : (subNames.length ? and(textWhere, notInArray(displayName, subNames)) : textWhere);

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
        /* Plaid puts a merchant logo URL on the transaction and the whole
           object is kept in `raw`, so this is already here — no resync
           needed, and only the one field is read rather than the whole blob. */
        logoUrl: sql<string | null>`${transactions.raw}->>'logo_url'`,
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

    /* Read once for the whole filtered set, then used twice: to decide which
       rows belong to a category being drilled into, and to tell the page which
       of its rows are divided. */
    const splits = await loadSplits(db, auth.user.id, where);

    /* A row on its way out, with the amount that belongs to the category being
       drilled into rather than the amount on the statement. `partOf` carries
       the whole so the reader can be told this is a piece of something. */
    type Drilled = Awaited<typeof page>[number] & { partOf?: number };

    let rows;
    let total;
    // Totals for everything the filters match, not for the page being shown.
    // Summing the visible rows would read as the answer and quietly be the
    // answer to a different question whenever the list is capped.
    let moneyIn = 0;
    let moneyOut = 0;

    if (bucket) {
      // A parent drills into everything beneath it, a leaf into just itself.
      // parentOfSlug maps a parent to itself, so one pass covers both.
      const wanted = new Set<string>([bucket]);
      for (const [slug, parent] of ctx.parentOfSlug) if (parent === bucket) wanted.add(slug);

      // Capped rather than unbounded: this runs inside a request, and a range
      // wide enough to exceed the cap is one nobody is reading line by line.
      const all = await page.limit(DRILL_SCAN_CAP);

      /* A split transaction belongs to this category for the part that was
         filed here, and for no more than that. Listing the whole $388.01 shop
         under Gifts because $50 of it was a present would make the drill-down
         disagree with the total it was opened from — and the drill-down exists
         to show the reader exactly what built that number. */
      const matching: Drilled[] = [];
      for (const r of all) {
        const parts = partsFor(r as AmountRow, splits);
        let attributed = 0n;
        let hit = false;
        let filedAs: string | null = r.overrideCategoryId;
        let several = false;

        for (const part of parts) {
          const { bucket: landed } = displayBucket(part.amount, part.row, ctx);
          if (landed === null || !wanted.has(landed)) continue;
          attributed += part.amount;
          /* Drilling into a parent can catch two of one transaction's parts.
             Then no single category is the answer and the row keeps its own. */
          if (hit) several = true;
          else filedAs = part.row.overrideCategoryId;
          hit = true;
        }
        if (!hit) continue;

        matching.push(
          attributed === r.amount
            ? r
            : {
                ...r,
                amount: attributed,
                overrideCategoryId: several ? r.overrideCategoryId : filedAs,
                partOf: -Number(r.amount),   // normalised: positive is money in
              },
        );
      }

      total = matching.length;
      rows = matching.slice(offset, offset + limit);
      for (const r of matching) {
        // The attributed amount, not the statement amount, so these totals are
        // the ones the category tile was showing.
        const signed = -Number(r.amount);   // normalised: positive is money in
        if (signed > 0) moneyIn += signed; else moneyOut += -signed;
      }

      /* Who the money went to, over the WHOLE filtered set rather than the
         page of it that is returned.

         This is the reason it is worked out here and not in the browser. The
         client is handed fifty rows out of a hundred and twenty-six; a chart
         built from those fifty would look like an answer and be a sample,
         and the biggest vendor of the year could be missing from it entirely
         because their last visit was in March. Every row is already in hand
         at this point — the loop above walks all of them — so the rollup
         costs one more pass over an array that is already in memory.

         Grouped by merchantKey rather than by the printed name, so STARBUCKS
         #1234 and SQ *STARBUCKS are one vendor. That is the same key a
         merchant rule matches on, so the grouping a reader sees here is the
         grouping the app already acts on. */
      const byVendor = new Map<
        string,
        { key: string; name: string; logo: string | null; cents: number; count: number }
      >();
      for (const r of matching) {
        const signed = -Number(r.amount);
        // Money coming back is a refund, not a vendor this category spent at.
        if (signed >= 0) continue;
        const key = merchantKey(r.merchantName, r.name) || "—";
        const at = byVendor.get(key);
        if (at) {
          at.cents += -signed;
          at.count += 1;
          // A logo on any of a vendor's rows stands for all of them.
          if (!at.logo) at.logo = logoFile(r.logoUrl);
        } else {
          byVendor.set(key, {
            key,
            /* The name as it is printed, taken from the first row seen, which
               is the most recent — a shop that renamed itself is shown under
               the name it uses now. */
            name: r.merchantName ?? r.name,
            logo: logoFile(r.logoUrl),
            cents: -signed,
            count: 1,
          });
        }
      }
      vendors = [...byVendor.values()].sort((a, b) => b.cents - a.cents);
    } else {
      const [pageRows, totals] = await Promise.all([
        page.limit(limit).offset(offset),
        db
          .select({
            total: sql<number>`count(*)::int`,
            // The column is Plaid's way round — positive means money left — so
            // "in" is the negative side of it and the signs swap here.
            moneyIn: sql<string>`coalesce(sum(case when ${transactions.amount} < 0 then -${transactions.amount} else 0 end), 0)::text`,
            moneyOut: sql<string>`coalesce(sum(case when ${transactions.amount} > 0 then ${transactions.amount} else 0 end), 0)::text`,
          })
          .from(transactions)
          .where(where),
      ]);
      rows = pageRows;
      total = totals[0].total;
      moneyIn = Number(totals[0].moneyIn);
      moneyOut = Number(totals[0].moneyOut);
    }

    return c.json({
      ok: true,
      total,
      // Across everything matched, in the reader's convention: positive is in.
      sum: { in: moneyIn, out: moneyOut, net: moneyIn - moneyOut },
      /* Who the money went to, biggest first, over the whole filtered set.
         Empty on the unbucketed path, which never has the whole set. */
      vendors,
      merchants: periodNames,
      categories: ctx.list,
      transactions: (rows as Drilled[]).map((r) => {
        const { kind, slug } = resolveSlug(r, ctx);
        const key = merchantKey(r.merchantName, r.name);
        /* Sent in the reader's convention, the same way round as `amount`, so
           the editor never has to know which way Plaid counts. */
        const parts = (splits.get(r.id) ?? []).map((s) => ({
          categoryId: s.categoryId,
          amount: -s.cents,
        }));
        return {
          id: r.id,
          /* Present only when this row is a piece of a larger transaction:
             the whole it was carved from. */
          partOf: r.partOf ?? null,
          splits: parts,
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
          /* Only the filename travels. The client rebuilds the path against
             our own origin, so the URL Plaid gave us never reaches a browser
             and cannot be fetched from one. */
          logo: logoFile(r.logoUrl),
          /* Worked out, not stored — see recurring.ts for the rule and for
             what it deliberately refuses to guess at. Null rather than false
             where there is no verdict, so the client can tell "not a
             subscription" from "never asked". */
          subscription: subs.byKey.get(key)
            ? {
                cents: subs.byKey.get(key)!.cents,
                since: subs.byKey.get(key)!.since,
                count: subs.byKey.get(key)!.count,
                rose: subs.byKey.get(key)!.rose,
              }
            : null,
        };
      }),
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * The last path segment of a Plaid logo URL, if it looks like one of theirs.
 *
 * Anything else comes back null rather than being passed along: the proxy
 * checks the name again at its end, and a value that fails here should not be
 * given the chance to be interesting there.
 */
const LOGO_CDN = "https://plaid-merchant-logos.plaid.com/";
const LOGO_FILE = /^[a-z0-9][a-z0-9_-]{0,80}\.png$/;

function logoFile(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!u.startsWith(LOGO_CDN)) return null;
  const file = u.slice(LOGO_CDN.length);
  return LOGO_FILE.test(file) ? file : null;
}

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
        ledgerRows(accountIds, `${span[0]}-01`),
        /* Split transactions are held back and counted one at a time below.
           This query collapses many transactions into one row per month,
           category and merchant, and a split is a fact about a single
           transaction — there is nothing left in a grouped row to apply it to.
           When nothing is split, which is nearly always, this excludes nothing
           and the second pass reads no rows. */
        notExists(
          db.select({ one: sql`1` }).from(transactionSplits).where(
            and(
              eq(transactionSplits.transactionId, transactions.id),
              eq(transactionSplits.userId, userId),
            ),
          ),
        ),
      ),
    )
    .groupBy(
      monthExpr, transactions.categoryPrimary, transactions.categoryDetailed,
      merchantExpr, transactionOverrides.categoryId,
    );

  /* One statement of what a month is made of, read by both passes. The grouped
     query arrives pre-summed and the split rows arrive one part at a time, but
     what either does to a month has to be the same thing or a split
     transaction would be counted by different rules than its neighbours. */
  const add = (b: MonthBucket, kind: string, slug: string | null,
               inCents: number, outCents: number) => {
    if (kind === "transfer") return;
    b.income += inCents;
    if (outCents > 0) {
      b.expense += outCents;
      // Spending can only land in a spending bucket. An expense filed under an
      // income category would otherwise stack as an "Income" bar in the chart,
      // and income belongs behind the bars as a level, never as one of them.
      const bucket = bucketFor(slug, "spend", ctx);
      b.byCategory[bucket] = (b.byCategory[bucket] ?? 0) + outCents;
    }
  };

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
    add(b, kind, slug, Number(r.inCents), Number(r.outCents));
  }

  /* The second pass: the transactions held back above, counted whole rather
     than grouped, so each of their parts can go where it belongs. */
  const splitWhere = ledgerRows(accountIds, `${span[0]}-01`);
  const splits = await loadSplits(db, userId, splitWhere);

  if (splits.size) {
    const splitRows = await db
      .select({
        ...rowFields,
        ym: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
      })
      .from(transactions)
      .leftJoin(
        transactionOverrides,
        and(
          eq(transactionOverrides.transactionId, transactions.id),
          eq(transactionOverrides.userId, userId),
        ),
      )
      .where(and(splitWhere, inArray(transactions.id, [...splits.keys()])));

    for (const r of splitRows) {
      const b = buckets.get(r.ym);
      if (!b) continue;
      for (const part of partsFor(r as AmountRow, splits)) {
        const { kind, slug } = resolveSlug(part.row, ctx);
        const cents = Number(part.amount);   // Plaid: positive is money leaving
        add(b, kind, slug, cents < 0 ? -cents : 0, cents > 0 ? cents : 0);
      }
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
  // Read-only and expensive: safe to serve from Hyperdrive's cache when a
  // caching binding exists. See getDb.
  const { db, ready, close } = getDb(c.env, { cached: true });
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

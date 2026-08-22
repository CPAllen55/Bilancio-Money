/**
 * What a month is expected to cost — the one calculation behind both the
 * forecast and the budget.
 *
 * Two things a flat average cannot give you:
 *
 *   Seasonality. December is not August. Last year's shape keeps the Christmas
 *   spike, the summer holiday, the annual insurance bill.
 *
 *   Trajectory. Last year's shape alone assumes nothing has changed. Scaling it
 *   by how this year is running against last year carries the change forward.
 *
 * So:  expected(month) = actual(same month last year) × growth
 * where growth = this year's total / last year's total, across the months where
 * both years have data.
 *
 * Growth is measured on COMPLETED months only. A month still in progress would
 * drag the ratio down early in the month and up at the end of it, and a budget
 * that moves depending on what day you look at it is not a budget.
 *
 * Where there is no prior year the method falls back to the average of the last
 * three months, and where there is not even that it says so rather than
 * dressing a guess up as a plan. A confident-looking projection of somebody's
 * savings, built on two months, is worse than none.
 *
 * A caveat worth knowing about using this as a budget: because growth is taken
 * from how this year is actually running, a year that is running hot lifts the
 * expected figure with it. Over a wide range the budget therefore drifts
 * towards the actual. Month to month it does not — the current month is priced
 * off completed history, so overspending it shows up as overspending.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { ownRates, scaleSpend } from "./seasonal-rates";
import { transactions } from "./db/schema";
import type { CategoryContext, MonthBucket } from "./summary-routes";
import { monthlyBuckets } from "./summary-routes";

export type PlanMethod = "seasonal-growth" | "recent-average" | "insufficient-data";

export interface MonthPlan {
  month: string;
  income: number;
  expense: number;
  /** Leaf category slugs, spending side only. */
  byCategory: Record<string, number>;
  /** True when this month's figure came from its own twin a year earlier. */
  seasonal: boolean;
}

export interface Plan {
  /**
   * The monthly figures this plan was built from.
   *
   * Exposed so callers can read history without running the same grouped scan
   * again. /api/summary was doing exactly that — buildPlan read two to four
   * years of months, and then the budget read twenty-four more of the same
   * rows for its averages. Two full passes over the transaction table on every
   * request, for one set of numbers.
   */
  buckets: Map<string, MonthBucket>;
  method: PlanMethod;
  growth: number;
  /** Growth as a percentage, so the front end never handles a bare multiplier. */
  growthPct: number | null;
  comparableMonths: number;
  monthsOfHistory: number;
  for(month: string): MonthPlan;
}

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The month history begins, and which day of it — enough to tell a whole month
 *  from the tail end of one. */
async function firstTransactionMonth(
  db: ReturnType<typeof getDb>["db"],
  accountIds: string[],
): Promise<{ month: string; day: number } | null> {
  if (!accountIds.length) return null;
  const rows = await db
    .select({ first: sql<string | null>`min(${transactions.date})::text` })
    .from(transactions)
    .where(and(inArray(transactions.accountId, accountIds), eq(transactions.pending, false)));

  const first = rows[0]?.first;
  return first ? { month: first.slice(0, 7), day: Number(first.slice(8, 10)) } : null;
}

/**
 * Builds the expectation for whichever months are asked about.
 *
 * `months` is the set that must be answerable — the two calendar years around
 * them are loaded, since every month is priced off its twin a year earlier.
 */
export async function buildPlan(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
  accountIds: string[],
  ctx: CategoryContext,
  months: string[],
  today: Date,
): Promise<Plan> {
  const thisYear = today.getUTCFullYear();
  const currentKey = ym(thisYear, today.getUTCMonth());

  const asked = months.map((m) => Number(m.slice(0, 4)));
  const years = new Set<number>([thisYear, thisYear - 1]);
  for (const y of asked) { years.add(y); years.add(y - 1); }

  const span: string[] = [];
  for (const y of Array.from(years).sort((a, b) => a - b)) {
    for (let m = 0; m < 12; m++) span.push(ym(y, m));
  }

  const [buckets, firstSeen] = await Promise.all([
    monthlyBuckets(db, userId, accountIds, ctx, span),
    firstTransactionMonth(db, accountIds),
  ]);
  const at = (key: string) =>
    buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };
  const priorOf = (key: string) => `${Number(key.slice(0, 4)) - 1}-${key.slice(5)}`;

  // The month a bank was first linked is almost never a whole month — Plaid
  // backfills from a date, not from the 1st. Averaging a ten-day stub in with
  // full months drags the expectation well below anything real, so the stub is
  // excluded from the basis entirely rather than half-counted.
  const stub = firstSeen && firstSeen.day > 1 ? firstSeen.month : null;
  const usable = (k: string) => k !== stub;

  // Completed months of the current year, most recent last.
  const completed = span
    .filter((k) => k.startsWith(String(thisYear)) && k < currentKey)
    .filter(usable);

  // Months where both years hold real numbers — the only honest basis for a
  // growth rate. A month with no prior-year twin says nothing about trend.
  /* Everything below is computed from the months BEFORE the one being asked
     about, not from everything known today.

     A month that has ended should stop moving. Priced off all available
     history, last March's expectation changes every time April through August
     arrive — so a figure you were judged against in April reads differently in
     August, and nobody can tell whether they did well. Asking only what was
     known before the month began fixes the answer for good, and for the current
     month it is the same arithmetic as before because there is nothing later to
     exclude.

     Memoised per month: the same month is asked about repeatedly across a
     range, and the buckets are already in memory, so this is arithmetic rather
     than another read. */
  const basisCache = new Map<string, Basis>();

  interface Basis {
    hasSeasonal: boolean;
    growth: number;
    /** Year-on-year rate for the categories that have earned their own. */
    ownRate: Record<string, number>;
    comparableMonths: number;
    recentExpense: number;
    recentIncome: number;
    recentShape: Record<string, number>;
  }

  function basisBefore(month: string): Basis {
    const hit = basisCache.get(month);
    if (hit) return hit;

    const known = completed.filter((k) => k < month);

    const comparable = known.filter((k) => at(k).expense > 0 && at(priorOf(k)).expense > 0);
    const thisYearSum = comparable.reduce((s, k) => s + at(k).expense, 0);
    const priorSum = comparable.reduce((s, k) => s + at(priorOf(k)).expense, 0);
    const hasSeasonal = comparable.length >= 2 && priorSum > 0;

    // A rate per category, from the months where that category itself has
    // something to compare. Categories do not move together — the ledger can
    // rise while groceries fall — and one rate for all of them projects the
    // ledger's story onto every line in it.
    const seen = new Set<string>();
    for (const k of comparable) {
      for (const side of [at(k).byCategory, at(priorOf(k)).byCategory]) {
        for (const [slug, v] of Object.entries(side)) {
          if (v > 0 && ctx.kindOfSlug.get(slug) === "spend") seen.add(slug);
        }
      }
    }
    const ownRate = ownRates(
      comparable, (slug, m) => at(m).byCategory[slug] ?? 0, priorOf, seen);

    const recent = known.filter((k) => at(k).expense > 0).slice(-3);
    const recentShape: Record<string, number> = {};
    if (recent.length) {
      for (const k of recent) {
        for (const [slug, v] of Object.entries(at(k).byCategory)) {
          if (!v || ctx.kindOfSlug.get(slug) !== "spend") continue;
          recentShape[slug] = (recentShape[slug] ?? 0) + v;
        }
      }
      for (const slug of Object.keys(recentShape)) {
        recentShape[slug] = Math.round(recentShape[slug] / recent.length);
      }
    }

    const basis: Basis = {
      hasSeasonal,
      growth: hasSeasonal ? thisYearSum / priorSum : 1,
      ownRate,
      comparableMonths: comparable.length,
      recentExpense: mean(recent.map((k) => at(k).expense)),
      recentIncome: mean(known.slice(-3).map((k) => at(k).income).filter((v) => v > 0)),
      recentShape,
    };
    basisCache.set(month, basis);
    return basis;
  }

  // The headline figures describe the position as of now — the basis for the
  // current month, since every completed month is by definition before it.
  const now = basisBefore(currentKey);
  const hasSeasonal = now.hasSeasonal;
  const growth = now.growth;
  const recentExpense = now.recentExpense;

  const method: PlanMethod = hasSeasonal
    ? "seasonal-growth"
    : recentExpense > 0
      ? "recent-average"
      : "insufficient-data";

  return {
    buckets,
    method,
    growth,
    growthPct: hasSeasonal ? Math.round((growth - 1) * 1000) / 10 : null,
    comparableMonths: now.comparableMonths,
    monthsOfHistory: completed.filter((k) => at(k).expense > 0).length,

    for(month: string): MonthPlan {
      const b = basisBefore(month);
      const priorKey = priorOf(month);
      const prior = at(priorKey);
      // Same reasoning as above: a partial month is no basis for its twin a
      // year later either.
      const seasonal = b.hasSeasonal && prior.expense > 0 && usable(priorKey);

      if (seasonal) {
        const byCategory = scaleSpend(prior.byCategory, b.growth, b.ownRate,
          (slug) => ctx.kindOfSlug.get(slug) === "spend");
        // Summed from the parts rather than scaled on its own, or the total
        // would disagree with the categories underneath it the moment they
        // stopped all moving at the same rate.
        const expense = Object.values(byCategory).reduce((s, v) => s + v, 0);
        return {
          month, seasonal: true,
          expense,
          income: prior.income > 0 ? Math.round(prior.income * b.growth) : Math.round(b.recentIncome),
          byCategory,
        };
      }

      return {
        month, seasonal: false,
        expense: Math.round(b.recentExpense),
        income: Math.round(b.recentIncome),
        byCategory: { ...b.recentShape },
      };
    },
  };
}

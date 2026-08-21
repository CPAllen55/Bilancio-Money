/**
 * How a category's budget is arrived at.
 *
 * Every method answers the same question — what should this category cost in a
 * given month — and they differ only in which history they trust:
 *
 *   average   A typical month, with the best and worst set aside. The right
 *             answer for anything steady, and wrong for anything seasonal.
 *             The default, and what an unset category falls back to.
 *   previous  Last completed month, repeated. Blunt, and exactly what people
 *             mean when they say "same as last month".
 *   seasonal  The same month a year ago, scaled by this year's trend. The only
 *             method that expects December to cost more than August.
 *   manual    A number you typed.
 *   none      Not budgeted. Zero, deliberately, which is not the same as having
 *             no history to work from.
 *
 * OUTLIERS. Average trims the highest and lowest month before taking the mean,
 * so one holiday or one insurance bill does not become the plan for every month
 * after it. Seasonal does the opposite on purpose: it reads the actual month a
 * year earlier, spike included, because in a seasonal category the spike IS the
 * signal and smoothing it away is how you end up under-budgeting December every
 * year.
 *
 * INHERITANCE. A method set on a parent applies to its children unless a child
 * says otherwise — the same override-beats-inherited shape the categories
 * themselves use. Budgets are always computed at the leaf and rolled up, so a
 * parent's figure is the sum of its children and cannot drift from them.
 *
 * A manual amount on a PARENT is the exception, and it is split across the
 * children in proportion to what they have actually cost. "Food should be $800"
 * is a statement about Food, and dividing it by how you really spend is the
 * only reading that keeps the parent equal to its parts.
 */

import { getDb } from "./db/client";
import type { CategoryContext } from "./summary-routes";
import type { Plan } from "./projection";
import { budgetPlans } from "./db/schema";
import { eq } from "drizzle-orm";

export const METHODS = ["average", "previous", "seasonal", "manual", "none"] as const;
export type Method = (typeof METHODS)[number];

export const isMethod = (v: unknown): v is Method =>
  typeof v === "string" && (METHODS as readonly string[]).includes(v);

export interface PlanRow {
  categoryId: string;
  method: Method;
  manualAmount: number;
}

/** What the front end needs to draw the Budgeting tab. */
export interface ResolvedPlan {
  slug: string;
  /** The method actually in force. */
  method: Method;
  /** True when that method came from the parent rather than from this row. */
  inherited: boolean;
  manualAmount: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * A typical month, with the extremes set aside.
 *
 * Four months is the least that can lose two and still say anything, so below
 * that it is a plain mean and the caller is not pretending otherwise.
 */
export function trimmedMean(values: number[]): number {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (xs.length < 4) return mean(xs);
  return mean(xs.slice(1, -1));
}

export async function loadPlanRows(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<Map<string, PlanRow>> {
  const rows = await db
    .select({
      categoryId: budgetPlans.categoryId,
      method: budgetPlans.method,
      manualAmount: budgetPlans.manualAmount,
    })
    .from(budgetPlans)
    .where(eq(budgetPlans.userId, userId));

  const out = new Map<string, PlanRow>();
  for (const r of rows) {
    if (!isMethod(r.method)) continue; // a method we no longer offer
    out.set(r.categoryId, { categoryId: r.categoryId, method: r.method, manualAmount: r.manualAmount });
  }
  return out;
}

/** Own row, then the parent's, then the default. */
export function resolveMethod(
  slug: string,
  ctx: CategoryContext,
  rows: Map<string, PlanRow>,
): { method: Method; inherited: boolean; manualAmount: number; from: string } {
  const id = ctx.list.find((c) => c.slug === slug)?.id;
  const own = id ? rows.get(id) : undefined;
  if (own) return { method: own.method, inherited: false, manualAmount: own.manualAmount, from: slug };

  const parentSlug = ctx.list.find((c) => c.slug === slug)?.parentSlug;
  if (parentSlug) {
    const pid = ctx.list.find((c) => c.slug === parentSlug)?.id;
    const p = pid ? rows.get(pid) : undefined;
    if (p) return { method: p.method, inherited: true, manualAmount: p.manualAmount, from: parentSlug };
  }
  return { method: "average", inherited: true, manualAmount: 0, from: "default" };
}

export interface HistoryLookup {
  /** Actual spend for a leaf slug in a month, in cents. */
  at(slug: string, month: string): number;
  /** Completed months with any spending, oldest first. */
  completed: string[];
  /** The most recent completed month, or null. */
  lastComplete: string | null;
  /**
   * Completed months strictly before the given one.
   *
   * A budget for a month that has ended must not move when later months arrive,
   * or the figure somebody was judged against in April reads differently in
   * August. Every method reads through this rather than the whole list.
   */
  before(month: string): string[];
}

/**
 * The budget for one leaf category in one month.
 *
 * Returns null where the method cannot answer — no history to average, no prior
 * year to be seasonal about. Null is not zero: one means "nothing to go on" and
 * the other means "nothing is planned", and the UI says different things.
 */
export function budgetForLeaf(
  slug: string,
  month: string,
  method: Method,
  manualAmount: number,
  history: HistoryLookup,
  plan: Plan,
): number | null {
  switch (method) {
    case "none":
      return 0;

    case "manual":
      return manualAmount;

    case "previous": {
      const known = history.before(month);
      if (!known.length) return null;
      return Math.round(history.at(slug, known[known.length - 1]));
    }

    case "seasonal": {
      const expected = plan.for(month).byCategory[slug];
      // plan.for falls back to a recent average when it has no prior year, and
      // that is not what "seasonal" was asked for — but it is the honest best
      // available, and the front end says which basis is in use.
      return expected != null ? Math.round(expected) : null;
    }

    // Last, because it is also where anything unrecognised lands — including an
    // "auto" row written before that method was removed and not yet migrated.
    case "average":
    default: {
      const t = trimmedMean(history.before(month).map((m) => history.at(slug, m)));
      return t > 0 ? Math.round(t) : null;
    }
  }
}

/**
 * Splits a parent's manual amount across its children by what they actually
 * cost, so the parts still add to the whole.
 *
 * With no history to divide by it splits evenly — arbitrary, but every other
 * answer is arbitrary too and this one at least sums correctly.
 */
export function shareOut(
  amount: number,
  children: string[],
  weights: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!children.length) return out;

  const total = children.reduce((s, c) => s + (weights.get(c) ?? 0), 0);
  if (total <= 0) {
    const each = Math.round(amount / children.length);
    children.forEach((c, i) => out.set(c, i === children.length - 1
      ? amount - each * (children.length - 1)   // the remainder lands on the last
      : each));
    return out;
  }

  let assigned = 0;
  children.forEach((c, i) => {
    if (i === children.length - 1) { out.set(c, amount - assigned); return; }
    const v = Math.round(amount * ((weights.get(c) ?? 0) / total));
    out.set(c, v);
    assigned += v;
  });
  return out;
}

export interface CategoryLike {
  slug: string;
  parentSlug: string | null;
  kind: string;
}

export interface MonthlyBudget {
  /** month -> leaf slug -> cents */
  byMonth: Map<string, Record<string, number>>;
  /** Leaves whose method could not produce a figure for any month. */
  unplanned: string[];
}

/**
 * The budget for every leaf, month by month.
 *
 * Kept per month rather than summed, because two callers want different things
 * from it: the Tracker adds the months up to judge a window, and the Trend
 * chart draws one bar per month. Summing first and dividing back would smear a
 * seasonal December across the autumn, which is the one thing the seasonal
 * method exists to avoid.
 *
 * Pure — the database work happens above it, so the arithmetic can be tested
 * without one.
 */
export function computeBudgets(
  categories: CategoryLike[],
  months: string[],
  planRows: Map<string, PlanRow>,
  history: HistoryLookup,
  plan: Plan,
  ctx: CategoryContext,
): MonthlyBudget {
  const leaves = categories.filter((c) => c.parentSlug && c.kind === "spend");
  const parents = categories.filter((c) => !c.parentSlug && c.kind === "spend");

  // What each leaf has cost lately, for dividing a parent's manual amount.
  const weight = new Map<string, number>();
  const recent = history.completed.slice(-3);
  for (const leaf of leaves) {
    weight.set(leaf.slug, recent.reduce((s, m) => s + history.at(leaf.slug, m), 0));
  }

  const byMonth = new Map<string, Record<string, number>>();
  for (const m of months) byMonth.set(m, {});
  const unplanned = new Set<string>();

  for (const parent of parents) {
    const kids = leaves.filter((c) => c.parentSlug === parent.slug);
    const own = resolveMethod(parent.slug, ctx, planRows);

    // A manual figure on a parent is per month, and is divided among the
    // children so the parts still add to the whole.
    if (own.method === "manual" && !own.inherited && kids.length) {
      const share = shareOut(own.manualAmount, kids.map((k) => k.slug), weight);
      for (const month of months) {
        const row = byMonth.get(month)!;
        for (const k of kids) row[k.slug] = share.get(k.slug) ?? 0;
      }
      continue;
    }

    for (const kid of kids) {
      const m = resolveMethod(kid.slug, ctx, planRows);
      let known = false;
      for (const month of months) {
        const v = budgetForLeaf(kid.slug, month, m.method, m.manualAmount, history, plan);
        if (v === null) continue;
        known = true;
        byMonth.get(month)![kid.slug] = v;
      }
      if (!known) unplanned.add(kid.slug);
    }

    // A parent holding spending of its own rather than only children.
    if (!kids.length) {
      const m = resolveMethod(parent.slug, ctx, planRows);
      for (const month of months) {
        const v = budgetForLeaf(parent.slug, month, m.method, m.manualAmount, history, plan);
        if (v !== null) byMonth.get(month)![parent.slug] = v;
      }
    }
  }

  return { byMonth, unplanned: [...unplanned] };
}

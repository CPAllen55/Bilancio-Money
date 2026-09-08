/**
 * The plan, in one place, so every tab is reading the same one.
 *
 * Budgeting shapes each category from history and lets the reader move it.
 * Overview, the Tracker and the Trend forecast then have to agree with that,
 * and the only reliable way to make four dashboards agree is for them to run
 * the same code rather than four faithful reimplementations of it.
 *
 * Deliberately free of database access beyond loading the overrides: the
 * buckets are passed in. summary-routes owns monthlyBuckets and this module is
 * used by summary-routes, so anything else would be an import cycle.
 */

import { eq } from "drizzle-orm";
import type { getDb } from "./db/client";
import { budgetPlansV2 } from "./db/schema";
import { shapeBudget, type Shape } from "./budget-shape";
import { planSubcategory, type SubPlan, type MerchantHistory } from "./budget-engine";

type Db = ReturnType<typeof getDb>["db"];

export interface Override { baseline: number; byMonth: Record<string, number> }

/**
 * Per-category edits, keyed by category id.
 *
 * budget_plans_v2 repurposed: manualAmount is the baseline override and
 * manualByMonth the pinned months. The method column is vestigial — there is
 * one method now — and is left in place because dropping a column is a
 * migration and ignoring one costs nothing.
 */
export async function loadOverrides(db: Db, userId: string): Promise<Map<string, Override>> {
  const rows = await db
    .select({
      categoryId: budgetPlansV2.categoryId,
      manualAmount: budgetPlansV2.manualAmount,
      manualByMonth: budgetPlansV2.manualByMonth,
    })
    .from(budgetPlansV2)
    .where(eq(budgetPlansV2.userId, userId));

  const out = new Map<string, Override>();
  for (const r of rows) {
    out.set(r.categoryId, {
      baseline: Number(r.manualAmount) || 0,
      byMonth: (r.manualByMonth ?? {}) as Record<string, number>,
    });
  }
  return out;
}

/**
 * The shape, with the reader's own hand applied over it.
 *
 * The override REPLACES. A typed figure is the figure.
 *
 * It used to scale: a baseline of 430 against a shape whose baseline was 480
 * multiplied every month by 0.896, on the reasoning that the reader had said
 * "about a tenth less" rather than "every month is 430", and that December
 * should still be December.
 *
 * That is a defensible reading and it produced an indefensible result. Typing
 * 900 into Groceries and getting a budget of 1,001 is not a nuance, it is the
 * page ignoring the reader — and the discrepancy grew with whatever seasonal
 * shape happened to be fitted underneath, so the same number meant different
 * things in different categories. Worse, the scale was recomputed from live
 * history: as the shape's own baseline moved, the stored figure silently
 * changed meaning.
 *
 * A month override was always absolute, because that is what naming one month
 * means. Now the baseline is too, and both say the same thing: what you typed
 * is what you get. December is still available — pin December.
 */
export function applyOverride(
  shape: Shape,
  months: string[],
  over: Override | undefined,
): Record<string, number> {
  const plan: Record<string, number> = {};
  for (const m of months) {
    const pinned = over?.byMonth?.[m];
    plan[m] = pinned !== undefined && pinned !== null
      ? Math.max(0, Math.round(pinned))
      : over && over.baseline > 0
        ? Math.max(0, Math.round(over.baseline))
        : Math.max(0, Math.round(shape.plan[m] ?? 0));
  }
  return plan;
}

/** Two calendar years back from today, stopping at the last complete month. */
export function learnWindow(today: Date): { learn: string[]; currentKey: string } {
  const year = today.getUTCFullYear();
  const currentKey = `${year}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const learn: string[] = [];
  for (let y = year - 2; y <= year; y++) {
    for (let m = 0; m < 12; m++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      // A month still running is partial, and a partial month taken as evidence
      // drags every baseline down.
      if (key < currentKey) learn.push(key);
    }
  }
  return { learn, currentKey };
}

export interface Planned {
  /** slug -> month -> cents, leaves only. */
  byCategory: Record<string, Record<string, number>>;
  /** month -> cents. */
  income: Record<string, number>;
  /** slug -> the whole working, for anything that wants to explain itself. */
  subPlans: Map<string, SubPlan>;
  incomeShape: Shape;
  monthsOfHistory: number;
}

interface CategoryLike {
  id: string; slug: string; parentSlug: string | null; kind: string;
}
interface BucketLike {
  income: number;
  byCategory: Record<string, number>;
  byMerchant?: Record<string, Record<string, { cents: number; charges: number }>>;
}

/**
 * Every leaf planned and edited, plus income, for the months asked for.
 *
 * Spending goes through budget-engine.ts, which splits each subcategory into
 * the merchants that bill every month and the variable spending left over.
 *
 * Income does not, and stays on the older shapeBudget: monthlyBuckets files
 * income as a monthly total with no merchant behind it, so there is nothing
 * for the engine to read — and for a budget "what comes in" is the right
 * grain anyway, rather than which of two employers it came from.
 */
export function buildShapedPlan(
  categories: CategoryLike[],
  buckets: Map<string, BucketLike>,
  learn: string[],
  months: string[],
  overrides: Map<string, Override>,
  /* Printable merchant names, from monthlyBuckets. Only the readout needs
     them, so a caller that is not going to show its working can leave them
     out and get merchant keys instead of spellings. */
  names: Map<string, string> = new Map(),
): Planned {
  const byCategory: Record<string, Record<string, number>> = {};
  const subPlans = new Map<string, SubPlan>();

  for (const cat of categories) {
    if (!cat.parentSlug || cat.kind !== "spend") continue;   // leaves only

    const totals = learn.map((m) => buckets.get(m)?.byCategory[cat.slug] ?? 0);
    /* This subcategory's merchants, month by month. A month with no spending
       here still gets an entry, because "billed in four of the last six" has
       to be able to count the two it missed. */
    const merchants: MerchantHistory = new Map(
      learn.map((m) => [m, buckets.get(m)?.byMerchant?.[cat.slug] ?? {}]),
    );

    const over = overrides.get(cat.id);
    const sub = planSubcategory(
      cat.slug, totals, merchants, names, learn, months,
      over && over.baseline > 0 ? over.baseline : undefined,
    );
    subPlans.set(cat.slug, sub);

    /* A pinned month beats everything, including the baseline the reader
       typed: naming one month is the more specific statement of the two. */
    const plan: Record<string, number> = {};
    for (const m of months) {
      const pinned = over?.byMonth?.[m];
      plan[m] = pinned !== undefined && pinned !== null
        ? Math.max(0, Math.round(pinned))
        : sub.plan[m] ?? 0;
    }
    byCategory[cat.slug] = plan;
  }

  const incomeShape = shapeBudget(
    learn.map((m) => ({ month: m, amount: buckets.get(m)?.income ?? 0 })),
    months,
  );
  const incomeCat = categories.find((c) => c.slug === "income" && !c.parentSlug);
  const income = applyOverride(
    incomeShape, months, incomeCat ? overrides.get(incomeCat.id) : undefined,
  );

  return { byCategory, income, subPlans, incomeShape, monthsOfHistory: learn.length };
}

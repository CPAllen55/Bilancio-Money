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
 * A baseline override SCALES rather than replaces, so the year keeps the shape
 * history gave it: somebody who takes groceries from 480 to 430 has said "about
 * a tenth less", not "every month is 430", and December should still be
 * December. A month override is absolute, because that is what naming one
 * month means.
 */
export function applyOverride(
  shape: Shape,
  months: string[],
  over: Override | undefined,
): Record<string, number> {
  const plan: Record<string, number> = {};
  const scale = over && over.baseline > 0 && shape.baseline > 0
    ? over.baseline / shape.baseline : 1;

  for (const m of months) {
    const pinned = over?.byMonth?.[m];
    plan[m] = pinned !== undefined && pinned !== null
      ? Math.max(0, Math.round(pinned))
      : Math.max(0, Math.round((shape.plan[m] ?? 0) * scale));
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
  /** slug -> the unedited shape, for anything that wants to explain itself. */
  shapes: Map<string, Shape>;
  incomeShape: Shape;
  monthsOfHistory: number;
}

interface CategoryLike {
  id: string; slug: string; parentSlug: string | null; kind: string;
}
interface BucketLike { income: number; byCategory: Record<string, number> }

/**
 * Every leaf shaped and edited, plus income, for the months asked for.
 *
 * Income is one line rather than a breakdown, because monthlyBuckets keeps
 * income as a monthly total — and for a budget that is the right grain anyway.
 */
export function buildShapedPlan(
  categories: CategoryLike[],
  buckets: Map<string, BucketLike>,
  learn: string[],
  months: string[],
  overrides: Map<string, Override>,
): Planned {
  const history = (slug: string) =>
    learn.map((m) => ({ month: m, amount: buckets.get(m)?.byCategory[slug] ?? 0 }));

  const byCategory: Record<string, Record<string, number>> = {};
  const shapes = new Map<string, Shape>();

  for (const cat of categories) {
    if (!cat.parentSlug || cat.kind !== "spend") continue;   // leaves only
    const shape = shapeBudget(history(cat.slug), months);
    shapes.set(cat.slug, shape);
    byCategory[cat.slug] = applyOverride(shape, months, overrides.get(cat.id));
  }

  const incomeShape = shapeBudget(
    learn.map((m) => ({ month: m, amount: buckets.get(m)?.income ?? 0 })),
    months,
  );
  const incomeCat = categories.find((c) => c.slug === "income" && !c.parentSlug);
  const income = applyOverride(
    incomeShape, months, incomeCat ? overrides.get(incomeCat.id) : undefined,
  );

  return { byCategory, income, shapes, incomeShape, monthsOfHistory: learn.length };
}

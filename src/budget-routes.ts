/**
 * /api/budget — the plan, and the room in it.
 *
 * One method, from src/budget-shape.ts, applied to every category and to
 * income. No menu: the three questions a menu used to ask (what is normal,
 * where is it heading, what shape does the year have) are answered together
 * and multiplied, so there is nothing left to choose between.
 *
 * What there IS to choose is the plan itself. Everything here is a starting
 * point derived from history, and every figure can be overridden — a whole
 * category at once by moving its baseline, or a single month for the holiday
 * that is already booked. The savings line is planned income minus planned
 * spending, and it moves the moment either does. That number is the point of
 * the page.
 *
 * ── Storage ───────────────────────────────────────────────────────────────
 *
 * budget_plans_v2, repurposed rather than replaced, because it already holds
 * exactly the two shapes needed and adding a third budget table to a schema
 * that has two would be worse than reusing one:
 *
 *   manualAmount   -> the baseline override. Zero means "no override, use what
 *                     history says", which is why a deliberate zero baseline is
 *                     expressed as a month-by-month override instead.
 *   manualByMonth  -> per-month overrides, keyed "YYYY-MM".
 *   method         -> vestigial. There is one method now. Left in place because
 *                     dropping a column is a migration and this costs nothing.
 *
 * ── What this does NOT yet drive ──────────────────────────────────────────
 *
 * The Overview tiles, the Tracker and the Trend budget line still derive their
 * figures the old way, through budgetFor in summary-routes. Switching them is
 * the obvious next step and is deliberately not bundled here: it changes four
 * dashboards at once, and doing that in the same commit that introduces a new
 * forecasting engine would make any disagreement impossible to attribute.
 * Until then the two will differ, and the Budgeting tab says so.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetPlansV2 } from "./db/schema";
import { requireUser } from "./auth";
import { loadCategories, monthlyBuckets, ownedAccountIds } from "./summary-routes";
import { shapeBudget, type Shape } from "./budget-shape";

const budget = new Hono<{ Bindings: Env }>();

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;

/** The calendar year being planned, and the two before it to learn from. */
function windows(today: Date) {
  const year = today.getUTCFullYear();
  const plan: string[] = [];
  for (let m = 0; m < 12; m++) plan.push(ym(year, m));

  const learn: string[] = [];
  for (let y = year - 2; y <= year; y++) for (let m = 0; m < 12; m++) learn.push(ym(y, m));

  // A month still running has partial spending in it, and a partial month
  // taken as evidence drags every baseline down. History stops at the last
  // complete one; the current month is planned, not learned from.
  const currentKey = ym(year, today.getUTCMonth());
  return { plan, learn: learn.filter((k) => k < currentKey), currentKey };
}

export interface Override { baseline: number; byMonth: Record<string, number> }

async function loadOverrides(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<Map<string, Override>> {
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
 * history gave it. Somebody who takes groceries from £480 to £430 has not said
 * every month is £430 — they have said "about a tenth less", and December
 * should still be December. Replacing the figure flat would quietly delete the
 * seasonality they never asked to lose.
 *
 * A month override is absolute, because that is what naming one month means.
 */
export function applyOverride(shape: Shape, months: string[], over: Override | undefined) {
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

budget.get("/budget", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const today = new Date();
    const { plan: planMonths, learn, currentKey } = windows(today);

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, "all", true),
    ]);

    const [buckets, overrides] = await Promise.all([
      monthlyBuckets(db, auth.user.id, ids, ctx, learn),
      loadOverrides(db, auth.user.id),
    ]);

    const history = (slug: string) =>
      learn.map((m) => ({ month: m, amount: buckets.get(m)?.byCategory[slug] ?? 0 }));

    /* Only leaves are planned. A parent's figure is the sum of its children,
       which is the only way the parts can be edited and the whole stay true. */
    const leaves = ctx.list.filter((cat) => cat.parentSlug && cat.kind === "spend");

    const rows = leaves.map((cat) => {
      const shape = shapeBudget(history(cat.slug), planMonths);
      const over = overrides.get(cat.id);
      const spent = Object.fromEntries(
        learn.filter((m) => planMonths.includes(m))
          .map((m) => [m, buckets.get(m)?.byCategory[cat.slug] ?? 0]),
      );
      return {
        id: cat.id, slug: cat.slug, label: cat.label, colour: cat.colour,
        parentSlug: cat.parentSlug,
        spent,
        // Before the reader's edits, so a Reset has something to go back to.
        computed: shape.plan,
        plan: applyOverride(shape, planMonths, over),
        baseline: shape.baseline,
        baselineOverride: over && over.baseline > 0 ? over.baseline : null,
        pinned: over?.byMonth ?? {},
        irregularPerMonth: shape.irregularPerMonth,
        outliers: shape.outliers,
        seasonal: shape.seasonal,
        basis: shape.basis,
        monthsUsed: shape.monthsUsed,
      };
    });

    /* Income is one line rather than a breakdown. monthlyBuckets files spending
       by category and keeps income only as a monthly total, and for a budget
       that is the right grain anyway — the question is what comes in, not which
       of two employers it came from. It gets the same treatment as everything
       else, so a December bonus that lands two years running shows up as a
       December that plans higher. */
    const incomeShape = shapeBudget(
      learn.map((m) => ({ month: m, amount: buckets.get(m)?.income ?? 0 })),
      planMonths,
    );
    const incomeCat = ctx.list.find((cat) => cat.slug === "income" && !cat.parentSlug);
    const incomeOver = incomeCat ? overrides.get(incomeCat.id) : undefined;
    const incomePlan = applyOverride(incomeShape, planMonths, incomeOver);

    const expenseByMonth: Record<string, number> = {};
    for (const m of planMonths) {
      expenseByMonth[m] = rows.reduce((s, r) => s + (r.plan[m] ?? 0), 0);
    }
    const savingsByMonth = Object.fromEntries(
      planMonths.map((m) => [m, (incomePlan[m] ?? 0) - expenseByMonth[m]]),
    );
    const annual = planMonths.reduce((s, m) => s + savingsByMonth[m], 0);

    return c.json({
      ok: true,
      months: planMonths,
      labels: planMonths.map((m) => MONTH_LABELS[Number(m.slice(5, 7)) - 1]),
      currentMonth: currentKey,
      monthsOfHistory: learn.length,
      categories: rows,
      income: {
        id: incomeCat?.id ?? null,
        plan: incomePlan,
        computed: incomeShape.plan,
        baseline: incomeShape.baseline,
        baselineOverride: incomeOver && incomeOver.baseline > 0 ? incomeOver.baseline : null,
        pinned: incomeOver?.byMonth ?? {},
        spent: Object.fromEntries(
          learn.filter((m) => planMonths.includes(m))
            .map((m) => [m, buckets.get(m)?.income ?? 0]),
        ),
        basis: incomeShape.basis,
      },
      totals: { expense: expenseByMonth, savings: savingsByMonth },
      savings: { annual, monthly: Math.round(annual / 12) },
      // Named so the front end can say it rather than implying agreement that
      // does not exist yet.
      drivesOtherTabs: false,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * PUT /api/budget — one edit at a time.
 *
 *   { slug, baseline: 43000 }            move a whole category
 *   { slug, baseline: null }             back to what history says
 *   { slug, month: "2026-05", amount }   pin one month
 *   { slug, month: "2026-05", amount: null }   unpin it
 */
budget.put("/budget", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let body: any;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }

    if (typeof body?.slug !== "string") {
      return c.json({ error: "bad_request", message: "Expected a category." }, 400);
    }

    const ctx = await loadCategories(db, auth.user.id);
    const cat = ctx.list.find((x) => x.slug === body.slug);
    if (!cat) return c.json({ error: "not_found", message: "No such category." }, 404);

    const [existing] = await db
      .select()
      .from(budgetPlansV2)
      .where(and(eq(budgetPlansV2.userId, auth.user.id), eq(budgetPlansV2.categoryId, cat.id)));

    let baseline = existing ? Number(existing.manualAmount) || 0 : 0;
    const byMonth: Record<string, number> =
      (existing?.manualByMonth as Record<string, number>) ?? {};

    if ("baseline" in body) {
      if (body.baseline === null) baseline = 0;
      else {
        const n = Number(body.baseline);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000_00) {
          return c.json({ error: "bad_request", message: "That amount is out of range." }, 400);
        }
        baseline = Math.round(n);
      }
    }

    if ("month" in body) {
      if (!/^\d{4}-\d{2}$/.test(String(body.month))) {
        return c.json({ error: "bad_request", message: "That is not a month." }, 400);
      }
      if (body.amount === null) delete byMonth[body.month];
      else {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000_00) {
          return c.json({ error: "bad_request", message: "That amount is out of range." }, 400);
        }
        byMonth[body.month] = Math.round(n);
      }
    }

    await db
      .insert(budgetPlansV2)
      .values({
        userId: auth.user.id, categoryId: cat.id,
        method: "shaped", manualAmount: baseline, manualByMonth: byMonth,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [budgetPlansV2.userId, budgetPlansV2.categoryId],
        set: { manualAmount: baseline, manualByMonth: byMonth, updatedAt: new Date() },
      });

    return c.json({ ok: true, slug: cat.slug, baseline: baseline || null, byMonth });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default budget;

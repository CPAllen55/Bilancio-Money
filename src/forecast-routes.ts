/**
 * /api/forecast — the rest of the year at the budget.
 *
 * The months ahead are the budget, category by category, not a second guess at
 * them. It used to be a projection of its own, which meant two different
 * answers to "what will next month cost" — and the budget is the one somebody
 * actually chose, while the forecast was only ever guessing at what the budget
 * now states outright.
 *
 * Income keeps the projection, because income has no budget to read.
 *
 * What stays here is what is particular to drawing a year: rolling categories
 * up to their parents for the stacked bars, and treating the current month's
 * actual spending as a floor. Showing less than has demonstrably happened would
 * be nonsense, and going past the budget is the thing most worth seeing.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { requireUser } from "./auth";
import { loadCategories, monthlyBuckets, ownedAccountIds, rollUp } from "./summary-routes";
import { buildPlan } from "./projection";
import type { HistoryLookup } from "./budget-plan";
import { computeBudgets, loadPlanRows } from "./budget-plan";

const forecast = new Hono<{ Bindings: Env }>();

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;

forecast.get("/forecast", async (c) => {
  // Read-only and expensive: safe to serve from Hyperdrive's cache when a
  // caching binding exists. See getDb.
  const { db, ready, close } = getDb(c.env, { cached: true });
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const account = c.req.query("account") ?? "all";
    const today = new Date();
    const year = Number(c.req.query("year") ?? today.getUTCFullYear());
    const currentKey = ym(today.getUTCFullYear(), today.getUTCMonth());

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, true),
    ]);

    const thisYearKeys: string[] = [];
    for (let m = 0; m < 12; m++) thisYearKeys.push(ym(year, m));

    // The plan loads the surrounding years itself; the actuals are read again
    // here because the past months of the chart are what happened, not what was
    // expected to happen.
    const [plan, buckets, planRows] = await Promise.all([
      buildPlan(db, auth.user.id, ids, ctx, thisYearKeys, today),
      monthlyBuckets(db, auth.user.id, ids, ctx, thisYearKeys),
      loadPlanRows(db, auth.user.id),
    ]);
    const at = (key: string) =>
      buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };

    // The months ahead are drawn from the budget rather than from a separate
    // projection. Two different numbers for "what will next month cost" is one
    // too many, and the budget is the one somebody chose — the forecast was
    // only ever guessing at what the budget now states.
    const history: HistoryLookup = (() => {
      const hb = plan.buckets;
      const hAt = (slug: string, month: string) => hb.get(month)?.byCategory[slug] ?? 0;
      const completed = [...hb.keys()].sort()
        .filter((k) => k < currentKey && (hb.get(k)?.expense ?? 0) > 0);
      return {
        at: hAt, completed,
        lastComplete: completed.length ? completed[completed.length - 1] : null,
        before: (month) => completed.filter((k) => k < month),
      };
    })();

    const monthsAhead = thisYearKeys.filter((k) => k >= currentKey);
    const budgets = computeBudgets(ctx.list, monthsAhead, planRows, history, plan, ctx);

    const months = thisYearKeys.map((key) => {
      const actual = at(key);
      const actualByParent = rollUp(actual.byCategory, ctx);

      if (key < currentKey) {
        return {
          month: key, projected: false,
          income: actual.income, expense: actual.expense,
          net: actual.income - actual.expense,
          byParent: actualByParent,
          actualSoFar: null as { income: number; expense: number } | null,
        };
      }

      const planned = budgets.byMonth.get(key) ?? {};
      const plannedExpense = Object.values(planned).reduce((s, v) => s + v, 0);

      // The current month already has spending in it. Showing less than has
      // demonstrably happened would be nonsense, so what happened is a floor —
      // and going past the budget is exactly the thing worth seeing.
      const isCurrent = key === currentKey;
      const expense = Math.max(plannedExpense, isCurrent ? actual.expense : 0);
      // Income has no budget of its own, so it stays on the projection.
      const income = Math.max(plan.for(key).income, isCurrent ? actual.income : 0);

      return {
        month: key, projected: true,
        income, expense,
        net: income - expense,
        byParent: isCurrent && actual.expense > plannedExpense
          ? actualByParent
          : rollUp(planned, ctx),
        actualSoFar: isCurrent ? { income: actual.income, expense: actual.expense } : null,
      };
    });

    const sum = (rows: typeof months, field: "income" | "expense" | "net") =>
      rows.reduce((s, r) => s + r[field], 0);
    const past = months.filter((m) => !m.projected);
    const ahead = months.filter((m) => m.projected);

    return c.json({
      ok: true,
      year,
      method: plan.method,
      growthPct: plan.growthPct,
      basis: {
        comparableMonths: plan.comparableMonths,
        monthsOfHistory: plan.monthsOfHistory,
        usesPriorYear: plan.method === "seasonal-growth",
      },
      // Categories with no budget behind them, so the chart can say the bars
      // ahead are short because nothing is planned rather than because nothing
      // is expected to be spent.
      unplanned: budgets.unplanned,
      firstProjectedMonth: ahead.length ? ahead[0].month : null,
      months,
      categories: ctx.list,
      totals: {
        savedSoFar: sum(past, "net"),
        projectedRemainingIncome: sum(ahead, "income"),
        projectedRemainingExpense: sum(ahead, "expense"),
        projectedRemainingNet: sum(ahead, "net"),
        projectedYearEndNet: sum(months, "net"),
      },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default forecast;

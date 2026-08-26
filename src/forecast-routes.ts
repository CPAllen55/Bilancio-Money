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
import { buildShapedPlan, learnWindow, loadOverrides } from "./plan";

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

    /* One read covering both what the shape learns from and what the chart
       draws behind it, because the two windows overlap and scanning twice for
       the same rows is the thing that made this page slow. */
    const { learn } = learnWindow(today);
    const span = [...new Set([...learn, ...thisYearKeys])].sort();

    const [buckets, overrides] = await Promise.all([
      monthlyBuckets(db, auth.user.id, ids, ctx, span),
      loadOverrides(db, auth.user.id),
    ]);
    const at = (key: string) =>
      buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };

    // The months ahead are drawn from the budget rather than from a separate
    // projection. Two different numbers for "what will next month cost" is one
    // too many, and the budget is the one somebody chose — the forecast was
    // only ever guessing at what the budget now states.
    const monthsAhead = thisYearKeys.filter((k) => k >= currentKey);
    /* The plan is built across the whole year, not only the part of it that is
       still ahead. The months behind are still drawn from what actually
       happened — that has not changed — but the chart now wants to say what
       each of them was budgeted at, and a plan that stops at today cannot. */
    const planned = buildShapedPlan(ctx.list, buckets, learn, thisYearKeys, overrides);

    // slug -> cents, for one month of the plan.
    const plannedAt = (key: string) => {
      const row: Record<string, number> = {};
      for (const [slug, perMonth] of Object.entries(planned.byCategory)) {
        const v = perMonth[key] ?? 0;
        if (v > 0) row[slug] = v;
      }
      return row;
    };

    const months = thisYearKeys.map((key) => {
      const actual = at(key);
      const actualByParent = rollUp(actual.byCategory, ctx);

      const plannedRow = plannedAt(key);
      const budget = Object.values(plannedRow).reduce((s, v) => s + v, 0);

      if (key < currentKey) {
        return {
          month: key, projected: false,
          income: actual.income, expense: actual.expense,
          net: actual.income - actual.expense,
          byParent: actualByParent,
          /* What this month would be budgeted at under the plan as it stands.
             Reported for every month, including the ones behind: what the
             reader does with it is the reader's business, and a figure the
             endpoint has and withholds is a figure somebody reconstructs
             badly somewhere else. */
          budget,
          budgetByParent: rollUp(plannedRow, ctx),
          actualSoFar: null as { income: number; expense: number } | null,
        };
      }

      const row = plannedRow;
      const plannedExpense = budget;

      // The current month already has spending in it. Showing less than has
      // demonstrably happened would be nonsense, so what happened is a floor —
      // and going past the budget is exactly the thing worth seeing.
      const isCurrent = key === currentKey;
      const expense = Math.max(plannedExpense, isCurrent ? actual.expense : 0);
      // Income is budgeted too now, by the same method, so the line ahead is
      // the plan rather than a second opinion about it.
      const income = Math.max(planned.income[key] ?? 0, isCurrent ? actual.income : 0);

      return {
        month: key, projected: true,
        income, expense,
        net: income - expense,
        byParent: isCurrent && actual.expense > plannedExpense
          ? actualByParent
          : rollUp(row, ctx),
        budget,
        budgetByParent: rollUp(row, ctx),
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
      method: "shaped" as const,
      growthPct: null,
      basis: {
        comparableMonths: planned.monthsOfHistory,
        monthsOfHistory: planned.monthsOfHistory,
        usesPriorYear: false,
      },
      // Categories with no budget behind them, so the chart can say the bars
      // ahead are short because nothing is planned rather than because nothing
      // is expected to be spent.
      // With one method nothing is undecided: a category with no history plans
      // zero and says so through its own shape.
      unplanned: [] as string[],
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

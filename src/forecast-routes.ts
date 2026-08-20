/**
 * /api/forecast — what the rest of the year looks like on current behaviour.
 *
 * The projection itself lives in ./projection, because the budget is the same
 * calculation asked a different question: the forecast wants "what will the
 * rest of the year cost", the budget wants "what should this month have cost".
 * One implementation, so the two can never quietly disagree about the growth
 * rate they are both built on.
 *
 * What stays here is what is particular to a forecast: rolling categories up to
 * their parents for the stacked bars, and treating the current month's actual
 * spending as a floor. Projecting less than has demonstrably already happened
 * would be nonsense — though it is exactly what a budget should do, which is
 * why the floor is applied here and not in the shared projection.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { requireUser } from "./auth";
import { loadCategories, monthlyBuckets, ownedAccountIds, rollUp } from "./summary-routes";
import { buildPlan } from "./projection";

const forecast = new Hono<{ Bindings: Env }>();

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;

forecast.get("/forecast", async (c) => {
  const { db, ready, close } = getDb(c.env);
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
    const [plan, buckets] = await Promise.all([
      buildPlan(db, auth.user.id, ids, ctx, thisYearKeys, today),
      monthlyBuckets(db, auth.user.id, ids, ctx, thisYearKeys),
    ]);
    const at = (key: string) =>
      buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };

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

      const expected = plan.for(key);

      // The current month already has spending in it. Projecting less than has
      // demonstrably happened would be nonsense, so it is a floor.
      const isCurrent = key === currentKey;
      const expense = Math.max(expected.expense, isCurrent ? actual.expense : 0);
      const income = Math.max(expected.income, isCurrent ? actual.income : 0);

      return {
        month: key, projected: true,
        income, expense,
        net: income - expense,
        byParent: isCurrent && actual.expense > expected.expense
          ? actualByParent
          : rollUp(expected.byCategory, ctx),
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

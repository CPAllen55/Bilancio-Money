/**
 * /api/forecast — what the rest of the year looks like on current behaviour.
 *
 * The question this answers is "how much will I actually have saved by
 * December", which needs two things a single average cannot give you:
 *
 *   Seasonality. December is not August. Using last year's shape keeps the
 *   Christmas spike, the summer holiday, the annual insurance bill.
 *
 *   Trajectory. Last year's shape alone assumes nothing has changed. Scaling it
 *   by how this year is running against last year carries the change forward.
 *
 * So:  projected(month) = actual(same month last year) × growth
 * where growth = this year's total / last year's total, over the months where
 * both years have data.
 *
 * When there is no prior year, that method is unavailable and the endpoint says
 * so rather than dressing up an average as a forecast. A projection presented
 * with false confidence about someone's money is worse than no projection.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { requireUser } from "./auth";
import { loadCategories, monthlyBuckets, ownedAccountIds } from "./summary-routes";

const forecast = new Hono<{ Bindings: Env }>();

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;

/** Months are only usable as history once they are over. */
function completeMonths(keys: string[], currentKey: string): string[] {
  return keys.filter((k) => k < currentKey);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

forecast.get("/forecast", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const account = c.req.query("account") ?? "all";
    const today = new Date();
    const year = Number(c.req.query("year") ?? today.getUTCFullYear());
    const thisMonthIdx = today.getUTCMonth();
    const currentKey = ym(today.getUTCFullYear(), thisMonthIdx);

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, account, true),
    ]);

    // Two full calendar years: the one being forecast, and the one before it
    // that supplies the seasonal shape.
    const span: string[] = [];
    for (const y of [year - 1, year]) for (let m = 0; m < 12; m++) span.push(ym(y, m));

    const buckets = await monthlyBuckets(db, auth.user.id, ids, ctx, span);
    const at = (key: string) => buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };

    const thisYearKeys = span.filter((k) => k.startsWith(String(year)));
    const actualKeys = completeMonths(thisYearKeys, currentKey);

    // Months where both years have real numbers — the only honest basis for a
    // growth rate. A month with no prior-year twin tells you nothing about
    // whether spending is rising.
    const comparable = actualKeys.filter((k) => {
      const prior = at(`${year - 1}-${k.slice(5)}`);
      return at(k).expense > 0 && prior.expense > 0;
    });

    const thisYearSum = comparable.reduce((s, k) => s + at(k).expense, 0);
    const priorSum = comparable.reduce((s, k) => s + at(`${year - 1}-${k.slice(5)}`).expense, 0);

    const hasSeasonal = comparable.length >= 2 && priorSum > 0;
    const growth = hasSeasonal ? thisYearSum / priorSum : 1;

    // Fallbacks when there is no prior year to lean on.
    const recentExpense = mean(actualKeys.slice(-3).map((k) => at(k).expense).filter((v) => v > 0));
    const recentIncome = mean(actualKeys.slice(-3).map((k) => at(k).income).filter((v) => v > 0));

    const method = hasSeasonal ? "seasonal-growth" : (recentExpense > 0 ? "recent-average" : "insufficient-data");

    const months = thisYearKeys.map((key) => {
      const actual = at(key);
      const isPast = key < currentKey;
      if (isPast) {
        return {
          month: key, projected: false,
          income: actual.income, expense: actual.expense, net: actual.income - actual.expense,
        };
      }

      const priorMonth = at(`${year - 1}-${key.slice(5)}`);
      let expense: number, income: number;

      if (hasSeasonal && priorMonth.expense > 0) {
        expense = Math.round(priorMonth.expense * growth);
        income = priorMonth.income > 0 ? Math.round(priorMonth.income * growth) : Math.round(recentIncome);
      } else {
        expense = Math.round(recentExpense);
        income = Math.round(recentIncome);
      }

      return {
        month: key, projected: true,
        // The current month already has spending in it. Projecting less than
        // has demonstrably happened would be nonsense.
        income: Math.max(income, key === currentKey ? actual.income : 0),
        expense: Math.max(expense, key === currentKey ? actual.expense : 0),
        net: 0,
        actualSoFar: key === currentKey ? { income: actual.income, expense: actual.expense } : null,
      };
    });
    months.forEach((m) => { m.net = m.income - m.expense; });

    const sum = (rows: typeof months, field: "income" | "expense" | "net") =>
      rows.reduce((s, r) => s + r[field], 0);
    const past = months.filter((m) => !m.projected);
    const ahead = months.filter((m) => m.projected);

    return c.json({
      ok: true,
      year,
      method,
      // Expressed as a percentage change so the front end does not have to
      // explain a bare multiplier to anybody.
      growthPct: hasSeasonal ? Math.round((growth - 1) * 1000) / 10 : null,
      basis: {
        comparableMonths: comparable.length,
        monthsOfHistory: actualKeys.filter((k) => at(k).expense > 0).length,
        usesPriorYear: hasSeasonal,
      },
      months,
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

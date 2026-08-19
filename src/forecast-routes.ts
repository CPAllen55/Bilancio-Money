/**
 * /api/forecast — what the rest of the year looks like on current behaviour.
 *
 * The question is "how much will I actually have kept by December", which needs
 * two things a single average cannot give you:
 *
 *   Seasonality. December is not August. Last year's shape keeps the Christmas
 *   spike, the summer holiday, the annual insurance bill.
 *
 *   Trajectory. Last year's shape alone assumes nothing has changed. Scaling it
 *   by how this year is running against last year carries the change forward.
 *
 * So:  projected(month) = actual(same month last year) × growth
 * where growth = this year's total / last year's total, across the months where
 * both years have data.
 *
 * Where there is no prior year that method is unavailable, and the endpoint
 * says so rather than dressing an average up as a forecast. A confident-looking
 * projection of somebody's savings, built on two months, is worse than none.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { requireUser } from "./auth";
import { loadCategories, monthlyBuckets, ownedAccountIds, rollUp } from "./summary-routes";

const forecast = new Hono<{ Bindings: Env }>();

const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Scales every category in a month by the same factor. */
function scaled(byParent: Record<string, number>, factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byParent)) out[k] = Math.round(v * factor);
  return out;
}

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

    // Two full calendar years: the one being forecast, and the one before it
    // that supplies the seasonal shape.
    const span: string[] = [];
    for (const y of [year - 1, year]) for (let m = 0; m < 12; m++) span.push(ym(y, m));

    const buckets = await monthlyBuckets(db, auth.user.id, ids, ctx, span);
    const at = (key: string) =>
      buckets.get(key) ?? { income: 0, expense: 0, total: 0, byCategory: {} };

    const thisYearKeys = span.filter((k) => k.startsWith(String(year)));
    const actualKeys = thisYearKeys.filter((k) => k < currentKey);

    // Months where both years hold real numbers — the only honest basis for a
    // growth rate. A month with no prior-year twin says nothing about trend.
    const comparable = actualKeys.filter(
      (k) => at(k).expense > 0 && at(`${year - 1}-${k.slice(5)}`).expense > 0,
    );
    const thisYearSum = comparable.reduce((s, k) => s + at(k).expense, 0);
    const priorSum = comparable.reduce((s, k) => s + at(`${year - 1}-${k.slice(5)}`).expense, 0);

    const hasSeasonal = comparable.length >= 2 && priorSum > 0;
    const growth = hasSeasonal ? thisYearSum / priorSum : 1;

    const recentExpense = mean(actualKeys.slice(-3).map((k) => at(k).expense).filter((v) => v > 0));
    const recentIncome = mean(actualKeys.slice(-3).map((k) => at(k).income).filter((v) => v > 0));
    const recentShape = (() => {
      // Average category mix of the last three months, for projecting a stacked
      // bar when there is no prior year to take the shape from.
      const recent = actualKeys.slice(-3).filter((k) => at(k).expense > 0);
      if (!recent.length) return {};
      const sum: Record<string, number> = {};
      for (const k of recent) {
        for (const [cat, v] of Object.entries(rollUp(at(k).byCategory, ctx))) {
          sum[cat] = (sum[cat] ?? 0) + v;
        }
      }
      for (const k of Object.keys(sum)) sum[k] = Math.round(sum[k] / recent.length);
      return sum;
    })();

    const method = hasSeasonal
      ? "seasonal-growth"
      : recentExpense > 0
        ? "recent-average"
        : "insufficient-data";

    const months = thisYearKeys.map((key) => {
      const actual = at(key);
      const actualByParent = rollUp(actual.byCategory, ctx);

      if (key < currentKey) {
        return {
          month: key, projected: false,
          income: actual.income, expense: actual.expense,
          net: actual.income - actual.expense,
          byParent: actualByParent,
        };
      }

      const priorMonth = at(`${year - 1}-${key.slice(5)}`);
      const useSeasonal = hasSeasonal && priorMonth.expense > 0;

      const expense = useSeasonal ? Math.round(priorMonth.expense * growth) : Math.round(recentExpense);
      const income = useSeasonal && priorMonth.income > 0
        ? Math.round(priorMonth.income * growth)
        : Math.round(recentIncome);
      const byParent = useSeasonal
        ? scaled(rollUp(priorMonth.byCategory, ctx), growth)
        : { ...recentShape };

      // The current month already has spending in it. Projecting less than has
      // demonstrably happened would be nonsense, so it is a floor.
      const isCurrent = key === currentKey;
      const finalExpense = Math.max(expense, isCurrent ? actual.expense : 0);
      const finalIncome = Math.max(income, isCurrent ? actual.income : 0);

      return {
        month: key, projected: true,
        income: finalIncome, expense: finalExpense,
        net: finalIncome - finalExpense,
        byParent: isCurrent && actual.expense > finalExpense ? actualByParent : byParent,
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
      method,
      // A percentage, so the front end never has to explain a bare multiplier.
      growthPct: hasSeasonal ? Math.round((growth - 1) * 1000) / 10 : null,
      basis: {
        comparableMonths: comparable.length,
        monthsOfHistory: actualKeys.filter((k) => at(k).expense > 0).length,
        usesPriorYear: hasSeasonal,
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

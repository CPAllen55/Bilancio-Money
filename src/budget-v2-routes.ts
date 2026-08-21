/**
 * /api/budget-v2 — the Budgeting dashboard, second attempt, in a silo.
 *
 * Everything here reads and writes budget_plans_v2 and nothing else reads that
 * table. The Tracker, the Overview tiles and the Trend budget all still go
 * through /api/budget-plan, so a plan built here changes nothing anywhere else
 * until someone decides it should. That is the whole point of the separation
 * and it is worth keeping: the moment this shares storage with v1, every
 * half-finished idea tried out here lands on the rest of the app.
 *
 * What it adds over v1:
 *
 *   - A horizon rather than a month. Budgets come back for every month from the
 *     current one to the end of the year, because a plan whose shape you cannot
 *     see is a number rather than a plan.
 *   - Every method's answer, not only the chosen one. Choosing between average
 *     and seasonal is guesswork until you can see both, so each category also
 *     carries what it would have cost under each of the others and the chart
 *     draws them as lines behind the bars.
 *   - Manual per month. v1 has one figure repeated forever; here December can
 *     cost more than August without inventing a method to say so.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetPlansV2 } from "./db/schema";
import { requireUser } from "./auth";
import { loadCategories, ownedAccountIds } from "./summary-routes";
import { buildPlan } from "./projection";
import type { Plan } from "./projection";
import type { HistoryLookup, Method, PlanRow } from "./budget-plan";
import { METHODS, budgetForLeaf, isMethod, resolveMethod, shareOut } from "./budget-plan";

const v2 = new Hono<{ Bindings: Env }>();

/** The rest of the calendar year, starting with the month running now. */
export function horizon(today: Date): string[] {
  const y = today.getUTCFullYear();
  const out: string[] = [];
  for (let m = today.getUTCMonth(); m <= 11; m++) {
    out.push(y + "-" + String(m + 1).padStart(2, "0"));
  }
  return out;
}

interface V2Row extends PlanRow {
  manualByMonth: Record<string, number>;
}

/** What a category with no row of its own starts from. */
const EMPTY = { manualAmount: 0, manualByMonth: {} as Record<string, number> };

async function loadV2Rows(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<Map<string, V2Row>> {
  const rows = await db
    .select({
      categoryId: budgetPlansV2.categoryId,
      method: budgetPlansV2.method,
      manualAmount: budgetPlansV2.manualAmount,
      manualByMonth: budgetPlansV2.manualByMonth,
    })
    .from(budgetPlansV2)
    .where(eq(budgetPlansV2.userId, userId));

  const out = new Map<string, V2Row>();
  for (const r of rows) {
    out.set(r.categoryId, {
      categoryId: r.categoryId,
      method: r.method as Method,
      manualAmount: r.manualAmount,
      manualByMonth: (r.manualByMonth ?? {}) as Record<string, number>,
    });
  }
  return out;
}

/**
 * What one leaf costs in one month under one method.
 *
 * Only manual differs from v1, and only because v1 has nowhere to put a figure
 * that changes month to month. Everything else defers to the same calculation
 * the rest of the app uses — this is meant to be a different way of deciding a
 * budget, not a second and quietly different arithmetic.
 */
function leafFor(
  slug: string,
  month: string,
  method: Method,
  row: { manualAmount: number; manualByMonth: Record<string, number> },
  history: HistoryLookup,
  plan: Plan,
): number | null {
  if (method === "manual") {
    const named = row.manualByMonth[month];
    return typeof named === "number" ? named : row.manualAmount;
  }
  return budgetForLeaf(slug, month, method, row.manualAmount, history, plan);
}

v2.get("/budget-v2", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const today = new Date();
    const months = horizon(today);
    const currentKey = months[0];

    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, "all", true),
    ]);
    const [plan, rows] = await Promise.all([
      buildPlan(db, auth.user.id, ids, ctx, months, today),
      loadV2Rows(db, auth.user.id),
    ]);

    const buckets = plan.buckets;
    const at = (slug: string, month: string) => buckets.get(month)?.byCategory[slug] ?? 0;
    const completed = [...buckets.keys()].sort()
      .filter((k) => k < currentKey && (buckets.get(k)?.expense ?? 0) > 0);
    const history: HistoryLookup = {
      at, completed,
      lastComplete: completed.length ? completed[completed.length - 1] : null,
      before: (month) => completed.filter((k) => k < month),
    };

    const leaves = ctx.list.filter((cat) => cat.parentSlug && cat.kind === "spend");
    const parents = ctx.list.filter((cat) => !cat.parentSlug && cat.kind === "spend");

    // Weights for splitting a parent's manual figure, from what its children
    // have actually cost lately.
    const weight = new Map<string, number>();
    for (const leaf of leaves) {
      weight.set(leaf.slug, completed.slice(-3).reduce((s, m) => s + at(leaf.slug, m), 0));
    }

    const idOf = new Map(ctx.list.map((cat) => [cat.slug, cat.id]));
    const rowFor = (slug: string) => {
      const id = idOf.get(slug);
      return (id ? rows.get(id) : undefined) ?? EMPTY;
    };

    interface Out {
      slug: string; label: string; parentSlug: string | null; colour: string;
      method: Method; inherited: boolean; manualAmount: number;
      manualByMonth: Record<string, number>;
      budget: Record<string, number | null>;
      alternates: Record<string, Record<string, number | null>>;
      spentLastMonth: number;
    }
    const out: Out[] = [];

    for (const parent of parents) {
      const kids = leaves.filter((cat) => cat.parentSlug === parent.slug);
      const own = resolveMethod(parent.slug, ctx, rows);
      const ownRow = rowFor(parent.slug);

      // A manual figure on a parent is still shared across its children, month
      // by month, so the parts keep adding to the whole.
      const sharedFor = (month: string): Map<string, number> | null => {
        if (own.method !== "manual" || own.inherited || !kids.length) return null;
        const amount = leafFor(parent.slug, month, "manual", ownRow, history, plan) ?? 0;
        return shareOut(amount, kids.map((k) => k.slug), weight);
      };

      const kidRows: Out[] = kids.map((kid) => {
        const m = resolveMethod(kid.slug, ctx, rows);
        // An inherited manual reads the parent's per-month figures, not its own.
        const src = m.inherited ? ownRow : rowFor(kid.slug);
        const budget: Record<string, number | null> = {};
        const alternates: Record<string, Record<string, number | null>> = {};
        for (const method of METHODS) alternates[method] = {};

        for (const month of months) {
          const shared = sharedFor(month);
          budget[month] = shared
            ? shared.get(kid.slug) ?? 0
            : leafFor(kid.slug, month, m.method, src, history, plan);
          for (const method of METHODS) {
            alternates[method][month] = method === "manual"
              ? leafFor(kid.slug, month, "manual", rowFor(kid.slug), history, plan)
              : budgetForLeaf(kid.slug, month, method, src.manualAmount, history, plan);
          }
        }

        return {
          slug: kid.slug, label: kid.label, parentSlug: parent.slug, colour: kid.colour,
          method: m.method, inherited: m.inherited, manualAmount: src.manualAmount,
          manualByMonth: rowFor(kid.slug).manualByMonth,
          budget, alternates,
          spentLastMonth: history.lastComplete ? at(kid.slug, history.lastComplete) : 0,
        };
      });

      // A parent is the sum of its children, always, so the headline figure
      // cannot drift from the rows underneath it.
      const sum = (pick: (k: Out) => Record<string, number | null>) => {
        const total: Record<string, number | null> = {};
        for (const month of months) {
          let acc: number | null = null;
          for (const kid of kidRows) {
            const v = pick(kid)[month];
            if (v === null || v === undefined) continue;
            acc = (acc ?? 0) + v;
          }
          total[month] = acc;
        }
        return total;
      };

      const onlyOwn = (method: Method) => Object.fromEntries(months.map((month) =>
        [month, method === "manual"
          ? leafFor(parent.slug, month, "manual", ownRow, history, plan)
          : budgetForLeaf(parent.slug, month, method, ownRow.manualAmount, history, plan)]));

      const parentBudget = kids.length
        ? sum((k) => k.budget)
        : Object.fromEntries(months.map((month) =>
            [month, leafFor(parent.slug, month, own.method, ownRow, history, plan)]));

      const parentAlternates: Record<string, Record<string, number | null>> = {};
      for (const method of METHODS) {
        parentAlternates[method] = kids.length ? sum((k) => k.alternates[method]) : onlyOwn(method);
      }

      out.push({
        slug: parent.slug, label: parent.label, parentSlug: null, colour: parent.colour,
        method: own.method, inherited: own.inherited, manualAmount: ownRow.manualAmount,
        manualByMonth: ownRow.manualByMonth,
        budget: parentBudget, alternates: parentAlternates,
        spentLastMonth: history.lastComplete
          ? kids.reduce((s, k) => s + at(k.slug, history.lastComplete!), 0)
            + at(parent.slug, history.lastComplete)
          : 0,
      });
      out.push(...kidRows);
    }

    return c.json({
      ok: true,
      siloed: true,
      methods: METHODS,
      months,
      basis: plan.method,
      growthPct: plan.growthPct,
      monthsOfHistory: completed.length,
      categories: out,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

v2.put("/budget-v2", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const body = await c.req.json().catch(() => null) as {
      slug?: unknown; method?: unknown; manualAmount?: unknown;
      month?: unknown; monthAmount?: unknown;
    } | null;
    if (!body || typeof body.slug !== "string") {
      return c.json({ error: "bad_request", message: "Expected a category." }, 400);
    }

    const ctx = await loadCategories(db, auth.user.id);
    const cat = ctx.list.find((x) => x.slug === body.slug);
    if (!cat) return c.json({ error: "not_found", message: "No such category." }, 404);

    // Absence means "follow the parent" here exactly as it does in v1.
    if (body.method === "inherit") {
      await db.delete(budgetPlansV2).where(
        and(eq(budgetPlansV2.userId, auth.user.id), eq(budgetPlansV2.categoryId, cat.id)));
      return c.json({ ok: true, slug: cat.slug, method: "inherit" });
    }

    const [existing] = await db
      .select({
        method: budgetPlansV2.method,
        manualAmount: budgetPlansV2.manualAmount,
        manualByMonth: budgetPlansV2.manualByMonth,
      })
      .from(budgetPlansV2)
      .where(and(eq(budgetPlansV2.userId, auth.user.id), eq(budgetPlansV2.categoryId, cat.id)));

    let method: Method;
    let manualAmount = existing?.manualAmount ?? 0;
    const manualByMonth: Record<string, number> = {
      ...((existing?.manualByMonth ?? {}) as Record<string, number>),
    };

    if (typeof body.month === "string") {
      // One month's figure, edited on its own. The method comes with it, because
      // nobody types a number into a grid and expects it to be ignored until
      // they also change a menu.
      if (!/^\d{4}-\d{2}$/.test(body.month)) {
        return c.json({ error: "bad_request", message: "That is not a month." }, 400);
      }
      const amount = Math.round(Number(body.monthAmount ?? 0));
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
        return c.json({ error: "bad_request", message: "That amount is out of range." }, 400);
      }
      manualByMonth[body.month] = amount;
      method = "manual";
    } else {
      if (!isMethod(body.method)) {
        return c.json({ error: "bad_request", message: "Unknown planning method." }, 400);
      }
      method = body.method;
      const amount = Math.round(Number(body.manualAmount ?? manualAmount));
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
        return c.json({ error: "bad_request", message: "That amount is out of range." }, 400);
      }
      manualAmount = amount;
    }

    await db
      .insert(budgetPlansV2)
      .values({ userId: auth.user.id, categoryId: cat.id, method, manualAmount, manualByMonth })
      .onConflictDoUpdate({
        target: [budgetPlansV2.userId, budgetPlansV2.categoryId],
        set: { method, manualAmount, manualByMonth, updatedAt: new Date() },
      });

    return c.json({ ok: true, slug: cat.slug, method, manualAmount, manualByMonth });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default v2;

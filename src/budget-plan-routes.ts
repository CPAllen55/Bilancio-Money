/**
 * /api/budget-plan — reading and setting how each category's budget is worked out.
 *
 * GET returns every spend category with the method actually in force, whether
 * that method is its own or inherited, and what the current method produces for
 * one month. The last of those is the point: choosing between "average" and
 * "seasonal" is guesswork until you can see what each would give you.
 *
 * PUT takes one category at a time. Setting it to "inherit" deletes the row
 * rather than storing the word, so absence keeps its single meaning and a
 * category that later moves under a different parent follows the new one.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetPlans } from "./db/schema";
import { requireUser } from "./auth";
import { loadCategories, monthKeys, monthlyBuckets, ownedAccountIds } from "./summary-routes";
import { buildPlan } from "./projection";
import type { HistoryLookup } from "./budget-plan";
import { METHODS, budgetForLeaf, isMethod, loadPlanRows, resolveMethod, shareOut } from "./budget-plan";

const plans = new Hono<{ Bindings: Env }>();

plans.get("/budget-plan", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const today = new Date();
    const [ctx, ids] = await Promise.all([
      loadCategories(db, auth.user.id),
      ownedAccountIds(db, auth.user.id, "all", true),
    ]);

    // The month being previewed is the one running now: what the chosen method
    // says this month should cost.
    const currentKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
    const historyKeys = monthKeys(24, today);

    const [plan, buckets, rows] = await Promise.all([
      buildPlan(db, auth.user.id, ids, ctx, [currentKey], today),
      monthlyBuckets(db, auth.user.id, ids, ctx, historyKeys),
      loadPlanRows(db, auth.user.id),
    ]);

    const at = (slug: string, month: string) => buckets.get(month)?.byCategory[slug] ?? 0;
    const completed = historyKeys.filter((k) => k < currentKey && (buckets.get(k)?.expense ?? 0) > 0);
    const history: HistoryLookup = {
      at, completed,
      lastComplete: completed.length ? completed[completed.length - 1] : null,
      before: (month) => completed.filter((k) => k < month),
    };

    const leaves = ctx.list.filter((cat) => cat.parentSlug && cat.kind === "spend");
    const parents = ctx.list.filter((cat) => !cat.parentSlug && cat.kind === "spend");

    const weight = new Map<string, number>();
    for (const leaf of leaves) {
      weight.set(leaf.slug, completed.slice(-3).reduce((s, m) => s + at(leaf.slug, m), 0));
    }

    const preview: Record<string, number | null> = {};
    const out: {
      slug: string; label: string; parentSlug: string | null; colour: string;
      method: string; inherited: boolean; manualAmount: number;
      preview: number | null; spentLastMonth: number; monthsOfHistory: number;
    }[] = [];

    for (const parent of parents) {
      const kids = leaves.filter((cat) => cat.parentSlug === parent.slug);
      const own = resolveMethod(parent.slug, ctx, rows);

      // Mirrors budgetFor: a manual amount on a parent is shared out.
      let shared: Map<string, number> | null = null;
      if (own.method === "manual" && !own.inherited && kids.length) {
        shared = shareOut(own.manualAmount, kids.map((k) => k.slug), weight);
      }

      for (const kid of kids) {
        const m = resolveMethod(kid.slug, ctx, rows);
        preview[kid.slug] = shared
          ? shared.get(kid.slug) ?? 0
          : budgetForLeaf(kid.slug, currentKey, m.method, m.manualAmount, history, plan);
      }

      const parentPreview = kids.length
        ? kids.reduce<number | null>((s, k) => {
            const v = preview[k.slug];
            return v === null ? s : (s ?? 0) + v;
          }, null)
        : budgetForLeaf(parent.slug, currentKey, own.method, own.manualAmount, history, plan);

      const monthsWith = (slug: string) => completed.filter((m) => at(slug, m) > 0).length;

      out.push({
        slug: parent.slug, label: parent.label, parentSlug: null, colour: parent.colour,
        method: own.method, inherited: own.inherited, manualAmount: own.manualAmount,
        preview: parentPreview,
        spentLastMonth: history.lastComplete
          ? kids.reduce((s, k) => s + at(k.slug, history.lastComplete!), 0) + at(parent.slug, history.lastComplete)
          : 0,
        monthsOfHistory: monthsWith(parent.slug) ||
          Math.max(0, ...kids.map((k) => monthsWith(k.slug))),
      });

      for (const kid of kids) {
        const m = resolveMethod(kid.slug, ctx, rows);
        out.push({
          slug: kid.slug, label: kid.label, parentSlug: parent.slug, colour: kid.colour,
          method: m.method, inherited: m.inherited, manualAmount: m.manualAmount,
          preview: preview[kid.slug] ?? null,
          spentLastMonth: history.lastComplete ? at(kid.slug, history.lastComplete) : 0,
          monthsOfHistory: monthsWith(kid.slug),
        });
      }
    }

    return c.json({
      ok: true,
      methods: METHODS,
      month: currentKey,
      basis: plan.method,
      growthPct: plan.growthPct,
      monthsOfHistory: completed.length,
      categories: out,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

plans.put("/budget-plan", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const body = await c.req.json().catch(() => null) as
      { slug?: unknown; method?: unknown; manualAmount?: unknown } | null;
    if (!body || typeof body.slug !== "string") {
      return c.json({ error: "bad_request", message: "Expected a category." }, 400);
    }

    const ctx = await loadCategories(db, auth.user.id);
    const cat = ctx.list.find((x) => x.slug === body.slug);
    if (!cat) return c.json({ error: "not_found", message: "No such category." }, 404);

    // Absence is what "inherit" means, so it is stored as absence.
    if (body.method === "inherit") {
      await db.delete(budgetPlans).where(
        and(eq(budgetPlans.userId, auth.user.id), eq(budgetPlans.categoryId, cat.id)));
      return c.json({ ok: true, slug: cat.slug, method: "inherit" });
    }

    if (!isMethod(body.method)) {
      return c.json({ error: "bad_request", message: "Unknown planning method." }, 400);
    }

    const amount = Math.round(Number(body.manualAmount ?? 0));
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
      return c.json({ error: "bad_request", message: "That amount is out of range." }, 400);
    }
    // A manual budget of zero is allowed: choosing the method comes before
    // typing the figure, and refusing the first half of that makes the menu
    // error at you for doing the obvious thing.

    await db
      .insert(budgetPlans)
      .values({ userId: auth.user.id, categoryId: cat.id, method: body.method, manualAmount: amount })
      .onConflictDoUpdate({
        target: [budgetPlans.userId, budgetPlans.categoryId],
        set: { method: body.method, manualAmount: amount, updatedAt: new Date() },
      });

    return c.json({ ok: true, slug: cat.slug, method: body.method, manualAmount: amount });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default plans;

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
 * ── What reads this ───────────────────────────────────────────────────────
 *
 * Everything. The Overview tiles, the Tracker bars and the Trend forecast all
 * go through buildShapedPlan in plan.ts, which is the same call this endpoint
 * makes — not a second implementation kept in step by hand. Moving a baseline
 * here moves every one of them.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetPlansV2 } from "./db/schema";
import { requireUser } from "./auth";
import {
  loadCategories, monthlyBuckets, ownedAccountIds, type MerchantNames,
} from "./summary-routes";
import { loadOverrides, learnWindow, type Override } from "./plan";
import { shapeBudget } from "./budget-shape";
import {
  planSubcategory, planIncome, type MerchantHistory,
} from "./budget-engine";

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

    /* The printable merchant spellings, collected as the buckets are built.
       Nothing extra is read for them -- the query already groups by merchant
       so that a merchant rule can move one shop's rows, and this keeps what it
       was throwing away. */
    const names: MerchantNames = new Map();
    const [buckets, overrides] = await Promise.all([
      monthlyBuckets(db, auth.user.id, ids, ctx, learn, names),
      loadOverrides(db, auth.user.id),
    ]);

    /* Only leaves are planned. A parent's figure is the sum of its children,
       which is the only way the parts can be edited and the whole stay true. */
    const leaves = ctx.list.filter((cat) => cat.parentSlug && cat.kind === "spend");

    const rows = leaves.map((cat) => {
      const over = overrides.get(cat.id);

      const totals = learn.map((m) => buckets.get(m)?.byCategory[cat.slug] ?? 0);
      /* This subcategory's merchants, month by month. A month with nothing
         spent here still gets an entry, because "billed in four of the last
         six" has to be able to count the two it missed. */
      const merchants: MerchantHistory = new Map(
        learn.map((m) => [m, buckets.get(m)?.byMerchant?.[cat.slug] ?? {}]),
      );
      const sub = planSubcategory(
        cat.slug, totals, merchants, names, learn, planMonths,
        over && over.baseline > 0 ? over.baseline : undefined,
      );

      /* A pinned month beats the baseline: naming one month is the more
         specific statement of the two. */
      const plan: Record<string, number> = {};
      for (const m of planMonths) {
        const pinned = over?.byMonth?.[m];
        plan[m] = pinned !== undefined && pinned !== null
          ? Math.max(0, Math.round(pinned))
          : sub.plan[m] ?? 0;
      }

      const spent = Object.fromEntries(
        learn.filter((m) => planMonths.includes(m))
          .map((m) => [m, buckets.get(m)?.byCategory[cat.slug] ?? 0]),
      );
      /* The same calendar months a year earlier, keyed by the month they are
         being compared WITH -- so the client can put January 2025 under
         January 2026 without doing date arithmetic to find it.

         Nothing extra is read for this. The learn window already reaches two
         calendar years back because that is what the shape is fitted from, so
         these buckets are in hand; they were simply being filtered out. */
      const priorSpent = Object.fromEntries(
        planMonths.map((m) => {
          const [y, mo] = m.split("-");
          return [m, buckets.get(`${Number(y) - 1}-${mo}`)?.byCategory[cat.slug] ?? 0];
        }),
      );
      /* What the engine would say with the reader's hand taken off it. Kept
         separately so Reset has somewhere to go back to, and so the readout
         can show an overridden category what it is overriding. */
      const computed = Object.fromEntries(
        planMonths.map((m) => [m, sub.parts[m]?.auto ?? 0]),
      );

      return {
        id: cat.id, slug: cat.slug, label: cat.label, colour: cat.colour,
        parentSlug: cat.parentSlug,
        spent,
        priorSpent,
        computed,
        plan,
        baselineOverride: over && over.baseline > 0 ? over.baseline : null,
        pinned: over?.byMonth ?? {},
        /* The arithmetic, so the page can show its working rather than assert
           a figure. Every line here is checkable against the reader's own
           transactions, which is the whole point of shipping it. */
        parts: sub.parts,
        committed: sub.committed.map((c) => ({
          name: c.name, cents: c.cents, perMonth: c.perMonth,
          seasonal: c.seasonal, step: c.step, since: c.since, months: c.months,
        })),
        variableLevel: sub.variableLevel,
        variableBasis: sub.variableBasis,
        step: sub.step,
        baseline: sub.committed.reduce((s, c) => s + c.cents, 0) + sub.variableLevel,
        irregularPerMonth: sub.irregularPerMonth,
        outliers: sub.outliers,
        seasonal: sub.seasonal,
        monthsUsed: sub.monthsUsed,
      };
    });

    /* Income, one bucket at a time, and deliberately conservative.

       This was a single line fitted to the monthly total, with a December
       bonus landing twice in a row planning a heavier December. That is the
       right treatment for spending and the wrong one here: a salary and a tax
       refund are both "income" and only one of them happens again next month,
       and blended into one series a good year quietly promises savings that
       never arrive.

       So each income subcategory is projected on its own by the rule in
       budget-engine.ts -- high months dropped rather than saved for, short
       months ignored so they cannot drag the floor down, and the smallest of
       what is left over the last twelve. Summed afterwards.

       Salary & Wages carries almost all of it for almost everybody, which is
       the point of splitting them: the refunds line projects to nothing on its
       own, where blended it was quietly propping the total up. */
    const incomeLeaves = ctx.list.filter(
      (cat) => cat.kind === "income" && cat.parentSlug,
    );
    const incomeParts = incomeLeaves.map((cat) => {
      const totals = learn.map((m) => buckets.get(m)?.byIncome?.[cat.slug] ?? 0);
      const merchants: MerchantHistory = new Map(
        learn.map((m) => [m, buckets.get(m)?.byIncomeMerchant?.[cat.slug] ?? {}]),
      );
      const got = planIncome(totals, merchants, names, learn, planMonths);
      return {
        slug: cat.slug, label: cat.label, colour: cat.colour,
        level: got.level, plan: got.plan,
        dropped: got.dropped, short: got.short, payers: got.payers,
        spent: Object.fromEntries(
          learn.filter((m) => planMonths.includes(m))
            .map((m) => [m, buckets.get(m)?.byIncome?.[cat.slug] ?? 0]),
        ),
      };
    }).filter((r) => r.level > 0 || Object.values(r.spent).some((v) => v > 0));

    /* Salary & Wages first, then whatever else pays, largest first. The order
       is the claim: for almost everybody one line is the income and the rest
       is noise around it, and a list that opens with Refunds says otherwise. */
    incomeParts.sort((a, b) =>
      (a.slug === "salary" ? -1 : b.slug === "salary" ? 1 : 0) || b.level - a.level);

    const incomeComputed = Object.fromEntries(
      planMonths.map((m) => [m, incomeParts.reduce((s, p) => s + (p.plan[m] ?? 0), 0)]),
    );

    /* The old shape is still built, for the fields the page reads that describe
       history rather than the projection. */
    const incomeShape = shapeBudget(
      learn.map((m) => ({ month: m, amount: buckets.get(m)?.income ?? 0 })),
      planMonths,
    );
    const incomeCat = ctx.list.find((cat) => cat.slug === "income" && !cat.parentSlug);
    const incomeOver = incomeCat ? overrides.get(incomeCat.id) : undefined;
    const incomePlan: Record<string, number> = {};
    for (const m of planMonths) {
      const pinned = incomeOver?.byMonth?.[m];
      incomePlan[m] = pinned !== undefined && pinned !== null
        ? Math.max(0, Math.round(pinned))
        : incomeOver && incomeOver.baseline > 0
          ? Math.max(0, Math.round(incomeOver.baseline))
          : incomeComputed[m];
    }

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
        computed: incomeComputed,
        baseline: incomeParts.reduce((s, p) => s + p.level, 0),
        /* Where it comes from, and what was left out of it.
         *
         * Named sources rather than parts: a spending row already ships a
         * `parts` object keyed by month, and two fields sharing a name with
         * different shapes on sibling objects is how a client ends up
         * iterating an array as though it were a map. */
        sources: incomeParts,
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
      drivesOtherTabs: true,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const MAX_CENTS = 1_000_000_00;

/** One edit, as it arrives. Validated before anything is written. */
type Edit = {
  slug: string;
  baseline?: number | null;
  month?: string;
  amount?: number | null;
};

function readEdit(raw: any): Edit | { error: string } {
  if (typeof raw?.slug !== "string") return { error: "Expected a category." };
  const out: Edit = { slug: raw.slug };

  if ("baseline" in raw) {
    if (raw.baseline === null) out.baseline = null;
    else {
      const n = Number(raw.baseline);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CENTS) {
        return { error: "That amount is out of range." };
      }
      out.baseline = Math.round(n);
    }
  }

  if ("month" in raw) {
    if (!/^\d{4}-\d{2}$/.test(String(raw.month))) return { error: "That is not a month." };
    out.month = String(raw.month);
    if (raw.amount === null) out.amount = null;
    else {
      const n = Number(raw.amount);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CENTS) {
        return { error: "That amount is out of range." };
      }
      out.amount = Math.round(n);
    }
  }

  return out;
}

/**
 * PUT /api/budget — one edit, or a batch of them.
 *
 *   { slug, baseline: 43000 }            move a whole category
 *   { slug, baseline: null }             back to what history says
 *   { slug, month: "2026-05", amount }   pin one month
 *   { slug, month: "2026-05", amount: null }   unpin it
 *   { edits: [ ... ] }                   any number of the above, at once
 *
 * The batch exists because of one gesture. Setting a savings target for a
 * month re-pins every category in that month, and forty categories cannot be
 * forty round trips — each of which reads a row, amends it and writes it back,
 * so two touching the same category would lose one of them. Batched, each
 * category is read once, amended however many times the batch asks, and
 * written once.
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

    const incoming: any[] = Array.isArray(body?.edits) ? body.edits : [body];
    if (!incoming.length) return c.json({ error: "bad_request", message: "Nothing to do." }, 400);
    if (incoming.length > 500) {
      return c.json({ error: "bad_request", message: "Too many edits at once." }, 400);
    }

    const edits: Edit[] = [];
    for (const raw of incoming) {
      const parsed = readEdit(raw);
      if ("error" in parsed) return c.json({ error: "bad_request", message: parsed.error }, 400);
      edits.push(parsed);
    }

    const ctx = await loadCategories(db, auth.user.id);

    // Grouped by category first, so a category named twice in one batch is
    // still read once and written once.
    const byCategory = new Map<string, Edit[]>();
    for (const e of edits) {
      const cat = ctx.list.find((x) => x.slug === e.slug);
      if (!cat) return c.json({ error: "not_found", message: "No such category." }, 404);
      const list = byCategory.get(cat.id);
      if (list) list.push(e); else byCategory.set(cat.id, [e]);
    }

    const existing = await db
      .select()
      .from(budgetPlansV2)
      .where(eq(budgetPlansV2.userId, auth.user.id));
    const rows = new Map(existing.map((r) => [r.categoryId, r]));

    const results: { slug: string; baseline: number | null; byMonth: Record<string, number> }[] = [];

    for (const [categoryId, list] of byCategory) {
      const row = rows.get(categoryId);
      let baseline = row ? Number(row.manualAmount) || 0 : 0;
      const byMonth: Record<string, number> =
        { ...((row?.manualByMonth as Record<string, number>) ?? {}) };

      for (const e of list) {
        if ("baseline" in e) baseline = e.baseline === null ? 0 : (e.baseline as number);
        if (e.month !== undefined) {
          if (e.amount === null || e.amount === undefined) delete byMonth[e.month];
          else byMonth[e.month] = e.amount;
        }
      }

      await db
        .insert(budgetPlansV2)
        .values({
          userId: auth.user.id, categoryId,
          method: "shaped", manualAmount: baseline, manualByMonth: byMonth,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [budgetPlansV2.userId, budgetPlansV2.categoryId],
          set: { manualAmount: baseline, manualByMonth: byMonth, updatedAt: new Date() },
        });

      results.push({
        slug: list[0].slug, baseline: baseline || null, byMonth,
      });
    }

    // A single edit answers exactly as it always did, so nothing that already
    // calls this has to know the batch form exists.
    if (!Array.isArray(body?.edits)) {
      return c.json({ ok: true, ...results[0] });
    }
    return c.json({ ok: true, updated: results.length, categories: results });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default budget;

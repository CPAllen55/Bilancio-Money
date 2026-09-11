/**
 * Budget alerts: a notification when a chosen subcategory is nearly spent, and
 * another if it goes over.
 *
 * ── Chosen, one subcategory at a time ──────────────────────────────────────
 *
 * Nothing alerts unless somebody picked it on the Budget alerts dashboard. The
 * choice is per subcategory because that is where the plan lives: Groceries has
 * a budget of its own, while "Food and Dining" is only the sum of what is under
 * it -- and somebody watching their groceries has no reason to hear about
 * coffee.
 *
 * ── The same line the Overview draws ────────────────────────────────────────
 *
 * Nearly spent is 95% and over is past 100%, the two states a subcategory row
 * inside an Overview card is already coloured by. The figures come from
 * `monthStanding`, which is the /summary this-month path itself, so an alert
 * can never say a subcategory is at 96% while the screen it opens says 91%.
 *
 * ── Said once ───────────────────────────────────────────────────────────────
 *
 * Each subcategory announces each threshold once a month -- nearly spent, then
 * over if it gets that far. Nothing repeats on the next sync, and a muted one
 * says nothing more until the month turns. The month is the plan's own UTC
 * key, so "this month" means the month the budget means.
 *
 * ── When it runs ────────────────────────────────────────────────────────────
 *
 * After a sync that changed something, whether Plaid's webhook or the app
 * started it, and when somebody chooses a subcategory. Spending only moves
 * when transactions do, so there is nothing to look at in between. It is not
 * cheap -- the plan is fitted from up to three years of history -- which is
 * why it returns before any of that for somebody who has chosen nothing, or
 * has no phone to send to.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetAlertStates, budgetAlertSubscriptions, pushDevices } from "./db/schema";
import { monthStanding } from "./summary-routes";
import { learnWindow } from "./plan";
import { pushConfigured, sendPush } from "./push";

/** The Overview's amber line. Keep in step with TrackerCard.nearBudget. */
export const NEAR_BUDGET = 0.95;

export type AlertLevel = "near" | "over";

export function levelFor(spent: number, planned: number): AlertLevel | null {
  if (planned <= 0) return null;          // nothing planned, nothing to be near
  if (spent > planned) return "over";
  if (spent >= planned * NEAR_BUDGET) return "near";
  return null;
}

const rank = (level: string | null | undefined) =>
  level === "over" ? 2 : level === "near" ? 1 : 0;

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** Whole dollars, except under one, where "$0 left" would be a small lie. */
function money(cents: number): string {
  const whole = Math.abs(cents) >= 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

export function wording(label: string, level: AlertLevel, spent: number, planned: number, month: string) {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? "this month";
  if (level === "over") {
    return {
      title: `${label} is over budget`,
      body: `${money(spent)} of ${money(planned)} in ${name} — ${money(spent - planned)} over.`,
    };
  }
  // Floored, so a category a whisker under its budget never reads "100%".
  const pct = Math.floor((spent / planned) * 100);
  return {
    title: `${label} is at ${pct}% of its budget`,
    body: `${money(spent)} of ${money(planned)} in ${name} — ${money(planned - spent)} left.`,
  };
}

/**
 * Look at this person's month and tell their phones anything new.
 *
 * Opens and closes its own connection: it runs after a response has already
 * gone, when whatever connection the request had is being closed.
 */
export async function checkBudgetAlerts(env: Env, userId: string): Promise<void> {
  if (!pushConfigured(env)) return;

  const { db, ready, close } = getDb(env);
  try {
    await ready;

    const chosen = new Set(
      (await db.select({ categoryId: budgetAlertSubscriptions.categoryId })
        .from(budgetAlertSubscriptions)
        .where(eq(budgetAlertSubscriptions.userId, userId)))
        .map((row) => row.categoryId),
    );
    if (!chosen.size) return;

    const devices = await db.select().from(pushDevices).where(eq(pushDevices.userId, userId));
    if (!devices.length) return;

    const today = new Date();
    const standing = await monthStanding(db, userId, today);
    if (!standing || !standing.budget.available) return;

    const month = learnWindow(today).currentKey;
    const said = new Map(
      (await db.select().from(budgetAlertStates).where(and(
        eq(budgetAlertStates.userId, userId), eq(budgetAlertStates.month, month),
      ))).map((row) => [row.categoryId, row]),
    );

    let phones = devices;
    for (const cat of standing.ctx.list) {
      // Chosen, and a spending subcategory -- anything else was never alertable.
      if (!chosen.has(cat.id) || !cat.parentSlug || cat.kind !== "spend") continue;

      const planned = standing.budget.byCategory[cat.slug] ?? 0;
      const spent = standing.spentByCategory[cat.slug] ?? 0;
      const level = levelFor(spent, planned);
      if (!level) continue;

      const before = said.get(cat.id);
      if (before?.acknowledgedAt) continue;             // muted until the month turns
      if (rank(level) <= rank(before?.level)) continue;  // already said this, or more

      const { title, body } = wording(cat.label, level, spent, planned, month);
      let delivered = 0;
      const kept: typeof devices = [];
      for (const phone of phones) {
        const result = await sendPush(env, phone, {
          title, body,
          category: "BUDGET_ALERT",
          threadId: `budget-${month}`,
          // "Over" replaces "nearly spent" rather than stacking beneath it.
          collapseId: `b-${cat.id}-${month}`,
          data: { categoryId: cat.id, month, level },
        });
        if (result.ok) delivered++;
        if (result.gone) {
          await db.delete(pushDevices).where(eq(pushDevices.id, phone.id));
        } else {
          kept.push(phone);
          if (!result.ok) console.warn(`push to a device failed: ${result.reason}`);
        }
      }
      phones = kept;

      /* Recorded only once something reached a phone. If every send failed,
         the next sync tries again rather than believing it had spoken. */
      if (!delivered) {
        if (!phones.length) return;
        continue;
      }
      await db.insert(budgetAlertStates)
        .values({ userId, categoryId: cat.id, month, level, notifiedAt: new Date() })
        .onConflictDoUpdate({
          target: [budgetAlertStates.userId, budgetAlertStates.categoryId, budgetAlertStates.month],
          set: { level, notifiedAt: new Date() },
        });
    }
  } finally {
    await close().catch(() => {});
  }
}

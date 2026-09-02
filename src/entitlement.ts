/**
 * What a person is allowed to do, and when their free month starts.
 *
 * ── Why this exists before billing does ─────────────────────────────────────
 *
 * There is no payment processor, no price being charged and no way for anybody
 * to lapse. This module is written anyway, because the two things it decides —
 * when the free month begins, and what happens when it ends — are much easier
 * to get right before there are users than after. The trial clock in particular
 * cannot be reconstructed later: if it does not start at the right moment now,
 * the first cohort's free month is simply wrong and nobody can say by how much.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The free month starts on the first bank connection, not at sign-up.
 *
 * Sign-up is the wrong moment. Somebody invited on a Tuesday who connects a
 * bank the following weekend would lose five days of a thirty-day trial to
 * waiting, and somebody who signs up during a week when the app is broken would
 * lose all of it. The product starts working when there is data in it, so that
 * is when the clock starts.
 *
 * ── What lapsing does ───────────────────────────────────────────────────────
 *
 * Read-only. A lapsed account keeps every figure it had; what stops is adding
 * to it — no new bank connections, no re-categorising, no edits to the plan.
 *
 * That is a deliberate choice over locking the account. Somebody who cannot
 * see their own financial history has no reason to come back and every reason
 * to resent the app that took it; somebody who can see it, and is one payment
 * away from being able to change it again, has both. It is also the kinder
 * reading of what the data is: theirs, held here.
 */

export type Plan = "trial" | "active" | "free" | "lapsed";

export interface Entitled {
  plan: Plan;
  planUntil: Date | null;
}

/** How long the free month is. One calendar month, not thirty days. */
export const TRIAL_MONTHS = 1;

/**
 * When a trial starting now should end.
 *
 * Calendar months rather than a day count, so a trial beginning on the 31st of
 * January ends on the 28th of February.
 *
 * JavaScript does NOT do this for you, which is what the first version of this
 * function assumed. setUTCMonth on the 31st of January produces the 31st of
 * February, which overflows to the 3rd of March — a month later than intended
 * and, once this date anchors real billing, a date that drifts further every
 * cycle. Clamping to the last day of the target month is what Stripe does and
 * what anybody reading "a month" expects.
 *
 * The dance is: move to the 1st before shifting the month, so the shift cannot
 * overflow; then set the day back, capped at what the target month actually
 * has. Time of day is left alone.
 */
export function trialEnd(from: Date): Date {
  const end = new Date(from);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + TRIAL_MONTHS);
  const lastOfMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastOfMonth));
  return end;
}

/**
 * Whether this account may still change things.
 *
 * Everything except an expired trial or an explicit lapse is a yes. Note what
 * is NOT consulted: `active` with a planUntil in the past still reads as
 * writable, because a paid period ending is not the same event as a payment
 * failing — Stripe decides that, and until it says so the benefit of the doubt
 * belongs to the person who paid.
 */
export function canWrite(u: Entitled, now: Date = new Date()): boolean {
  if (u.plan === "free" || u.plan === "active") return true;
  if (u.plan === "lapsed") return false;
  // trial: writable until it runs out, and before it has started.
  return u.planUntil === null || u.planUntil > now;
}

/** Why a write was refused, in words a person could be shown. */
export function whyReadOnly(u: Entitled, now: Date = new Date()): string | null {
  if (canWrite(u, now)) return null;
  if (u.plan === "lapsed") {
    return "Your subscription has ended. Everything already here stays visible — " +
           "adding or changing needs an active subscription.";
  }
  return "Your free month has ended. Everything already here stays visible — " +
         "adding or changing needs a subscription.";
}

/**
 * What a person is allowed to do, and when their free trial starts.
 *
 * ── Why this exists before billing does ─────────────────────────────────────
 *
 * There is no payment processor, no price being charged and no way for anybody
 * to lapse. This module is written anyway, because the two things it decides —
 * when the free trial begins, and what happens when it ends — are much easier
 * to get right before there are users than after. The trial clock in particular
 * cannot be reconstructed later: if it does not start at the right moment now,
 * the first cohort's trial is simply wrong and nobody can say by how much.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The free trial starts on the first bank connection, not at sign-up.
 *
 * Sign-up is the wrong moment. Somebody invited on a Tuesday who connects a
 * bank the following weekend would lose five days of a fourteen-day trial to
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

/**
 * How long the free trial is: fourteen days.
 *
 * It was a calendar month. Plaid bills a connection for every calendar month it
 * exists in, whole and unprorated, so a month-long trial crosses into a second
 * billing month almost every time and costs two fees per bank for somebody who
 * never pays. Fourteen days crosses about half the time. It is still two
 * paycheques for anybody paid fortnightly and two weekends of spending, and the
 * dashboards are full on day one because Plaid brings two years of history with
 * the first connection -- nothing here needs a month to show what it does.
 *
 * Trials already running keep the end date they were given; this is only read
 * when a clock starts.
 */
export const TRIAL_DAYS = 14;

/**
 * How many banks a trial may connect. Once subscribed there is no limit.
 *
 * Each connection is a monthly fee at Plaid whether or not anybody pays us, so
 * this is what bounds the cost of a trial that goes nowhere: two banks, for at
 * most two billing months, before the lapse job closes them. One login covers
 * every account at that bank, so two is somebody's main bank and a card.
 */
export const TRIAL_MAX_BANKS = 2;

/**
 * How long after access ends the bank connections are kept open.
 *
 * Long enough for somebody who meant to subscribe and was a few days late not to
 * come back to a Banks page asking them to connect everything again. Short
 * enough that a trial nobody pays for stops costing a fee within the week.
 */
export const LAPSE_GRACE_DAYS = 7;

/**
 * A date n calendar months on, clamped to the end of the target month.
 *
 * JavaScript does NOT do this for you, which is what the first version of
 * trialEnd assumed. setUTCMonth on the 31st of January produces the 31st of
 * February, which overflows to the 3rd of March — a month later than intended
 * and, once this date anchors real billing, a date that drifts further every
 * cycle. Clamping is what Stripe does and what "a month" means.
 *
 * The dance is: move to the 1st before shifting the month, so the shift cannot
 * overflow; then set the day back, capped at what the target month actually
 * has. Time of day is left alone.
 *
 * Exported because the admin route grants free periods too, and had its own
 * three-line version carrying the identical bug. One implementation, so a
 * date arrived at by two paths is the same date.
 */
export function addMonths(from: Date, months: number): Date {
  const end = new Date(from);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastOfMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastOfMonth));
  return end;
}

/** When a trial starting at `from` should end. */
export function trialEnd(from: Date): Date {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
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
  return "Your free trial has ended. Everything already here stays visible — " +
         "adding or changing needs a subscription.";
}

/**
 * The refusal a write route sends, or null when the write may go ahead.
 *
 * 402 rather than 403: nothing is forbidden, it is waiting on a payment, and a
 * client can tell the two apart without reading the words. `reason` is the
 * sentence to show; both apps already surface `reason` from an error body.
 *
 * Deliberately NOT applied to: disconnecting a bank, deleting the account,
 * billing, turning alerts off on a phone, or signing out. Somebody whose access
 * has ended must still be able to leave, and to stop what we hold.
 */
export function writeRefusal(u: Entitled, now: Date = new Date()):
  { error: "read_only"; reason: string } | null {
  const why = whyReadOnly(u, now);
  return why ? { error: "read_only", reason: why } : null;
}

/** The refusal for a trial that already has as many banks as it may. */
export function trialBankLimit(u: Entitled, openBanks: number):
  { error: "trial_bank_limit"; reason: string; limit: number } | null {
  if (u.plan !== "trial" || openBanks < TRIAL_MAX_BANKS) return null;
  return {
    error: "trial_bank_limit",
    limit: TRIAL_MAX_BANKS,
    reason: `Your free trial includes ${TRIAL_MAX_BANKS} bank connections. ` +
            "Subscribe to connect more — there is no limit once you do.",
  };
}

/**
 * Which merchants are charging you on a subscription.
 *
 * ── Why this is a rule and not a field ──────────────────────────────────────
 *
 * Nothing in the data says "subscription". Plaid has a category called
 * ENTERTAINMENT_TV_AND_MOVIES, which catches Netflix and misses the gym, the
 * insurance and the storage unit; and it has a recurring-streams product we do
 * not buy. So the answer has to be worked out from the ledger itself, which is
 * fine, because the ledger is where the evidence actually is: a subscription is
 * a charge that comes back every month for about the same money.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * For one merchant, over the window given:
 *
 *   1. At least three charges. Two is a coincidence — any pair of visits to
 *      the same shop a month apart at a similar price would qualify, and the
 *      column would be wrong more often than right.
 *   2. Every gap between consecutive charges is a month: 26 to 35 days. The
 *      spread is for billing dates that slide off weekends and for the 28-day
 *      February, not for "roughly monthly".
 *   3. Every step in price either holds or goes up. Holding means within 1% —
 *      the 99% test. Going up means anything from 1% to 50%, because
 *      subscriptions do rise and a rise is not a different charge.
 *   4. A drop of more than 1% disqualifies the whole merchant. This is the
 *      single load-bearing asymmetry: variable spending — groceries, coffee,
 *      restaurants — wanders in both directions, and it only has to wander
 *      down once to be excluded. Subscription prices essentially never fall.
 *   5. At least half the steps have to be holds rather than rises. A price
 *      that goes up every single month is not a subscription getting more
 *      expensive, it is a variable cost that happens to be climbing.
 *
 * ── What this deliberately misses ───────────────────────────────────────────
 *
 * The whole series has to be clean, not merely some run inside it. So a
 * merchant you also buy other things from — Amazon with Prime among the
 * orders — is not flagged, because the orders break the cadence. Accepting the
 * longest clean run instead would find that Prime, and would also find any
 * three coffees that happened to fall a month apart at the same price. A miss
 * is recoverable; a column that marks Starbucks a subscription is not.
 *
 * Annual and weekly charges are not flagged either. The definition in hand is
 * a monthly one, and a yearly charge needs three years of history to prove.
 */

/** One charge. `cents` is money leaving, so it is positive for spending. */
export interface Charge {
  date: string; // YYYY-MM-DD
  cents: number;
}

export interface Verdict {
  subscription: boolean;
  /** The most recent amount charged, which is what it costs now. */
  cents: number;
  /** Date of the first charge in the run. */
  since: string;
  count: number;
  /** True where the price has gone up at least once across the run. */
  rose: boolean;
}

export const MIN_CHARGES = 3;
export const MONTH_MIN_DAYS = 26;
export const MONTH_MAX_DAYS = 35;
/** The 99% test: this much either side still counts as the same price. */
export const SAME_PRICE = 0.01;
/** A rise past this is a different charge, not the same one costing more. */
export const MAX_RISE = 0.5;
/** Holds, as a share of all the steps. */
export const MIN_HOLD_SHARE = 0.5;

const DAY = 86400000;

/** Whole days between two YYYY-MM-DD dates. UTC, so no daylight-saving drift. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
}

const NOT_A_SUBSCRIPTION: Verdict = {
  subscription: false, cents: 0, since: "", count: 0, rose: false,
};

/**
 * Judge one merchant's charges.
 *
 * Charges may arrive in any order; income and zero-value rows are dropped
 * before anything is measured, because a refund is not a step down in price
 * and a $0 trial is not a price at all.
 */
export function judge(charges: Charge[]): Verdict {
  const paid = charges
    .filter((c) => c.cents > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (paid.length < MIN_CHARGES) return NOT_A_SUBSCRIPTION;

  let holds = 0;
  let rose = false;

  for (let i = 1; i < paid.length; i++) {
    const gap = daysBetween(paid[i - 1].date, paid[i].date);
    if (gap < MONTH_MIN_DAYS || gap > MONTH_MAX_DAYS) return NOT_A_SUBSCRIPTION;

    const ratio = paid[i].cents / paid[i - 1].cents;
    if (Math.abs(ratio - 1) <= SAME_PRICE) {
      holds++;
    } else if (ratio > 1 && ratio - 1 <= MAX_RISE) {
      rose = true;
    } else {
      // A fall, or a rise too big to be the same thing.
      return NOT_A_SUBSCRIPTION;
    }
  }

  const steps = paid.length - 1;
  if (holds / steps < MIN_HOLD_SHARE) return NOT_A_SUBSCRIPTION;

  return {
    subscription: true,
    cents: paid[paid.length - 1].cents,
    since: paid[0].date,
    count: paid.length,
    rose,
  };
}

/**
 * Judge many merchants at once, keyed however the caller keys them.
 * Returns only the ones that qualify, so the caller can treat a missing key
 * as a no without having to ask twice.
 */
export function judgeAll(byKey: Map<string, Charge[]>): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const [key, charges] of byKey) {
    const v = judge(charges);
    if (v.subscription) out.set(key, v);
  }
  return out;
}

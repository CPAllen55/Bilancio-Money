/**
 * How last year's spending is brought forward, and at what rate.
 *
 * Kept apart from projection.ts deliberately: nothing in here reads a database
 * or knows what a category record looks like, so it can be exercised directly
 * against a set of figures. It is the arithmetic that decides every seasonal
 * budget in the app, and it was wrong in a way that only showed up when someone
 * checked one number against the month before it.
 *
 * THE BUG IT EXISTS TO FIX. There used to be one growth rate — this year's
 * total spending over last year's — and every category was multiplied by it.
 * That reads the ledger's story onto every line in it. Groceries running a
 * quarter below last year, inside a ledger running a fifth above, came out
 * projected a fifth ABOVE last August: the multiplier described the ledger and
 * the figure it multiplied described groceries. The answer was a budget 71%
 * over the month before it, for a category that had been falling all year.
 *
 * So a category is scaled by its OWN year-on-year rate where it has earned one,
 * and by the ledger's rate only where it has not.
 */

/** At least this many months where both years hold real spending. */
export const OWN_RATE_MIN_MONTHS = 2;
/** And at least this much of it last year, summed over those months. */
export const OWN_RATE_MIN_CENTS = 5_000;
/* Clamped, because a category that spent $4 last March and $40 this March has
   not grown tenfold — it has had an unusual month, and a projection is not the
   place to find that out. */
export const OWN_RATE_FLOOR = 0.25;
export const OWN_RATE_CEILING = 4;

/** Spending for one category in one month, in cents. */
export type SpendAt = (slug: string, month: string) => number;

/**
 * A year-on-year rate per category, for the categories that have earned one.
 *
 * `comparable` is the months already complete where both years hold spending.
 * Anything missing from the result has not earned its own rate and should fall
 * back to whatever the caller is using for the ledger as a whole.
 */
export function ownRates(
  comparable: string[],
  spendAt: SpendAt,
  priorOf: (month: string) => string,
  slugs: Iterable<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const slug of slugs) {
    const both = comparable.filter(
      (k) => spendAt(slug, k) > 0 && spendAt(slug, priorOf(k)) > 0,
    );
    if (both.length < OWN_RATE_MIN_MONTHS) continue;

    const was = both.reduce((s, k) => s + spendAt(slug, priorOf(k)), 0);
    if (was < OWN_RATE_MIN_CENTS) continue;

    const now = both.reduce((s, k) => s + spendAt(slug, k), 0);
    out[slug] = Math.min(OWN_RATE_CEILING, Math.max(OWN_RATE_FLOOR, now / was));
  }
  return out;
}

/**
 * Last year's month, scaled forward — each category at its own rate where it
 * has one, at the ledger's rate where it has not.
 */
export function scaleSpend(
  byCategory: Record<string, number>,
  ledgerRate: number,
  ownRate: Record<string, number>,
  isSpend: (slug: string) => boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, v] of Object.entries(byCategory)) {
    if (!v || !isSpend(slug)) continue;
    out[slug] = Math.round(v * (ownRate[slug] ?? ledgerRate));
  }
  return out;
}

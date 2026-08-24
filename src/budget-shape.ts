/**
 * One planning method, built from three separate questions.
 *
 * Every method this replaces answered one question well and the others badly.
 * An average knows what a normal month costs and nothing about December. A
 * trend knows where the level is heading and is wrecked by a single vet bill.
 * Seasonal knows the shape of a year and mistakes one holiday for a pattern.
 *
 * So they are asked separately and multiplied back together:
 *
 *     plan(month) = level(month) × seasonalIndex(calendar month)
 *
 * ── The vet bill and the May holiday are the same event ───────────────────
 *
 * This is the crux, and it is worth stating plainly because it is the thing
 * that makes the method work. A £1,000 vet bill and a £1,000 family holiday
 * look identical in one year of data: one month, far above the others. Nothing
 * about the size or the shape of the spike tells them apart.
 *
 * What tells them apart is whether it happens again in the same calendar month.
 * A holiday booked every May shows up in May twice. A vet bill does not choose
 * a month. So:
 *
 *   - Outliers are pulled out of the LEVEL, always. A single huge month must
 *     never become the monthly budget for a category, which is what a mean
 *     does with it.
 *
 *   - Seasonality is measured per calendar month and SHRUNK toward 1 according
 *     to how many years agree. One anomalous May barely moves May's index; two
 *     or three consistent Mays move it a long way. That shrinkage is the entire
 *     difference between "your travel budget is heavy in May" and "your travel
 *     budget is heavy in May because of one trip in 2025".
 *
 * ── What happens to the money that was excluded ───────────────────────────
 *
 * It is not thrown away, because vet bills do recur — just not on a schedule.
 * The excess above a normal month is totalled and spread across the window as
 * `irregularPerMonth`, so the honest budget is "£480 a month for groceries,
 * plus £35 a month set aside for the months that are not normal". Reporting it
 * separately is the point: it is a different kind of number and mixing it into
 * the monthly figure is what made the old methods feel wrong.
 */

/* A month is irregular when its modified z-score clears this. The score uses
   the median absolute deviation rather than the standard deviation, because a
   standard deviation is itself inflated by the outlier it is meant to find —
   one £1,000 month makes the threshold high enough to admit itself. 3.5 is the
   conventional cut for this statistic. */
export const OUTLIER_Z = 3.5;

/* One occurrence is never a season.
 *
 * This single rule is what separates the vet bill from the holiday, and it does
 * more work than the shrinkage below. A March that was expensive once has no
 * calendar meaning — nothing says vet bills prefer March. A May that was
 * expensive in two consecutive years is making a claim about Mays. So a
 * calendar month with fewer than two observations gets an index of exactly 1,
 * and its spike falls through to the outlier test instead. */
export const MIN_SEASONAL_OBS = 2;

/* How fast a calendar month earns its seasonality once it qualifies. Two
   observations move the index two thirds of the way from 1 toward what the data
   says, three move it three quarters. Deliberately conservative: a budget that
   under-shoots a known-heavy month is recoverable, one that over-shoots every
   month is just a bigger budget. */
export const SEASONAL_SHRINK = 1;

/* Below this there is no shape worth fitting and the answer is a flat level. */
export const MIN_MONTHS_FOR_SHAPE = 6;

/* Even a real pattern is capped. Eight is high enough not to bind on an
   ordinary Christmas or an annual insurance premium, and low enough that a
   category which happens to be near-zero for eleven months cannot produce a
   twelfth month budgeted at forty times nothing. */
export const INDEX_FLOOR = 0.2;
export const INDEX_CEILING = 12;

/* Two occurrences only count as a pattern if they AGREE.
 *
 * The count alone is not enough, and this is where it bites: over two years,
 * every calendar month has exactly two observations. A vet bill in March 2025
 * against a normal March 2024 gives March the pair [£1,000, £80] — two
 * observations, and with only two the median is their midpoint, so March would
 * be handed an index of six and the vet bill would become an annual event.
 *
 * Requiring the two to land within a factor of two of each other is what makes
 * "did it repeat" mean what it should. A holiday costing £900 and then £950 is
 * a pattern. £1,000 and then £80 is one bill and one ordinary month. */
export const SEASONAL_AGREEMENT = 0.5;

export interface Outlier {
  month: string;
  amount: number;
  /** How much of it was above a normal month — the part that is set aside. */
  excess: number;
}

export interface Shape {
  /** Cents per month for each month asked for, keyed "YYYY-MM". */
  plan: Record<string, number>;
  /** What a normal month costs, before seasonality and before the trend. */
  baseline: number;
  /** Months left out of the baseline as one-offs. */
  outliers: Outlier[];
  /** Their excess, spread evenly — money to set aside, not to budget monthly. */
  irregularPerMonth: number;
  /** Multiplier per calendar month, index 0 = January. 1 means average. */
  seasonal: number[];
  /** Months of history the shape was built from, outliers included. */
  monthsUsed: number;
  /** Whether the seasonal half of the answer has anything behind it. */
  basis: "none" | "flat" | "trend" | "seasonal";
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Median absolute deviation — the median of the distances from the median.
 *
 * Scaled by 1.4826 so that on normally distributed data it estimates the same
 * quantity a standard deviation does, which is what makes the 3.5 threshold
 * mean the conventional thing.
 */
export function mad(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Which months are one-offs rather than normal months.
 *
 * Only the high side. A month where nothing was spent on a category is a real
 * month with a real answer of zero, and dropping it would quietly raise every
 * budget by pretending the quiet months did not happen.
 */
export function findOutliers(months: string[], values: number[]): Set<number> {
  const out = new Set<number>();
  if (values.length < 4) return out;   // too few for the spread to mean anything

  const m = median(values);
  const deviations = values.map((v) => Math.abs(v - m));

  /* The MAD-is-zero case, and it is not a corner — it is the main case here.
   *
   * Eleven months of exactly £80 and one of £1,000 gives eleven deviations of
   * zero and one of £920, whose median is zero. A zero scale makes the test
   * undefined, and guarding by giving up finds no outlier in the very shape
   * this function exists to catch: a steady category with one spike in it.
   *
   * The conventional remedy is Iglewicz and Hoaglin's: fall back to the MEAN
   * absolute deviation, with its own consistency constant. It is less robust
   * than the median version, which is exactly why it is the fallback rather
   * than the default — but a scale that is merely less robust beats one that
   * is zero. */
  let scale = 1.4826 * median(deviations);
  let k = 0.6745;
  if (scale <= 0) {
    const meanAD = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    scale = 1.253314 * meanAD;
    k = 1;
  }
  // Every month genuinely identical. Nothing deviates, so nothing is an outlier.
  if (scale <= 0) return out;

  for (let i = 0; i < values.length; i++) {
    if (k * (values[i] - m) / scale > OUTLIER_Z) out.add(i);
  }
  return out;
}

/**
 * The multiplier for each calendar month, shrunk toward 1 by how little is
 * known.
 *
 * Built only from normal months: including the outliers here would put the vet
 * bill's month back into the answer through the other door.
 */
export function seasonalIndex(
  months: string[],
  values: number[],
  skip: Set<number>,
): { index: number[]; observations: number[] } {
  const index = new Array(12).fill(1);
  const observations = new Array(12).fill(0);

  const kept: { cal: number; value: number }[] = [];
  for (let i = 0; i < months.length; i++) {
    if (skip.has(i)) continue;
    const cal = Number(months[i].slice(5, 7)) - 1;
    if (cal < 0 || cal > 11) continue;
    kept.push({ cal, value: values[i] });
  }
  if (!kept.length) return { index, observations };

  const overall = median(kept.map((k) => k.value));
  if (overall <= 0) return { index, observations };

  for (let cal = 0; cal < 12; cal++) {
    const mine = kept.filter((k) => k.cal === cal).map((k) => k.value);
    observations[cal] = mine.length;
    if (!mine.length) continue;

    /* One occurrence carries no calendar meaning, so it stays at 1 and its
       spike is left for the outlier test to find. This is the rule that tells
       a holiday from a vet bill. */
    if (mine.length < MIN_SEASONAL_OBS) continue;

    /* And exactly two must agree, because with two the median is just their
       midpoint and one anomaly would drag it half way. Beyond two the median
       is robust on its own and no extra test is needed. */
    if (mine.length === 2) {
      const lo = Math.min(...mine), hi = Math.max(...mine);
      if (hi <= 0 || lo / hi < SEASONAL_AGREEMENT) continue;
    }

    const raw = median(mine) / overall;
    /* Shrunk toward 1 by n/(n+k): two years that agree move it two thirds of
       the way, three move it three quarters. Never all the way, because a
       category's next year is not obliged to repeat its last two. */
    const weight = mine.length / (mine.length + SEASONAL_SHRINK);
    const shrunk = 1 + (raw - 1) * weight;
    index[cal] = Math.min(INDEX_CEILING, Math.max(INDEX_FLOOR, shrunk));
  }
  return { index, observations };
}

/** Least-squares slope and intercept over 0..n-1, or null if it cannot fit. */
function fit(values: number[]): { slope: number; intercept: number } | null {
  const n = values.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (values[i] - my); den += (i - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

const monthsApart = (a: string, b: string): number =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 +
  (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

/**
 * The whole method, for one category.
 *
 * `history` is every complete month available, oldest first. `wanted` is the
 * months to plan for. They may overlap: a month already spent still gets a
 * planned figure, which is what the chart draws behind the bars.
 */
export function shapeBudget(
  history: { month: string; amount: number }[],
  wanted: string[],
): Shape {
  const months = history.map((h) => h.month);
  const values = history.map((h) => Math.max(0, h.amount));

  const empty: Shape = {
    plan: Object.fromEntries(wanted.map((m) => [m, 0])),
    baseline: 0, outliers: [], irregularPerMonth: 0,
    seasonal: new Array(12).fill(1), monthsUsed: 0, basis: "none",
  };
  if (!history.length) return empty;

  const cal = (m: string) => Number(m.slice(5, 7)) - 1;

  /* Season first, outliers second — and the order is the whole algorithm.
   *
   * Done the other way round it destroys the thing it is looking for. The two
   * expensive Mays that MAKE May seasonal are, on the raw numbers, the two
   * biggest months in the series; an outlier pass run first removes them, and
   * the season they constitute vanishes with them. The category then reads as
   * flat with two anomalies, which is precisely the wrong answer.
   *
   * So: measure the calendar shape from everything, divide it out, and only
   * then look for what is left over. After deseasonalising, an expensive May in
   * a category whose Mays are always expensive sits at an ordinary height and
   * survives — while a vet bill in March, whose March index is 1 because one
   * March proves nothing, still towers over everything and is caught. */
  /* Measured once, from everything, and not revisited.
   *
   * Recomputing it after the outlier pass destroys exactly what it is meant to
   * find. The two expensive Mays that MAKE May seasonal are the two biggest
   * months in the series; deseasonalising leaves a residue, the outlier test
   * flags them, and the recomputation then finds May has no observations left
   * and sets its index back to 1. Measured, then flagged, then unmeasured.
   *
   * It does not need revisiting, because the agreement rule above already stops
   * a one-off from inventing a season — that was the only thing the second pass
   * was defending against. */
  const index = seasonalIndex(months, values, new Set()).index;
  const seasonalMonth = (m: string) => Math.abs(index[cal(m)] - 1) > 0.02;
  const hasSeason = index.some((v) => Math.abs(v - 1) > 0.02);

  const deseasonalised = values.map((v, i) => v / (index[cal(months[i])] || 1));

  /* A month a season already explains is not an anomaly. May is enormous, and
     the reason is known and recorded in the index; reporting it as a one-off
     would tell somebody to set aside money for the holiday they have already
     budgeted for. */
  const skip = new Set(
    [...findOutliers(months, deseasonalised)].filter((i) => !seasonalMonth(months[i])),
  );

  /* The level lives in deseasonalised space: what a month costs once its place
     in the year is divided out. Multiplying the season back on at the end is
     what puts the holiday in May rather than spreading it over twelve months. */
  const normal = history
    .map((h, i) => ({ i, h }))
    .filter(({ i }) => !skip.has(i))
    .map(({ h }) => h.amount / (index[cal(h.month)] || 1));
  const baseline = normal.length ? median(normal) : median(deseasonalised);

  /* The excess is what the month cost above what that month was expected to
     cost — not above a flat average. A £1,000 vet bill against an £80 baseline
     is £920 of one-off; the £80 was going to be spent anyway. And a big May in
     a category whose May is expected to be big has no excess at all, which is
     the correct answer and the reason this uses the seasonal expectation. */
  const outliers: Outlier[] = [...skip]
    .sort((a, b) => a - b)
    .map((i) => ({
      month: months[i],
      amount: Math.round(values[i]),
      excess: Math.round(Math.max(0, values[i] - baseline * (index[cal(months[i])] || 1))),
    }));
  const irregularPerMonth = outliers.length
    ? Math.round(outliers.reduce((s, o) => s + o.excess, 0) / Math.max(1, months.length))
    : 0;

  const deseason = normal;
  const line = months.length >= MIN_MONTHS_FOR_SHAPE ? fit(deseason) : null;
  const last = months[months.length - 1];

  const plan: Record<string, number> = {};
  for (const m of wanted) {
    let level = baseline;
    if (line) {
      const ahead = monthsApart(last, m);
      const at = line.intercept + line.slope * (deseason.length - 1 + ahead);
      /* Bounded against the baseline. A line fitted to a dozen points and run
         a year forward can reach absurd places, and a budget that quietly
         doubles because six months sloped upward is not a budget. */
      level = Math.min(baseline * 2, Math.max(baseline * 0.4, at));
    }
    plan[m] = Math.max(0, Math.round(level * (index[cal(m)] ?? 1)));
  }

  return {
    plan, baseline: Math.round(baseline), outliers, irregularPerMonth,
    seasonal: index, monthsUsed: months.length,
    basis: !line && !hasSeason ? "flat" : hasSeason ? "seasonal" : "trend",
  };
}

/**
 * Where a category is heading, from the months already behind it.
 *
 * The gap this fills. Average says a typical month and says it flat, so a
 * category that has climbed all year is budgeted at the middle of that climb —
 * under what it is about to cost. Seasonal follows a trajectory, but only where
 * there is a year of history to read it from, and most people do not have one.
 * Same as last month follows the level and none of the direction. Between them
 * there was no way to say "this is going up, plan for it going up".
 *
 * So: a least-squares line through the completed months, extended to the month
 * being asked about.
 *
 * WHAT IT IS BOUNDED BY, AND WHY. A line fitted to seven months and extended to
 * December will happily predict a number nobody will ever spend — that is what
 * extrapolation does, and it does it worse the further out it reaches and the
 * noisier the months are. So the answer is held between a quarter and three
 * times a typical month. Inside that band the trend is doing the work; outside
 * it, the band is, and it is honest to say so rather than quote a figure the
 * arithmetic cannot support.
 *
 * Nothing here reads a database. It is the arithmetic and nothing else, so it
 * can be run against a set of figures directly.
 */

/** Below this a line is fitting noise, not a trend. */
export const TREND_MIN_MONTHS = 3;
/** How far from a typical month the extrapolation is allowed to travel. */
export const TREND_FLOOR = 0.25;
export const TREND_CEILING = 3;

/** How many months separate two "YYYY-MM" keys. Negative if b precedes a. */
export function monthsApart(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * Least squares through (0, values[0]) … (n-1, values[n-1]).
 *
 * Null where there is nothing to fit — fewer than two points, or every point on
 * the same x, which cannot happen here but costs one line to rule out.
 */
export function fitLine(values: number[]): { slope: number; intercept: number } | null {
  const n = values.length;
  if (n < 2) return null;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  if (den === 0) return null;

  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * What the trend says a month will cost.
 *
 * `values` are the completed months in order, oldest first. `stepsAhead` is how
 * far the month being asked about sits past the last of them — 1 for the month
 * straight after, and so on. `typical` is what a normal month costs, used only
 * to bound the answer.
 *
 * Null where there is too little to go on, so the caller can fall back rather
 * than be handed a confident-looking guess.
 */
export function trendAt(
  values: number[],
  stepsAhead: number,
  typical: number,
): number | null {
  const usable = values.filter((v) => v > 0);
  if (usable.length < TREND_MIN_MONTHS || typical <= 0) return null;

  const line = fitLine(usable);
  if (!line) return null;

  const x = usable.length - 1 + Math.max(1, stepsAhead);
  const raw = line.intercept + line.slope * x;

  const low = typical * TREND_FLOOR;
  const high = typical * TREND_CEILING;
  return Math.round(Math.min(high, Math.max(low, Math.max(0, raw))));
}

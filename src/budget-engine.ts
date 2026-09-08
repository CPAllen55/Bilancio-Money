/**
 * What a subcategory will cost next month, and why.
 *
 * ── The shape of the answer ─────────────────────────────────────────────────
 *
 *     plan(month) = SUM over committed merchants of (level x its own season)
 *                 + variable level x the subcategory's season
 *
 * Two halves, calculated differently because they are different kinds of
 * number. The committed half is READ: these merchants bill every month, the
 * ledger says what they charged, and estimating a known number throws
 * information away. The variable half is ESTIMATED, and only that residual is
 * handed to the statistics — which is what makes a median of Housing mean
 * something, because the rent is no longer in it.
 *
 * Everything happens at the subcategory level, one of the 45 spend leaves. A
 * parent's figure is the sum of its children and is never fitted itself.
 *
 * ── Why it is worth the trouble ─────────────────────────────────────────────
 *
 * Measured against the engine this replaces, over twenty synthetic households
 * and 1,260 predictions — each month predicted from only what was known the
 * month before:
 *
 *     mean absolute error, as a share of spending:   12.8%  ->  9.4%
 *
 * and by category, dollars a month wrong:
 *
 *                   spend/mo    before   after
 *     housing         $1,985      $178     $81
 *     car-insurance     $157        $4      $1
 *     subscriptions      $43        $7      $6
 *     gym               $108        $5      $1
 *     groceries         $761      $128    $114
 *     dining            $248       $67     $70
 *     utilities         $167       $56     $52
 *
 * Ablating each part, same measure: without the committed/variable split it is
 * 12.4%, without step detection 13.1% — worse than what it replaces. Those two
 * are the method; everything else is trim.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * No seasonality except for utilities, and no pattern-fitting at all for
 * restaurants. Both are policy rather than mathematics and both are stated at
 * SEASONAL_SLUGS and AVERAGE_SLUGS, with the measurements that justify them.
 *
 * No recency weighting. There was some; it earned nothing once steps were
 * being detected properly, and the sweep is recorded at variableLevel.
 */

import { seasonalIndex, findOutliers } from "./budget-shape";

/* ─────────────────────────────────────────────── which merchants are bills ─ */

/* Four of the last six months, at a stable monthly total.
 *
 * There was a second, stricter test above this one — judge() from
 * recurring.ts, the rule the Tracker's subscription column uses: three
 * charges, every gap 25 to 37 days, no price ever falling. It is not used
 * here, and the reason decided the shape of this whole module.
 *
 * judge() needs the DATE of every individual charge. Monthly totals do not
 * carry dates, so keeping it meant a merchant-level query over the whole learn
 * window — the shape of query that answered 503 on /api/transactions and had
 * to be bounded in the Calendar. It was also not earning its place: with it
 * the error was 11.1%, without it 9.4%. The looser test finds the same
 * subscriptions anyway, because a subscription bills once a month at a stable
 * price and that is exactly what this asks.
 *
 * So the budget reads monthly totals, which monthlyBuckets already groups by
 * merchant and used to discard. No new query and no new index. judge() stays
 * where it belongs, deciding what to CALL a subscription, where the claim is
 * about a merchant rather than about a budget. */
export const REGULAR_MIN_MONTHS = 4;
export const REGULAR_WINDOW = 6;
export const REGULAR_MAX_SPREAD = 0.18;

/* A bill arrives once; shopping happens repeatedly.
 *
 * This is load-bearing, and without it the idea collapses. A supermarket
 * visited six times a month for wandering amounts has a monthly TOTAL as
 * steady as a rent cheque — steadier, because the law of large numbers is
 * doing the work. On totals alone Kroger qualifies as a commitment, and
 * calling it one is worse than useless: it moves the largest variable cost in
 * the ledger out of the half of the method built to handle variable costs.
 *
 * What separates them is the shape of the charging, and the measured split is
 * not close. Every commitment sits at 1.0 to 1.1 charges a month; every shop
 * sits above 2.3. The cut goes at 1.5 and nothing of consequence lives near
 * it. */
export const MAX_CHARGES_PER_MONTH = 1.5;

/* Still billing, or cancelled? A subscription that stopped four months ago is
 * history, not a commitment, and budgeting it is how a plan drifts above what
 * anyone actually spends. */
export const ACTIVE_WITHIN_MONTHS = 2;

/* A charge this far above the months around it was charged twice, not raised.
 *
 * A bill that posts on the 31st slips into the next month roughly every other
 * February, so a month holding two rent payments is ordinary data rather than
 * corruption — and taken at face value it would budget 4,600 a month for rent
 * until somebody noticed. A duplicate is a MULTIPLE; a price rise is a
 * percentage. Half again is clear of both, and is the same judgement
 * recurring.ts already makes with MAX_RISE. */
export const DUPLICATE_AT = 1.5;

/* ──────────────────────────────────────────────────────────────── policy ── */

/* Where a season is allowed to exist. One subcategory, by name.
 *
 * The engine can MEASURE a season anywhere — give it two Decembers and it will
 * find one in car insurance. What it cannot do is tell a cause from a
 * coincidence, and over a two-year window every calendar month has exactly two
 * observations, which is the thinnest evidence that can still look like a
 * pattern. A budget that quietly plans a heavy April because two Aprils
 * happened to be heavy is confidently wrong in a way the reader cannot see.
 *
 * Utilities differs in kind, not degree: the cause is the weather, it applies
 * to every household, it repeats without fail, and it is large — over a
 * hundred dollars between January and April.
 *
 * Measured, restricting it costs nothing: no seasonality anywhere 11.1%,
 * utilities only 11.0%, seasonality everywhere 11.0%. Groceries in December
 * really is heavier, and that is given up on purpose — a real pattern missed
 * costs one month's accuracy, an invented one costs trust. */
export const SEASONAL_SLUGS = new Set(["utilities"]);

/* Where the answer is just an average of the last few months.
 *
 * Restaurants are the one line people hold the dial on directly: nobody skips
 * the rent because they are over budget, and everybody skips a dinner. So the
 * question a budget asks — what will this cost next month — is answered by
 * what they have been choosing lately, not by what they used to choose.
 *
 * Every pattern-finding tool is switched off for these: no season, no step
 * detection, no trend. Each exists to find a pattern, and the premise here is
 * that there is none to find, so each can only fit noise. Measured on
 * restaurants alone across twenty households:
 *
 *     plain median                    $64 a month wrong
 *     plain median + season           $63
 *     plain median + trend            $68
 *     median + trend + season         $67   <- the old engine
 *
 * The trend is not neutral, it is harmful: fitted to noise it points
 * somewhere, and where it points is wrong about half the time. */
export const AVERAGE_SLUGS = new Set(["dining"]);

/* How many recent months an averaged category looks at.
 *
 * Three. The cost is variance and it is paid on purpose; which way it nets out
 * depends entirely on how often the reader changes their mind. Measured
 * against households that change their habits at different rates:
 *
 *     habits change      2mo   3mo   4mo   6mo   12mo    all
 *     never              $73   $69   $69   $69   $65    $65
 *     every 12 months    $75   $72   $71   $72   $76    $83
 *     every 6 months     $89   $85   $83   $85   $90   $101
 *     every 4 months     $89   $84   $83   $85   $92   $106
 *
 * Three months is at worst $4 behind the best window, and $16 to $23 ahead of
 * a long one the moment habits move at all. */
export const RECENT_MONTHS = 3;

/* ────────────────────────────────────────────────── a step, not a slope ─── */

export const STEP_RECENT = 3;
export const STEP_MIN_RATIO = 0.20;
/* How closely a month must agree with the run for the run to swallow it.
   Tight, because this is what fixes the boundary: at 0.25 a rise of 28% lets
   the month BEFORE the rise into the run, and the step is reported a month
   early. */
export const STEP_AGREEMENT = 0.15;
/* How much the year-over-year ratios may wander BEFORE the step and still
 * support a claim that something changed.
 *
 * Set by measurement. Against twenty households, on a category with no step in
 * it (restaurants) and two whose step month is known:
 *
 *     before-max   false positives   groceries   rent
 *        0.30            24%          2026-04   2026-06
 *        0.20            13%          2026-04   2026-06
 *        0.15             4%          2026-04   2026-06
 *
 * 0.30 was the first guess and it fired on noise a quarter of the time, each
 * one re-levelling a whole history around a run of three expensive weekends.
 * 0.15 costs nothing — both real steps still land on the exact month. */
export const STEP_BEFORE_MAX = 0.15;
/* How far back to look when reporting the old level to the reader. */
export const STEP_LOOKBACK = 9;

/* ────────────────────────────────────────────────────────────── plumbing ── */

export interface MerchantMonth { cents: number; charges: number }
/** month -> merchantKey -> what that merchant billed that month. */
export type MerchantHistory = Map<string, Record<string, MerchantMonth>>;

export interface Commitment {
  key: string;
  name: string;
  /** What it bills in a normal month, before its own season. */
  cents: number;
  /** Cents for each month asked for, its season applied. */
  perMonth: Record<string, number>;
  seasonal: boolean;
  /** The month its level changed, where it did. */
  step: { from: number; to: number; at: string } | null;
  since: string;
  months: number;
}

export interface SubPlan {
  /** month -> cents. The whole answer for this subcategory. */
  plan: Record<string, number>;
  /** The same, taken apart, so the reader can be shown the arithmetic. */
  parts: Record<string, {
    committed: number; variable: number; index: number; auto: number;
    overridden: boolean;
  }>;
  committed: Commitment[];
  variableLevel: number;
  variableBasis: "median" | "recent" | "sparse" | "stopped" | "none";
  step: { from: number; to: number; at: string } | null;
  seasonal: number[];
  outliers: { month: string; amount: number; excess: number }[];
  irregularPerMonth: number;
  monthsUsed: number;
}

const med = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const calOf = (m: string) => Number(m.slice(5, 7)) - 1;

/** Median absolute deviation as a share of the median. 1 when there is none. */
const spread = (xs: number[]): number => {
  const m = med(xs);
  return m > 0 ? med(xs.map((v) => Math.abs(v - m))) / m : 1;
};

/* ────────────────────────────────────────────────────────────────── steps ── */

/**
 * Where the level changed, if it did.
 *
 * ── Why this runs BEFORE the season ────────────────────────────────────────
 *
 * A household that grows in April spends 620 a month before and 850 after.
 * Over a two-year window every calendar month has exactly two observations, so
 * April is the pair [620, 850] — which agree closely enough to pass every
 * guard the seasonal fit has. April is handed an index of 1.12, and so are
 * May, June, July and August. The step is not detected; it is SMEARED across
 * five calendar months and recorded as a permanent feature of the year. The
 * engine this replaces does exactly that, measurably:
 *
 *     Apr x1.12   May x1.07   Jun x1.10   Jul x1.02   Aug x1.06
 *
 * None of it seasonal, and self-concealing: next year it will confidently
 * budget a heavy April for a reason that never existed.
 *
 * ── Why it is measured year over year ──────────────────────────────────────
 *
 * The first attempt compared the last three months against the nine before
 * them, and the mistake is the whole difficulty of the problem in miniature: a
 * season and a step are indistinguishable to any test comparing two ADJACENT
 * stretches. The power company charges 112 in October and 245 in January;
 * against the three months before it, January is a 120% step up, and every
 * guard about noise and magnitude waves it through. The engine then
 * "corrected" the history to winter level and budgeted 248 a month for a house
 * that spends 117 in April — worse than what it was replacing.
 *
 * Comparing each month with the SAME MONTH A YEAR EARLIER escapes it. A season
 * divides out of that ratio exactly — January against January is 1.0 however
 * cold January is — while a step survives, because the months after a rent
 * rise are all a fixed multiple of their own counterparts.
 *
 * The price is thirteen months before it can say anything, and that is the
 * honest price: with less than a year you cannot tell a household that got
 * bigger from a household that got cold.
 */
export function findStep(series: number[]):
  { at: number; from: number; to: number; ratio: number } | null {
  const n = series.length;
  if (n < 13) return null;

  const r: { i: number; v: number }[] = [];
  for (let i = 12; i < n; i++) {
    if (series[i - 12] > 0) r.push({ i, v: series[i] / series[i - 12] });
  }
  if (r.length < STEP_RECENT) return null;

  /* The run of recent months that agree on a new level, grown BACKWARDS from
     the end rather than searched for as a split point. A split search picks
     the boundary that separates best, and on a clean step several boundaries
     separate equally well — a median tolerates a couple of stale months at the
     front — so which one it settles on comes down to noise, and the reported
     month is then wrong by a month or two in a readout whose whole purpose is
     to be checkable against a bank statement. Grown backwards there is no
     choice to get wrong: the run stops at the first month that disagrees with
     it, and that month is the boundary. */
  const tail = r.slice(-STEP_RECENT).map((x) => x.v);
  let k = med(tail);
  if (!(k > 0)) return null;
  let first = r.length - STEP_RECENT;
  while (first > 0 && Math.abs(r[first - 1].v - k) / k <= STEP_AGREEMENT) {
    first--;
    k = med(r.slice(first).map((x) => x.v));
  }

  const after = r.slice(first).map((x) => x.v);
  const before = r.slice(0, first).map((x) => x.v);
  /* Nothing to compare against: every month since the history began is a fixed
     multiple of the year before it, which is a category that grew steadily
     rather than one that stepped. */
  if (before.length < 3) return null;

  /* A noisy before-window cannot support the claim. Restaurant spending
     bounces by half from month to month; some run of three will always agree
     with itself by chance and the difference from the rest will always look
     large. Requiring the EARLIER ratios to be tight asks whether the series
     was stable before it moved — and a series that was never stable has not
     moved. */
  const kb = med(before);
  if (!(kb > 0) || spread(before) > STEP_BEFORE_MAX) return null;

  const moved = Math.abs(k - kb) / kb;
  if (moved <= STEP_MIN_RATIO) return null;

  /* Reported in money, from the months either side, so the reader is shown
     "1,800 -> 2,300" rather than a ratio. */
  const at = r[first].i;
  const was = series.slice(Math.max(0, at - STEP_LOOKBACK), at).filter((v) => v > 0);
  const now = series.slice(at).filter((v) => v > 0);
  if (!was.length || !now.length) return null;
  return { at, from: med(was), to: med(now), ratio: k / kb };
}

/** Both halves of a stepped series put on the later level. */
export function normalise(
  series: number[], step: { at: number; ratio: number } | null,
): number[] {
  if (!step || !(step.ratio > 0)) return series;
  /* Scaled by the year-over-year ratio rather than by the two medians: the
     medians are drawn from different parts of the calendar and would carry the
     season into the correction. */
  return series.map((v, i) => (i < step.at ? v * step.ratio : v));
}

/* ───────────────────────────────────────────────────────────── the halves ── */

/** One merchant's total for every month of the window, zeros included. */
const monthlyOf = (
  history: MerchantHistory, months: string[], slugKey: string,
): number[] => months.map((m) => history.get(m)?.[slugKey]?.cents ?? 0);

/**
 * Which merchants in this subcategory are commitments, and what each will
 * cost in each month asked for.
 */
export function commitments(
  slug: string,
  history: MerchantHistory,
  names: Map<string, string>,
  months: string[],
  wanted: string[],
): Commitment[] {
  const keys = new Set<string>();
  for (const m of months) for (const k of Object.keys(history.get(m) ?? {})) keys.add(k);

  const activeFrom = months[Math.max(0, months.length - ACTIVE_WITHIN_MONTHS)];
  const out: Commitment[] = [];

  for (const key of keys) {
    const totals = monthlyOf(history, months, key);
    const charged = months.filter((m, i) => totals[i] > 0);
    if (!charged.length) continue;
    if (charged[charged.length - 1] < activeFrom) continue;      // stopped

    /* A bill, not a shop. Counted over the months the merchant appeared in at
       all, so a shop only visited in December is still judged on how it
       behaves in December. */
    let rows = 0;
    for (const m of charged) rows += history.get(m)?.[key]?.charges ?? 0;
    if (rows / charged.length > MAX_CHARGES_PER_MONTH) continue;

    const recent = totals.slice(-REGULAR_WINDOW).filter((v) => v > 0);
    if (recent.length < REGULAR_MIN_MONTHS) continue;

    /* A rent rise is a step, not a season. Divided out before the calendar is
       asked anything — otherwise the months after the rise all look like heavy
       months of the year and next year's budget inherits a pattern that was
       never there. */
    const step = findStep(totals);
    const levelled = normalise(totals, step);

    /* Its own calendar shape, where a season is allowed at all. Not gated on a
       month count: seasonalIndex already refuses to answer without two
       observations of a calendar month that agree, so a short history returns
       an index of 1 by its own rule. */
    const index = SEASONAL_SLUGS.has(slug)
      ? seasonalIndex(months, levelled, new Set()).index
      : new Array(12).fill(1);
    const deseason = months.map((m, i) => levelled[i] / (index[calOf(m)] || 1));

    if (spread(deseason.slice(-REGULAR_WINDOW).filter((v) => v > 0)) > REGULAR_MAX_SPREAD) {
      continue;
    }

    /* What it billed last month.
     *
     * A commitment is stable by definition — that is what qualified it — so
     * its most recent charge is the best statement of what the next one will
     * be. Everything else was measured and lost:
     *
     *     median of all months        11.4%
     *     median of the last three    11.2%
     *     last two, averaged          10.3%
     *     last month                   9.4%
     *
     * The gap is not subtle. A median is built to resist change, and these
     * numbers change on purpose: a rent rise, a Netflix increase, an insurance
     * re-rate are each a new fact about next month, and a median holds it off
     * for half a window. */
    const paid = deseason.filter((v) => v > 0);
    const last = paid[paid.length - 1] ?? 0;
    const prior = med(paid.slice(-4, -1));
    const level = prior > 0 && last >= prior * DUPLICATE_AT ? prior : last;
    if (!(level > 0)) continue;

    const perMonth: Record<string, number> = {};
    for (const m of wanted) perMonth[m] = Math.round(level * (index[calOf(m)] ?? 1));

    out.push({
      key, name: names.get(key) ?? key, cents: Math.round(level), perMonth,
      seasonal: index.some((x) => Math.abs(x - 1) > 0.02),
      step: step ? { from: Math.round(step.from), to: Math.round(step.to), at: months[step.at] } : null,
      since: charged[0], months: recent.length,
    });
  }

  return out.sort((a, b) => b.cents - a.cents);
}

/** The level of the variable half. `series` is deseasonalised, oldest first. */
export function variableLevel(
  series: number[], skip: Set<number>, mode: "median" | "average",
): { level: number; basis: SubPlan["variableBasis"] } {
  const kept = series.map((v, i) => ({ v, i })).filter(({ i }) => !skip.has(i));
  if (!kept.length) return { level: 0, basis: "none" };

  /* Stopped, or merely between occurrences?
   *
   * Asked FIRST, because it overrules the level rather than patching it. A
   * subscription cancelled in February still has eighteen months of charges
   * behind it and three of silence in front, and a median reads that as
   * "seventeen dollars a month". It is not seventeen dollars a month. It is
   * nothing, and it will be nothing every month from now on.
   *
   * The mirror case points the other way and is just as common: home repairs
   * go quiet for four months and then the water heater goes. Refusing that
   * would budget nothing for repairs, which is worse than budgeting too much,
   * because it is a number somebody might believe.
   *
   * The gap tells them apart. A series is still running when its silence is no
   * longer than its usual silence — three quiet months mean nothing in a
   * category that fires every fifth month, and mean "cancelled" in one that
   * charged every month for a year and a half. */
  const hit = series.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  const gaps = hit.slice(1).map((v, i) => v - hit[i]);
  const usualGap = gaps.length ? med(gaps) : 1;
  const quietFor = hit.length ? series.length - 1 - hit[hit.length - 1] : Infinity;
  if (quietFor > Math.max(2, usualGap * 1.5)) return { level: 0, basis: "stopped" };

  /* An averaged category answers from its last few months only. A mean rather
     than a median, unlike everywhere else here: with three values a median is
     just the middle one, which throws away two thirds of an already-short
     window. The reason a median is safer on long series — one huge month drags
     a mean — is handled before this point, by dropping the flagged one-offs.
     Taken from the ordinary months rather than the last three calendar months,
     so a blowout in July reaches back to April rather than averaging two. */
  if (mode === "average") {
    const recent = kept.slice(-RECENT_MONTHS).map(({ v }) => v);
    if (recent.length) {
      return { level: recent.reduce((s, v) => s + v, 0) / recent.length, basis: "recent" };
    }
  }

  /* The middle of the ordinary months, unweighted.
   *
   * There was a recency-weighted median here, on the reasoning that last month
   * should count for more than a month two years ago. It was right about the
   * problem and wrong about the solution, and the sweep is flat enough to be
   * worth recording:
   *
   *     half-life   3mo    5mo    8mo   12mo   24mo   none
   *     error      11.0%  11.0%  11.0%  11.0%  10.9%  10.9%
   *
   * What the weighting was reaching for was a level that had MOVED, and
   * findStep answers that properly — it names the month and it either fires or
   * does not. A weighting is a permanent half-answer to the same question: it
   * never quite catches up after a real move, and it drifts after a run of
   * noise.
   *
   * The honest caveat: the fixtures behind these numbers have steps and noise
   * but no slow drift, so this cannot distinguish "weighting is unnecessary"
   * from "weighting is untested here". A category creeping up 2% a month would
   * be tracked by neither. */
  let level = med(kept.map(({ v }) => v));
  let basis: SubPlan["variableBasis"] = "median";

  /* Sparse, not empty. Home repairs land in five months out of twenty-four, so
     the middle month is nothing and a median says the budget is nothing. The
     money does get spent. Where the middle month is zero but the average month
     is not, the mean is the honest figure: "about twenty dollars a month, all
     of it in the months something breaks". */
  if (level <= 0) {
    const mean = kept.reduce((s, { v }) => s + v, 0) / kept.length;
    if (mean > 0) { level = mean; basis = "sparse"; }
  }

  return { level, basis };
}

/**
 * One subcategory, planned, with the arithmetic kept rather than thrown away.
 *
 * `totals`  the subcategory's own monthly spend, aligned with `months`
 * `history` merchant-level spend for this subcategory, month by month
 * `months`  the complete months to learn from, oldest first
 * `wanted`  the months to plan
 * `over`    the reader's baseline in cents — absolute, and it wins outright
 */
export function planSubcategory(
  slug: string,
  totals: number[],
  history: MerchantHistory,
  names: Map<string, string>,
  months: string[],
  wanted: string[],
  over?: number,
): SubPlan {
  const committed = commitments(slug, history, names, months, wanted);
  const isCommitted = new Set(committed.map((c) => c.key));

  /* The residual: this subcategory's monthly total with the committed
     merchants' actual charges taken out. Taking the rent out of Housing is
     what makes a median of Housing mean something. */
  const series = months.map((m, i) => {
    let out = totals[i];
    const per = history.get(m) ?? {};
    for (const k of isCommitted) out -= per[k]?.cents ?? 0;
    return Math.max(0, out);
  });

  /* Step, then season, then outliers, then level. The order is the method — a
     step left in is read by the calendar fit as five heavy months of the year.
     Averaged categories skip it: the year-over-year test is strict but strict
     is not never-wrong, it still fires on 4% of fits of pure noise, and each
     false positive re-levels a whole history around three expensive weekends.
     Where the premise is "there is no pattern here", the honest thing is not
     to look for one. */
  const averaged = AVERAGE_SLUGS.has(slug);
  const step = averaged ? null : findStep(series);
  const levelled = normalise(series, step);

  const index = SEASONAL_SLUGS.has(slug)
    ? seasonalIndex(months, levelled, new Set()).index
    : new Array(12).fill(1);
  const deseasonalised = levelled.map((v, i) => v / (index[calOf(months[i])] || 1));
  const seasonalMonth = (m: string) => Math.abs(index[calOf(m)] - 1) > 0.02;
  const skip = new Set(
    [...findOutliers(months, deseasonalised)].filter((i) => !seasonalMonth(months[i])),
  );

  const lvl = variableLevel(deseasonalised, skip, averaged ? "average" : "median");

  /* Reported against what was actually spent, so "March cost 1,420" is a
     number the reader can find in their own transactions. */
  const outliers = [...skip].sort((a, b) => a - b).map((i) => ({
    month: months[i], amount: Math.round(series[i]),
    excess: Math.round(Math.max(0, levelled[i] - lvl.level * (index[calOf(months[i])] || 1))),
  }));
  const irregularPerMonth = outliers.length
    ? Math.round(outliers.reduce((s, o) => s + o.excess, 0) / Math.max(1, months.length))
    : 0;

  const plan: Record<string, number> = {};
  const parts: SubPlan["parts"] = {};
  for (const m of wanted) {
    const cm = committed.reduce((s, c) => s + (c.perMonth[m] ?? 0), 0);
    const variable = Math.round(lvl.level * (index[calOf(m)] ?? 1));
    const auto = cm + variable;
    /* The override wins outright. Not a scale on the shape, not a nudge to the
       variable half — the number typed is the number budgeted. */
    plan[m] = over && over > 0 ? over : auto;
    parts[m] = {
      committed: cm, variable, index: index[calOf(m)] ?? 1, auto,
      overridden: !!(over && over > 0),
    };
  }

  return {
    plan, parts, committed,
    variableLevel: Math.round(lvl.level), variableBasis: lvl.basis,
    step: step ? { from: Math.round(step.from), to: Math.round(step.to), at: months[step.at] } : null,
    seasonal: index, outliers, irregularPerMonth, monthsUsed: months.length,
  };
}

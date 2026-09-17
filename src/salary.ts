/**
 * Salary & Wages, planned from the paycheques themselves.
 *
 * ── Why salary is not planned like the rest of income ──────────────────────
 *
 * Every other kind of income is planned by planIncome in budget-engine.ts: the
 * lowest ordinary month of the last six. That is right for refunds and interest,
 * where being low is the safe mistake, and wrong for a salary, which is the one
 * figure that is supposed to be predictable. One month with a payday that slid
 * across month-end, or one month before the bank was connected, set the whole
 * year's income -- an account paid about $5,000 a paycheque was planned at $700.
 *
 * Monthly totals are also exactly where a salary LOOKS unpredictable while
 * nothing about it has changed:
 *
 *   - paid every two weeks, two months a year hold three paycheques;
 *   - a payday on the 31st that moves to the 1st makes one month short and the
 *     next one long;
 *   - paycheques differ by cents, so no two months match exactly.
 *
 * So this works from each deposit's date and amount:
 *
 *   1. Per employer, deposits from the last 120 days before the cutoff. Deposits
 *      on the same day are one paycheque split across accounts, and are added.
 *   2. The schedule, from the dates: weekly, every two weeks, twice a month, or
 *      monthly. Weekly and fortnightly must stay on a 7- or 14-day grid (within
 *      three days, for bank holidays) -- that is what tells "every two weeks"
 *      from "twice a month", which drifts off the grid by a day or so each time.
 *   3. The typical paycheque: the most common amount, counting paycheques within
 *      2% of each other as the same.
 *   4. A raise: if the latest paycheque is more than 2% above typical, it is used
 *      from now on. Above 50% more it has to happen twice first, so a bonus
 *      landing on payday is not read as a new salary. A lower latest paycheque is
 *      ignored; a job that ended is caught by (6).
 *   5. Each month's budget is the paycheque times the paydays that fall in it:
 *      three in the two long months of a fortnightly year, two in the rest.
 *   6. Stopped: nothing for more than two pay periods (plus a few days) and the
 *      employer is planned at nothing.
 *
 * With no clear schedule -- commission, irregular shifts -- it falls back to the
 * last three complete months' totals: the most common one (within 2%), else the
 * median, raised to last month's total if that is higher.
 *
 * Like the rest of the budget, a past month is planned only from deposits before
 * it (see historyCutoffs in budget-engine.ts).
 */

import type { IncomePlan } from "./budget-engine";

export interface Deposit {
  /** YYYY-MM-DD */
  date: string;
  /** Money in, positive cents. */
  cents: number;
  /** The employer, as a merchant key. */
  key: string;
  /** A printable spelling of the employer. */
  name?: string;
}

const DAY = 86_400_000;
const LOOKBACK_DAYS = 120;
const SAME_AMOUNT = 0.02;
const BONUS_NOT_RAISE = 1.5;
const GRID_SLACK_DAYS = 3;

type Every = "weekly" | "fortnightly" | "semimonthly" | "monthly";
const PER_MONTH: Record<Every, number> = {
  weekly: 52 / 12, fortnightly: 26 / 12, semimonthly: 2, monthly: 1,
};
const WORDS: Record<Every, string> = {
  weekly: "every week", fortnightly: "every two weeks",
  semimonthly: "twice a month", monthly: "every month",
};

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const ymOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const prevMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

/** The most common value, treating values within 2% as the same. Ties go to
    the group holding the most recent value. Null when nothing repeats. */
export function commonAmount(values: number[]): number | null {
  let best: number[] = [];
  let bestLast = -1;
  values.forEach((v, i) => {
    const group = values.filter((w) => Math.abs(w - v) <= Math.max(v, w) * SAME_AMOUNT);
    const last = values.reduce((at, w, j) => (Math.abs(w - v) <= Math.max(v, w) * SAME_AMOUNT ? j : at), i);
    if (group.length > best.length || (group.length === best.length && last > bestLast)) {
      best = group; bestLast = last;
    }
  });
  return best.length >= 2 ? Math.round(median(best)) : null;
}

/** Does every date sit on a `step`-day grid from the first, within slack? */
function onGrid(dates: number[], step: number): boolean {
  const first = dates[0];
  return dates.every((t) => {
    const n = Math.round((t - first) / (step * DAY));
    return Math.abs(t - (first + n * step * DAY)) <= GRID_SLACK_DAYS * DAY;
  });
}

function scheduleOf(dates: number[]): Every | null {
  if (dates.length < 3) return null;
  const gaps = dates.slice(1).map((t, i) => (t - dates[i]) / DAY);
  const g = median(gaps);
  if (g >= 5 && g <= 9 && onGrid(dates, 7)) return "weekly";
  /* Every two weeks and twice a month look alike over three or four paydays;
     the difference only shows as twice-a-month drifting off a 14-day grid. Until
     there are five paydays to tell them apart, twice a month is assumed: it
     plans two a month, never the occasional three, so it can only be low. */
  if (g >= 12 && g <= 18) return dates.length >= 5 && onGrid(dates, 14) ? "fortnightly" : "semimonthly";
  if (g >= 26 && g <= 35) return "monthly";
  return null;
}

/** Paydays falling inside a calendar month, projected from the last one. */
function paydaysIn(ym: string, anchor: number, every: Every): number {
  if (every === "semimonthly") return 2;
  if (every === "monthly") return 1;
  const step = (every === "weekly" ? 7 : 14) * DAY;
  const start = ms(`${ym}-01`), end = ms(`${nextMonth(ym)}-01`);
  let t = anchor + step * Math.ceil((start - anchor) / step);
  let n = 0;
  for (; t < end; t += step) if (t >= start) n++;
  return n;
}

interface Payer {
  name: string; cents: number; months: number; everyMonth: boolean;
  every?: string; paycheck?: number;
}

/** One employer, planned as of `cutoff` (YYYY-MM-DD, the first day not seen). */
function planEmployer(
  deposits: Deposit[], cutoff: string, wanted: string[],
): { plan: Record<string, number>; level: number; payer: Payer } | null {
  const cut = ms(cutoff);
  const byDay = new Map<string, number>();
  for (const d of deposits) {
    const t = ms(d.date);
    if (t >= cut || t < cut - LOOKBACK_DAYS * DAY || !(d.cents > 0)) continue;
    byDay.set(d.date, (byDay.get(d.date) ?? 0) + d.cents);
  }
  const pays = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, cents]) => ({ t: ms(date), cents }));
  if (!pays.length) return null;

  const name = deposits.find((d) => d.name)?.name ?? deposits[0].key;
  const last = pays[pays.length - 1];
  const every = scheduleOf(pays.map((p) => p.t));
  const zero = Object.fromEntries(wanted.map((m) => [m, 0]));

  if (every) {
    const period = { weekly: 7, fortnightly: 14, semimonthly: 16, monthly: 31 }[every];
    if (cut - last.t > (period * 2 + 5) * DAY) {
      return { plan: zero, level: 0, payer: { name, cents: 0, months: 0, everyMonth: false, every: "stopped" } };
    }

    const amounts = pays.map((p) => p.cents);
    const typical = commonAmount(amounts) ?? Math.round(median(amounts));
    let paycheck = typical;
    if (last.cents > typical * (1 + SAME_AMOUNT)) {
      const prev = pays.length >= 2 ? pays[pays.length - 2].cents : 0;
      const confirmed = prev > typical * (1 + SAME_AMOUNT);
      if (last.cents <= typical * BONUS_NOT_RAISE || confirmed) paycheck = last.cents;
    }

    const plan = Object.fromEntries(wanted.map((m) => [m, paycheck * paydaysIn(m, last.t, every)]));
    return {
      plan,
      level: Math.round(paycheck * PER_MONTH[every]),
      payer: { name, cents: paycheck, paycheck, months: pays.length, everyMonth: true, every: WORDS[every] },
    };
  }

  /* No clear schedule: the last three complete months' totals. */
  const lastMonth = prevMonth(ymOf(cut));
  const threeMonths = [prevMonth(prevMonth(lastMonth)), prevMonth(lastMonth), lastMonth];
  const totals = threeMonths.map((m) => pays.filter((p) => ymOf(p.t) === m).reduce((s, p) => s + p.cents, 0));
  /* Paid in fewer than two of the three months is not a salary: a one-off
     deposit filed here, or an employer that has stopped. Planned at nothing
     rather than repeated every month. */
  if (totals.filter((v) => v > 0).length < 2 || (totals[1] <= 0 && totals[2] <= 0)) return null;
  const usual = commonAmount(totals) ?? Math.round(median(totals));
  const monthly = totals[2] > usual * (1 + SAME_AMOUNT) ? totals[2] : usual;
  return {
    plan: Object.fromEntries(wanted.map((m) => [m, monthly])),
    level: monthly,
    payer: { name, cents: monthly, months: totals.filter((v) => v > 0).length, everyMonth: totals.every((v) => v > 0) },
  };
}

/** Salary as of one cutoff: every employer, added together. */
export function planSalaryAt(deposits: Deposit[], cutoff: string, wanted: string[]): IncomePlan {
  const byKey = new Map<string, Deposit[]>();
  for (const d of deposits) {
    const list = byKey.get(d.key);
    if (list) list.push(d); else byKey.set(d.key, [d]);
  }
  const plan: Record<string, number> = Object.fromEntries(wanted.map((m) => [m, 0]));
  let level = 0;
  const payers: Payer[] = [];
  for (const list of byKey.values()) {
    const got = planEmployer(list, cutoff, wanted);
    if (!got) continue;
    for (const m of wanted) plan[m] += got.plan[m] ?? 0;
    level += got.level;
    if (got.level > 0) payers.push(got.payer);
  }
  payers.sort((a, b) => b.cents - a.cents);
  return { plan, level, dropped: [], short: [], payers, monthsUsed: 0, method: "paycheck" };
}

/** The earliest date any cutoff for these months will look back to. */
export function depositWindowStart(learn: string[], wanted: string[]): string {
  const current = learn.length ? nextMonth(learn[learn.length - 1]) : (wanted[0] ?? "");
  const earliest = [current, ...wanted].filter(Boolean).sort()[0];
  return new Date(ms(`${earliest}-01`) - (LOOKBACK_DAYS + 1) * DAY).toISOString().slice(0, 10);
}

/**
 * Salary for every month asked for, each from the deposits before it.
 *
 * `learn` is the complete months available (oldest first). A month inside it is
 * planned as of its own first day; the current month and later are planned as
 * of the first month not yet complete.
 */
export function planSalaryAsOf(deposits: Deposit[], learn: string[], wanted: string[]): IncomePlan {
  const current = learn.length ? nextMonth(learn[learn.length - 1]) : (wanted[0] ?? "");
  const groups = new Map<string, string[]>();
  for (const m of wanted) {
    const cutoff = `${m < current ? m : current}-01`;
    const g = groups.get(cutoff);
    if (g) g.push(m); else groups.set(cutoff, [m]);
  }
  const cutoffs = [...groups.keys()].sort();
  const runs = cutoffs.map((c) => planSalaryAt(deposits, c, groups.get(c)!));
  const latest = runs[runs.length - 1] ?? planSalaryAt(deposits, `${current}-01`, []);
  return { ...latest, plan: Object.assign({}, ...runs.map((r) => r.plan)) };
}

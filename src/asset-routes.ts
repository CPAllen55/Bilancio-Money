/**
 * /api/assets — what you own, what you owe, and how that has moved.
 *
 * The rest of the app is about flow: money in, money out, over a window. This
 * is the other question, and it is answered from balances rather than from
 * categories.
 *
 * ── Where the history comes from ──────────────────────────────────────────
 *
 * Nothing in this database records what an account was worth last March. The
 * accounts table holds one balance per account, overwritten on every sync, so
 * a chart of net worth over time has no stored series to draw.
 *
 * It can be reconstructed, though, because the transactions are the deltas.
 * Working backwards from today's balance and undoing each transaction gives
 * the balance at any earlier date:
 *
 *     balance(D) = balance(now) + k · Σ amount, over transactions after D
 *
 * k is +1 for accounts you own and −1 for accounts you owe. Plaid signs a
 * transaction positive when money leaves the account, so undoing an outgoing
 * payment on a current account adds it back — while on a credit card the same
 * payment is a charge that *raised* what you owe, so undoing it subtracts. The
 * two run in opposite directions and a single sign would silently invert every
 * card in the chart.
 *
 * This is exact for depository, credit and loan accounts, where every change in
 * balance is a transaction. It is NOT exact for investment accounts, whose
 * value moves with the market and not with anything Plaid sends as a
 * transaction. Those have no transactions at all here, so the sum is zero and
 * they come out held flat at today's value. That is stated in the response
 * rather than papered over: `reconstructed` counts the accounts the method is
 * exact for, `heldFlat` counts the ones carried at today's value.
 *
 * The honest fix is to snapshot balances on every sync and read the series back
 * out of that. This endpoint would then prefer snapshots and fall back to
 * reconstruction for anything older — which is worth doing, and is a migration,
 * and is not needed for the two years of history that already exist.
 */

import { Hono } from "hono";
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { accounts, items, metalHoldings, transactions } from "./db/schema";
import { requireUser } from "./auth";
import {
  METAL_LABEL, type Metal,
  pricesAtMonthEnds, refreshPrices, toOunces, valueCents,
} from "./metals";

const assets = new Hono<{ Bindings: Env }>();

/* Plaid's account types, sorted into the two sides of a balance sheet.
   "other" is deliberately an asset: it is what Plaid returns for things it
   cannot place, and counting an unknown as a debt would be the more damaging
   guess of the two. */
const DEBT_TYPES = ["credit", "loan"];
const INVESTMENT_TYPES = ["investment", "brokerage"];

/* Spendable today, as opposed to owned. A term deposit is an asset and is not
   money you can reach this afternoon, which is the difference runway turns on. */
const LIQUID_SUBTYPES = [
  "checking", "savings", "cash management", "money market", "prepaid", "cd",
];

type Klass = "cash" | "investment" | "credit" | "loan" | "metal" | "other";

function classOf(type: string, subtype: string | null): Klass {
  if (type === "depository") return "cash";
  if (INVESTMENT_TYPES.includes(type)) return "investment";
  if (type === "credit") return "credit";
  if (type === "loan") return "loan";
  return subtype ? "other" : "other";
}

const CLASS_LABEL: Record<Klass, string> = {
  cash: "Cash",
  investment: "Investments",
  credit: "Credit cards",
  loan: "Loans",
  metal: "Precious metals",
  other: "Other",
};

const isDebt = (k: Klass) => k === "credit" || k === "loan";

/**
 * One account's balance at the end of each point, newest last.
 *
 * Walked newest to oldest, accumulating what has happened since each month
 * ended, so the newest point sums nothing and comes out as today's balance
 * exactly rather than as an estimate of it.
 *
 * `owed` is the whole subtlety. Plaid signs a transaction positive when money
 * leaves the account, so undoing an outgoing payment on a current account adds
 * it back — while on a credit card that same payment is a charge that RAISED
 * what you owe, so undoing it subtracts. One sign for both would invert every
 * card on the chart, quietly and plausibly.
 */
export function reconstruct(
  current: number,
  owed: boolean,
  points: string[],
  byMonth: Map<string, number> | undefined,
): number[] {
  const k = owed ? -1 : 1;
  const out: number[] = new Array(points.length);
  let since = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    out[i] = current + k * since;
    since += byMonth?.get(points[i]) ?? 0;
  }
  return out;
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

assets.get("/assets", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Two years is what the transaction backfill reaches, so it is the most
    // history that can be reconstructed; anything longer would draw a flat line
    // out of an empty sum and pass it off as a stable year.
    const asked = Number(c.req.query("months"));
    const months = Number.isFinite(asked) ? Math.min(24, Math.max(3, Math.round(asked))) : 12;

    const rows = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        officialName: accounts.officialName,
        mask: accounts.mask,
        type: accounts.type,
        subtype: accounts.subtype,
        current: accounts.currentBalance,
        available: accounts.availableBalance,
        limit: accounts.limitAmount,
        asOf: accounts.balanceAsOf,
        institution: items.institutionName,
        itemId: items.id,
      })
      .from(accounts)
      .innerJoin(items, eq(accounts.itemId, items.id))
      .where(eq(items.userId, auth.user.id));

    // Metal is a holding with no bank behind it, so somebody who owns nothing
    // but bullion still has a balance sheet — the empty case is both lists
    // being empty, not just the accounts one.
    const held = await db
      .select({ metal: metalHoldings.metal, ouncesE4: metalHoldings.ouncesE4 })
      .from(metalHoldings)
      .where(eq(metalHoldings.userId, auth.user.id));

    if (!rows.length && !held.length) {
      return c.json({
        ok: true, months, accounts: [], series: [],
        totals: { assets: 0, liabilities: 0, netWorth: 0, liquid: 0 },
        byClass: [], byInstitution: [],
        credit: { limit: 0, used: 0, utilisation: null },
        coverage: { reconstructed: 0, heldFlat: 0, exact: true },
      });
    }

    const now = new Date();
    const points: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      points.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }
    /* The last day of each month, as a date rather than a month key: a price
       series is looked up by day, and the current month ends in the future, so
       its point takes whatever the newest close turns out to be. */
    const monthEnds = points.map((p) => {
      const [y, m] = p.split("-").map(Number);
      return ymd(new Date(Date.UTC(y, m, 0)));
    });

    const firstPoint = points[0];
    const windowStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1,
    ));

    const ids = rows.map((r) => r.id);

    /* Every transaction since the start of the window, pending included.
     *
     * Pending is deliberate here where the rest of the app excludes it: Plaid's
     * `current` balance already has pending charges in it, so leaving them out
     * would make today's reconstructed point disagree with the balance the bank
     * is showing — the one number on this page a reader can check by hand. */
    const txns = await db
      .select({
        accountId: transactions.accountId,
        date: transactions.date,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(and(
        inArray(transactions.accountId, ids),
        gte(transactions.date, ymd(windowStart)),
      ));

    // accountId -> month -> net flow, as Plaid signs it.
    const flow = new Map<string, Map<string, number>>();
    for (const t of txns) {
      const m = String(t.date).slice(0, 7);
      if (m < firstPoint) continue;
      let byMonth = flow.get(t.accountId);
      if (!byMonth) { byMonth = new Map(); flow.set(t.accountId, byMonth); }
      byMonth.set(m, (byMonth.get(m) ?? 0) + Number(t.amount));
    }

    /* Refreshed here as well as on the metals tab, because this page can be
       the first thing loaded in a session and a net worth missing its bullion
       is worse than a page that took an extra moment. A no-op unless the cache
       is half a day old, and it cannot throw. */
    if (held.length) await refreshPrices(db);
    const metalPricesAt = held.length ? await pricesAtMonthEnds(db, monthEnds) : new Map();

    const detail = rows.map((r) => {
      const klass = classOf(r.type, r.subtype);
      const current = r.current === null ? 0 : Number(r.current);
      const limit = r.limit === null ? null : Number(r.limit);
      const liquid = klass === "cash" &&
        (r.subtype === null || LIQUID_SUBTYPES.includes(r.subtype));

      const history = reconstruct(current, isDebt(klass), points, flow.get(r.id));

      return {
        id: r.id,
        name: r.name,
        officialName: r.officialName,
        mask: r.mask,
        type: r.type,
        subtype: r.subtype,
        klass,
        klassLabel: CLASS_LABEL[klass],
        institution: r.institution,
        current,
        available: r.available === null ? null : Number(r.available),
        limit,
        liquid,
        // A card at its limit is a different situation from one barely used,
        // and the limit is already stored — it only wants dividing.
        utilisation: klass === "credit" && limit && limit > 0
          ? Math.min(1, current / limit) : null,
        asOf: r.asOf,
        // Whether this account's line is derived or merely carried forward.
        exact: !INVESTMENT_TYPES.includes(r.type),
        // Only a metal row carries this; it is here so the two kinds of row
        // have one shape and the front end does not branch on which it has.
        ounces: null as number | null,
        history,
      };
    });

    /* Metals join the same list the accounts are in, so they roll into the
       totals, the breakdowns and the series without any of that code learning
       what a metal is.
     *
     * Unlike an investment account these are NOT carried flat: two years of
     * daily closes are cached, so a holding is valued at what it was actually
     * worth at the end of each month. It is only inexact where the price cache
     * does not reach back far enough, which is what `exact` reports. */
    for (const h of held) {
      const metal = h.metal as Metal;
      const at = metalPricesAt.get(metal);
      const ounces = toOunces(h.ouncesE4);
      if (!at || !at.size) continue;   // nothing to value it with

      let carried: number | null = null;
      let everyMonthPriced = true;
      const history = monthEnds.map((end) => {
        const cents = at.get(end);
        if (cents === undefined) {
          // Before the cache begins. The earliest close known is the least
          // wrong answer available, and the row says it is not exact.
          everyMonthPriced = false;
          return carried === null ? 0 : valueCents(h.ouncesE4, carried);
        }
        carried = cents;
        return valueCents(h.ouncesE4, cents);
      });
      // A gap at the start leaves zeroes behind it; backfill them at the first
      // price that did exist rather than drawing a holding into being.
      const firstKnown = history.find((v) => v > 0);
      if (firstKnown !== undefined) {
        for (let i = 0; i < history.length && history[i] === 0; i++) history[i] = firstKnown;
      }

      detail.push({
        id: "metal:" + metal,
        name: METAL_LABEL[metal],
        officialName: null,
        mask: null,
        type: "metal",
        subtype: metal,
        klass: "metal" as Klass,
        klassLabel: CLASS_LABEL.metal,
        institution: "Held directly",
        current: history[history.length - 1],
        available: null,
        limit: null,
        liquid: false,
        utilisation: null,
        asOf: null,
        exact: everyMonthPriced,
        ounces,
        history,
      } as typeof detail[number]);
    }

    const sumAt = (i: number, pick: (a: typeof detail[number]) => boolean) =>
      detail.reduce((s, a) => (pick(a) ? s + a.history[i] : s), 0);

    const series = points.map((m, i) => {
      const owned = sumAt(i, (a) => !isDebt(a.klass));
      const owed = sumAt(i, (a) => isDebt(a.klass));
      const [y, mm] = m.split("-").map(Number);
      return {
        month: m,
        label: `${MONTH_LABELS[mm - 1]} ${y}`,
        assets: owned,
        liabilities: owed,
        netWorth: owned - owed,
        liquid: sumAt(i, (a) => a.liquid),
      };
    });

    const last = series[series.length - 1];
    const first = series[0];

    const group = <T extends string>(key: (a: typeof detail[number]) => T) => {
      const out = new Map<T, { key: T; label: string; assets: number; liabilities: number; net: number; accounts: number }>();
      for (const a of detail) {
        const k = key(a);
        const row = out.get(k) ?? { key: k, label: k, assets: 0, liabilities: 0, net: 0, accounts: 0 };
        if (isDebt(a.klass)) row.liabilities += a.current; else row.assets += a.current;
        row.net = row.assets - row.liabilities;
        row.accounts++;
        out.set(k, row);
      }
      return [...out.values()];
    };

    const byClass = group((a) => a.klass)
      .map((r) => ({ ...r, label: CLASS_LABEL[r.key as Klass] }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    const byInstitution = group((a) => (a.institution ?? "Unknown") as string)
      .sort((a, b) => b.net - a.net);

    const creditLimit = detail.reduce((s, a) => s + (a.klass === "credit" ? (a.limit ?? 0) : 0), 0);
    const creditUsed = detail.reduce((s, a) => s + (a.klass === "credit" ? a.current : 0), 0);

    const heldFlat = detail.filter((a) => !a.exact).length;

    return c.json({
      ok: true,
      months,
      totals: {
        assets: last.assets,
        liabilities: last.liabilities,
        netWorth: last.netWorth,
        liquid: last.liquid,
      },
      // Where it stood at the far end of the window, so the front end can state
      // the change without recomputing the arithmetic differently.
      opening: {
        month: first.month, label: first.label,
        assets: first.assets, liabilities: first.liabilities, netWorth: first.netWorth,
      },
      change: {
        netWorth: last.netWorth - first.netWorth,
        assets: last.assets - first.assets,
        liabilities: last.liabilities - first.liabilities,
        // Percentage against a negative or zero opening is not a number anyone
        // should read, so it is simply absent rather than infinite.
        netWorthPct: first.netWorth > 0
          ? ((last.netWorth - first.netWorth) / first.netWorth) * 100 : null,
      },
      credit: {
        limit: creditLimit,
        used: creditUsed,
        utilisation: creditLimit > 0 ? creditUsed / creditLimit : null,
      },
      coverage: {
        reconstructed: detail.filter((a) => a.exact).length,
        heldFlat,
        // Whether every line on the chart is derived rather than assumed.
        exact: heldFlat === 0,
      },
      series,
      byClass,
      byInstitution,
      accounts: detail.sort((a, b) => Math.abs(b.current) - Math.abs(a.current)),
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default assets;

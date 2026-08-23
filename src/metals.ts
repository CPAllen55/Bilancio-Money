/**
 * Spot prices for precious metals, cached daily.
 *
 * ── The source ────────────────────────────────────────────────────────────
 *
 * Yahoo's chart endpoint, on the front-month COMEX contract for each metal.
 * Two things are worth being straight about:
 *
 *   - A front-month future is not spot. It tracks it closely — the gap is the
 *     cost of carrying metal for a few weeks, normally well under a percent —
 *     but it is not the same number, and somebody comparing this against a
 *     dealer's quote should know why they differ.
 *
 *   - The endpoint is not a documented API. It is stable in practice and takes
 *     no key, which is what makes the feature work with nothing to sign up for,
 *     but it can refuse a datacentre IP without warning. So nothing here treats
 *     a failed fetch as fatal: the cache is the source of truth for reading,
 *     the network only ever refills it, and a holding stays valued at the last
 *     price that did arrive, stamped with the date it belongs to.
 *
 * ── Why the cache holds history ───────────────────────────────────────────
 *
 * One request returns two years of daily closes, which is the same window the
 * transaction backfill reaches. Storing all of them rather than just today's
 * costs one insert per day per metal and means a holding can be valued at what
 * it was actually worth each month, instead of being carried flat the way an
 * investment account has to be.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { getDb } from "./db/client";
import { metalPrices } from "./db/schema";

export const METALS = ["gold", "silver", "platinum", "palladium"] as const;
export type Metal = (typeof METALS)[number];

export const METAL_LABEL: Record<Metal, string> = {
  gold: "Gold", silver: "Silver", platinum: "Platinum", palladium: "Palladium",
};

/** COMEX front month. Yahoo has no working spot symbol for these. */
const SYMBOL: Record<Metal, string> = {
  gold: "GC=F", silver: "SI=F", platinum: "PL=F", palladium: "PA=F",
};

/* Long enough that a page view never waits on four network calls, short enough
   that a price is never more than half a day behind the market. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Db = ReturnType<typeof getDb>["db"];

/** One metal's daily closes, in cents per troy ounce, oldest first. */
async function fetchSeries(metal: Metal): Promise<{ date: string; cents: bigint }[]> {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(SYMBOL[metal]) + "?interval=1d&range=2y";

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Bilancio/1.0)" },
    // The Worker cache is a second line behind the table, so a cold start does
    // not re-fetch two years four times over.
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) throw new Error(`${metal}: upstream ${res.status}`);

  const body = (await res.json()) as any;
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`${metal}: no result`);

  const stamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

  const out: { date: string; cents: bigint }[] = [];
  // Last write wins per day, which is what a daily close means when the feed
  // hands back an intraday point for today alongside yesterday's settle.
  const byDate = new Map<string, number>();
  for (let i = 0; i < stamps.length; i++) {
    const price = closes[i];
    if (price === null || price === undefined || !Number.isFinite(price)) continue;
    byDate.set(ymd(new Date(stamps[i] * 1000)), price);
  }
  for (const [date, price] of byDate) {
    out.push({ date, cents: BigInt(Math.round(price * 100)) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!out.length) throw new Error(`${metal}: empty series`);
  return out;
}

/**
 * Refills the cache for any metal whose newest row is stale.
 *
 * Never throws. A metal that cannot be reached keeps whatever it had, and the
 * caller finds out by looking at how old the price it gets back is — which is
 * the honest signal anyway, since a price from Friday is not wrong on a Sunday.
 */
export async function refreshPrices(db: Db): Promise<void> {
  const fresh = await db
    .select({ metal: metalPrices.metal, fetchedAt: sql<Date>`max(${metalPrices.fetchedAt})` })
    .from(metalPrices)
    .groupBy(metalPrices.metal);

  const seenAt = new Map(fresh.map((r) => [r.metal, new Date(r.fetchedAt).getTime()]));
  const now = Date.now();
  const stale = METALS.filter((m) => now - (seenAt.get(m) ?? 0) > STALE_AFTER_MS);
  if (!stale.length) return;

  await Promise.all(stale.map(async (metal) => {
    try {
      const series = await fetchSeries(metal);
      // Chunked: two years is ~500 rows per metal and one statement per row
      // would be five hundred round trips on a cold cache.
      for (let i = 0; i < series.length; i += 200) {
        const slice = series.slice(i, i + 200);
        await db
          .insert(metalPrices)
          .values(slice.map((p) => ({
            metal, date: p.date, usdPerOunce: p.cents, fetchedAt: new Date(),
          })))
          .onConflictDoUpdate({
            target: [metalPrices.metal, metalPrices.date],
            set: { usdPerOunce: sql`excluded.usd_per_ounce`, fetchedAt: new Date() },
          });
      }
    } catch (err) {
      // Logged, not raised. The page still renders from what is cached.
      console.error("metal price refresh failed", metal, err);
    }
  }));
}

export interface Spot { metal: Metal; cents: number; date: string }

/** The newest cached close for each metal, whatever day it belongs to. */
export async function latestPrices(db: Db): Promise<Map<Metal, Spot>> {
  const out = new Map<Metal, Spot>();
  const rows = await db
    .select({ metal: metalPrices.metal, date: metalPrices.date, cents: metalPrices.usdPerOunce })
    .from(metalPrices)
    .where(inArray(metalPrices.metal, [...METALS]))
    .orderBy(desc(metalPrices.date));

  for (const r of rows) {
    const m = r.metal as Metal;
    if (out.has(m)) continue;   // ordered newest first, so the first is the one
    out.set(m, { metal: m, cents: Number(r.cents), date: String(r.date) });
  }
  return out;
}

/**
 * The close on or before the end of each month named.
 *
 * Metals do not trade every day, so a month ending on a Sunday has no close of
 * its own and takes the last one before it — the same rule a broker's statement
 * uses, and the reason this walks the series rather than looking up a date.
 */
export async function pricesAtMonthEnds(
  db: Db,
  monthEnds: string[],
): Promise<Map<Metal, Map<string, number>>> {
  const out = new Map<Metal, Map<string, number>>();
  if (!monthEnds.length) return out;

  const earliest = monthEnds[0];
  const rows = await db
    .select({ metal: metalPrices.metal, date: metalPrices.date, cents: metalPrices.usdPerOunce })
    .from(metalPrices)
    .where(and(
      inArray(metalPrices.metal, [...METALS]),
      // A month-end can fall on a weekend, so the window opens a little before
      // the first one asked for or that point would have nothing to stand on.
      gte(metalPrices.date, shiftDays(earliest, -10)),
    ))
    .orderBy(metalPrices.date);

  const byMetal = new Map<Metal, { date: string; cents: number }[]>();
  for (const r of rows) {
    const m = r.metal as Metal;
    if (!byMetal.has(m)) byMetal.set(m, []);
    byMetal.get(m)!.push({ date: String(r.date), cents: Number(r.cents) });
  }

  for (const [metal, series] of byMetal) {
    out.set(metal, alignToMonthEnds(series, monthEnds));
  }
  return out;
}

/**
 * The last close on or before each month end.
 *
 * Both lists are in date order, so this walks them together once rather than
 * searching the series per month. A month end with nothing before it in the
 * series is absent from the result rather than zero — no price is a different
 * statement from a price of nothing, and the caller has to be able to tell.
 */
export function alignToMonthEnds(
  series: { date: string; cents: number }[],
  monthEnds: string[],
): Map<string, number> {
  const at = new Map<string, number>();
  let i = 0, last: number | null = null;
  for (const end of monthEnds) {
    while (i < series.length && series[i].date <= end) { last = series[i].cents; i++; }
    if (last !== null) at.set(end, last);
  }
  return at;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

/** Ten-thousandths of an ounce to a display number, and back. */
export const toOunces = (e4: bigint | number) => Number(e4) / 10000;
export const fromOunces = (oz: number) => BigInt(Math.round(oz * 10000));

/** Cents of value for a holding at a price, both in their integer forms. */
export const valueCents = (ouncesE4: bigint | number, centsPerOunce: number) =>
  Math.round((Number(ouncesE4) / 10000) * centsPerOunce);

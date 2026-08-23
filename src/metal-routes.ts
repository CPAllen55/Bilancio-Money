/**
 * /api/metals — the one balance the app has to be told rather than fetched.
 *
 * Plaid cannot see a safe deposit box, so ounces are typed in. Everything else
 * about the holding is derived: the price comes from the cache, and the value
 * is one multiplication, so there is no figure here that can go stale against
 * itself.
 */

import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { metalHoldings } from "./db/schema";
import { requireUser } from "./auth";
import {
  METALS, METAL_LABEL, type Metal,
  fromOunces, latestPrices, refreshPrices, toOunces, valueCents,
} from "./metals";

const metals = new Hono<{ Bindings: Env }>();

const isMetal = (s: unknown): s is Metal =>
  typeof s === "string" && (METALS as readonly string[]).includes(s);

/** Holdings, the price each is valued at, and what that comes to. */
metals.get("/metals", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Refreshed before reading rather than on a schedule, because the app has
    // no scheduler and a page view is the only thing that ever asks. It is a
    // no-op unless the cache is half a day old, and it cannot throw.
    await refreshPrices(db);

    const [held, prices] = await Promise.all([
      db.select().from(metalHoldings).where(eq(metalHoldings.userId, auth.user.id)),
      latestPrices(db),
    ]);

    const byMetal = new Map(held.map((h) => [h.metal, h.ouncesE4]));

    // Every metal is returned whether or not it is held, so the front end shows
    // four rows to type into rather than an empty state with an add button.
    const rows = METALS.map((metal) => {
      const ouncesE4 = byMetal.get(metal) ?? 0n;
      const spot = prices.get(metal) ?? null;
      return {
        metal,
        label: METAL_LABEL[metal],
        ounces: toOunces(ouncesE4),
        spot: spot ? spot.cents : null,
        spotDate: spot ? spot.date : null,
        value: spot ? valueCents(ouncesE4, spot.cents) : null,
      };
    });

    const priced = rows.filter((r) => r.value !== null);
    return c.json({
      ok: true,
      metals: rows,
      total: priced.reduce((s, r) => s + (r.value ?? 0), 0),
      // The oldest price anything is valued at, which is what a reader needs to
      // judge the total — not the newest, which would flatter it.
      asOf: priced.length
        ? priced.map((r) => r.spotDate!).sort()[0] : null,
      pricesAvailable: priced.length === rows.length,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * PUT /api/metals — { gold: 12.5, silver: 400 }
 *
 * Whole holdings, not deltas. The form shows every metal at once and saves what
 * it shows, so a partial body would silently mean "leave the others alone" in a
 * request that looks like it says otherwise.
 */
metals.put("/metals", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", reason: "body must be JSON" }, 400); }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "bad_request", reason: "expected an object of metal to ounces" }, 400);
    }

    const updates: { metal: Metal; ouncesE4: bigint }[] = [];
    for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
      if (!isMetal(key)) {
        return c.json({ error: "bad_request", reason: `not a metal: ${key}` }, 400);
      }
      const oz = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(oz) || oz < 0) {
        return c.json({ error: "bad_request", reason: `${key} must be zero or more ounces` }, 400);
      }
      // A cap, so a slipped decimal point is refused rather than stored and
      // then drawn as a net worth in the billions.
      if (oz > 1_000_000) {
        return c.json({ error: "bad_request", reason: `${key}: that is more than a million ounces` }, 400);
      }
      updates.push({ metal: key, ouncesE4: fromOunces(oz) });
    }
    if (!updates.length) return c.json({ error: "bad_request", reason: "nothing to save" }, 400);

    /* Zero is a deletion rather than a row of nothing. Somebody who sold their
       silver should not leave a record saying they hold none of it — and the
       read path already returns every metal whether or not there is a row. */
    const empty = updates.filter((u) => u.ouncesE4 === 0n).map((u) => u.metal);
    const kept = updates.filter((u) => u.ouncesE4 > 0n);

    if (empty.length) {
      await db.delete(metalHoldings).where(and(
        // Scoped to this user, so a metal name in the body can only ever reach
        // their own rows.
        eq(metalHoldings.userId, auth.user.id),
        inArray(metalHoldings.metal, empty),
      ));
    }

    for (const u of kept) {
      await db
        .insert(metalHoldings)
        .values({ userId: auth.user.id, metal: u.metal, ouncesE4: u.ouncesE4, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [metalHoldings.userId, metalHoldings.metal],
          set: { ouncesE4: u.ouncesE4, updatedAt: new Date() },
        });
    }

    return c.json({ ok: true, saved: updates.length });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default metals;

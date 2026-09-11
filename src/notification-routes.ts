/**
 * The opt-in for budget alerts, the phones they go to, and muting one.
 *
 * What decides whether an alert is sent lives in budget-alerts.ts; this is only
 * the switchboard. Every route answers 503 rather than 500 while the tables do
 * not exist yet -- between this deploying and migration 0013 running -- so the
 * app can say "not available yet" instead of showing a server error.
 */

import { Hono } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "./db/client";
import { budgetAlertStates, categories, notificationSettings, pushDevices } from "./db/schema";
import { requireUser } from "./auth";
import { learnWindow } from "./plan";
import { pushConfigured } from "./push";
import { checkBudgetAlerts } from "./budget-alerts";

const notifications = new Hono<{ Bindings: Env }>();

/** Postgres's "that table does not exist", however the driver wraps it. */
function missingTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "42P01" || e?.cause?.code === "42P01";
}

const notReady = {
  error: "unavailable",
  message: "Notifications are not set up yet.",
} as const;

const kick = (env: Env, userId: string) =>
  checkBudgetAlerts(env, userId).catch((err) => console.error("budget alerts:", err));

/**
 * GET /api/notifications
 *
 * The switch, whether anything can be sent at all, and this month's categories
 * that have alerted or been muted -- the ones there is something to say about.
 */
notifications.get("/notifications", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const month = learnWindow(new Date()).currentKey;
    const [settings] = await db.select().from(notificationSettings)
      .where(eq(notificationSettings.userId, auth.user.id)).limit(1);
    const devices = await db.select({ id: pushDevices.id }).from(pushDevices)
      .where(eq(pushDevices.userId, auth.user.id));
    const rows = await db
      .select({
        categoryId: budgetAlertStates.categoryId,
        level: budgetAlertStates.level,
        notifiedAt: budgetAlertStates.notifiedAt,
        acknowledgedAt: budgetAlertStates.acknowledgedAt,
        label: categories.label,
        colour: categories.colour,
      })
      .from(budgetAlertStates)
      .innerJoin(categories, eq(categories.id, budgetAlertStates.categoryId))
      .where(and(
        eq(budgetAlertStates.userId, auth.user.id),
        eq(budgetAlertStates.month, month),
      ));

    return c.json({
      ok: true,
      configured: pushConfigured(c.env),
      enabled: !!settings?.budgetAlerts,
      month,
      devices: devices.length,
      alerts: rows.map((r) => ({
        categoryId: r.categoryId,
        label: r.label,
        colour: r.colour,
        level: r.level,
        notifiedAt: r.notifiedAt,
        acknowledged: !!r.acknowledgedAt,
      })),
    });
  } catch (err) {
    if (missingTable(err)) return c.json(notReady, 503);
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * PUT /api/notifications   { enabled: boolean }
 *
 * Switching on looks at the month straight away, rather than leaving somebody
 * who is already over budget to find out on the next sync.
 */
notifications.put("/notifications", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let body: { enabled?: unknown };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "bad_request", message: "enabled must be true or false." }, 400);
    }

    await db.insert(notificationSettings)
      .values({ userId: auth.user.id, budgetAlerts: body.enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: notificationSettings.userId,
        set: { budgetAlerts: body.enabled, updatedAt: new Date() },
      });

    if (body.enabled) c.executionCtx.waitUntil(kick(c.env, auth.user.id));
    return c.json({ ok: true, enabled: body.enabled });
  } catch (err) {
    if (missingTable(err)) return c.json(notReady, 503);
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * POST /api/notifications/devices   { token, environment }
 *
 * Called on every launch -- iOS can hand out a new token at any time -- so it
 * is an upsert, and a token already registered to somebody else moves to this
 * account: the phone has changed hands, or changed accounts.
 */
notifications.post("/notifications/devices", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let body: { token?: unknown; environment?: unknown };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }

    const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{32,200}$/.test(token)) {
      return c.json({ error: "bad_request", message: "token must be the device token as hex." }, 400);
    }
    const environment = body.environment === "sandbox" ? "sandbox" : "production";

    const [existing] = await db.select({ userId: pushDevices.userId }).from(pushDevices)
      .where(eq(pushDevices.token, token)).limit(1);

    await db.insert(pushDevices)
      .values({ userId: auth.user.id, token, environment, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: pushDevices.token,
        set: { userId: auth.user.id, environment, updatedAt: new Date() },
      });

    /* A phone this account had not seen. If alerts were switched on before
       the token arrived -- the switch and the registration race each other on
       first use -- this is the moment there is finally somewhere to send. */
    if (!existing || existing.userId !== auth.user.id) {
      const [settings] = await db.select().from(notificationSettings)
        .where(eq(notificationSettings.userId, auth.user.id)).limit(1);
      if (settings?.budgetAlerts) c.executionCtx.waitUntil(kick(c.env, auth.user.id));
    }

    return c.json({ ok: true });
  } catch (err) {
    if (missingTable(err)) return c.json(notReady, 503);
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * DELETE /api/notifications/devices/:token
 *
 * On sign-out. Scoped to the caller, so nobody can switch off somebody else's
 * phone by knowing its token.
 */
notifications.delete("/notifications/devices/:token", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    await db.delete(pushDevices).where(and(
      eq(pushDevices.token, c.req.param("token").toLowerCase()),
      eq(pushDevices.userId, auth.user.id),
    ));
    return c.json({ ok: true });
  } catch (err) {
    if (missingTable(err)) return c.json(notReady, 503);
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * POST /api/notifications/acknowledge   { categoryId, month? }
 *
 * "Don't remind me this month." Quiet for that category until the month turns,
 * whether or not it has alerted yet -- muting ahead of time is allowed.
 */
notifications.post("/notifications/acknowledge", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let body: { categoryId?: unknown; month?: unknown };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }

    const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
    if (!/^[0-9a-f-]{36}$/i.test(categoryId)) {
      return c.json({ error: "bad_request", message: "categoryId is required." }, 400);
    }
    const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)
      ? body.month
      : learnWindow(new Date()).currentKey;

    // Somebody's own category, or one everybody has. Never another person's.
    const [visible] = await db.select({ id: categories.id }).from(categories)
      .where(and(
        eq(categories.id, categoryId),
        or(isNull(categories.userId), eq(categories.userId, auth.user.id)),
      ))
      .limit(1);
    if (!visible) return c.json({ error: "not_found", message: "No such category." }, 404);

    await db.insert(budgetAlertStates)
      .values({ userId: auth.user.id, categoryId, month, acknowledgedAt: new Date() })
      .onConflictDoUpdate({
        target: [budgetAlertStates.userId, budgetAlertStates.categoryId, budgetAlertStates.month],
        set: { acknowledgedAt: new Date() },
      });
    return c.json({ ok: true, categoryId, month });
  } catch (err) {
    if (missingTable(err)) return c.json(notReady, 503);
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default notifications;

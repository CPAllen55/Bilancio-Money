/**
 * The one-person back office.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The waitlist has been collecting real addresses since the landing page went
 * up, and until now the only way to read it was a SQL console. That is workable
 * for a dozen people and unworkable for a hundred — and an invite programme
 * where the promises live in the inviter's memory is one nobody can honour
 * later. This is the smallest surface that makes running it possible: see who
 * is waiting, mark them invited, see who converted, and set what each person
 * was promised at the moment of promising it.
 *
 * ── Who can reach it ────────────────────────────────────────────────────────
 *
 * One Clerk user id, held in ADMIN_CLERK_USER_ID. Not a role, not a table, not
 * a flag on `users` — because a flag on a row is a thing that can be set, and
 * the whole point of an admin check is that it cannot be reached from inside
 * the application. An environment variable can only be changed by somebody who
 * can already deploy.
 *
 * With the variable unset, every route here answers 404. Not 403: an endpoint
 * that says "forbidden" has told an unauthenticated caller that it exists.
 */

import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { users, waitlist, items } from "./db/schema";
import { requireUser } from "./auth";
import { trialEnd, type Plan } from "./entitlement";

const admin = new Hono<{ Bindings: Env }>();

const PLANS: Plan[] = ["trial", "active", "free", "lapsed"];

/**
 * Every route starts here.
 *
 * Returns the caller only when they are the admin, and null otherwise — the
 * caller then answers 404 without saying why. The comparison is against the
 * Clerk id rather than the email, because an email can be changed from inside
 * Clerk's own account settings and a Clerk id cannot.
 */
async function requireAdmin(c: any, db: ReturnType<typeof getDb>["db"]) {
  const allowed = c.env.ADMIN_CLERK_USER_ID;
  if (!allowed) return null;
  const auth = await requireUser(c, db);
  if (!auth.ok) return null;
  return auth.user.clerkUserId === allowed ? auth.user : null;
}

/* ------------------------------------------------------------- the list -- */

/**
 * GET /api/admin/overview
 *
 * The waitlist and the signed-up users in one response, because they are two
 * halves of the same question and fetching them separately only invites them
 * to disagree with each other on screen.
 */
admin.get("/overview", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const me = await requireAdmin(c, db);
    if (!me) return c.json({ error: "not_found" }, 404);

    const waiting = await db
      .select()
      .from(waitlist)
      .orderBy(desc(waitlist.createdAt))
      .limit(500);

    /* Bank connections per user, counted in SQL rather than per row. Shown
       because it is the number that costs money — Plaid bills per Item per
       month — and because a user with none has not started yet, whatever
       their plan says. */
    const people = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        deletedAt: users.deletedAt,
        plan: users.plan,
        planUntil: users.planUntil,
        planNote: users.planNote,
        itemCount: sql<number>`(
          select count(*)::int from ${items} where ${items.userId} = ${users.id}
        )`,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(500);

    return c.json({
      ok: true,
      waitlist: waiting,
      users: people,
      totals: {
        waiting: waiting.filter((w) => !w.invitedAt).length,
        invited: waiting.filter((w) => w.invitedAt).length,
        converted: waiting.filter((w) => w.userId).length,
        // The number to watch against the Plaid ceiling.
        items: people.reduce((n, p) => n + p.itemCount, 0),
      },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------ marking invited -- */

/**
 * POST /api/admin/waitlist/:id/invited
 *
 * Stamps invitedAt. The invitation itself is sent from Clerk — this only
 * records that it happened, so the list stops showing somebody you have
 * already written to.
 *
 * Idempotent by design: inviting twice is a thing that will happen, and the
 * first date is the true one.
 */
admin.post("/waitlist/:id/invited", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const me = await requireAdmin(c, db);
    if (!me) return c.json({ error: "not_found" }, 404);

    const [row] = await db
      .update(waitlist)
      .set({ invitedAt: new Date() })
      .where(and(eq(waitlist.id, c.req.param("id")), isNull(waitlist.invitedAt)))
      .returning();

    // Already invited, or no such row. Both are "nothing to do" rather than
    // errors: the caller wanted it marked, and it is.
    return c.json({ ok: true, changed: !!row });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------ the plan -- */

/**
 * POST /api/admin/users/:id/plan
 *
 * Sets what somebody is entitled to. Body: { plan, note?, months? }
 *
 *   free            comped permanently — planUntil cleared, and it stays clear
 *   trial + months  a free period of that many months from now
 *   trial           a trial that has not started; the clock begins on their
 *                   first bank connection, which is the normal case
 *   active, lapsed  set by hand for now; Stripe will own these later
 */
admin.post("/users/:id/plan", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const me = await requireAdmin(c, db);
    if (!me) return c.json({ error: "not_found" }, 404);

    let body: { plan?: unknown; note?: unknown; months?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
    }

    const plan = body.plan;
    if (typeof plan !== "string" || !PLANS.includes(plan as Plan)) {
      return c.json({ error: "bad_request", reason: `plan must be one of ${PLANS.join(", ")}` }, 400);
    }

    /* A comped account has no expiry and must not acquire one — that is the
       whole meaning of "free". Everything else takes the months given, or
       leaves the clock alone so the first bank connection can start it. */
    let planUntil: Date | null | undefined;
    if (plan === "free") {
      planUntil = null;
    } else if (typeof body.months === "number" && body.months > 0) {
      const end = new Date();
      end.setUTCMonth(end.getUTCMonth() + Math.floor(body.months));
      planUntil = end;
    } else if (plan === "trial") {
      // Unstarted: let the first connection start it.
      planUntil = null;
    }

    const note = typeof body.note === "string" && body.note.trim()
      ? body.note.trim().slice(0, 60)
      : undefined;

    const [row] = await db
      .update(users)
      .set({
        plan: plan as Plan,
        ...(planUntil !== undefined ? { planUntil } : {}),
        ...(note !== undefined ? { planNote: note } : {}),
      })
      .where(eq(users.id, c.req.param("id")))
      .returning();

    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      ok: true,
      user: { id: row.id, email: row.email, plan: row.plan,
              planUntil: row.planUntil, planNote: row.planNote },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default admin;
export { trialEnd };

/**
 * Bilancio Money API.
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
 * Anything else is served from public/ by the assets binding.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { users, waitlist } from "./db/schema";
import { requireUser } from "./auth";
import plaidRoutes from "./plaid-routes";
import summaryRoutes from "./summary-routes";
import categoryRoutes from "./category-routes";
import forecastRoutes from "./forecast-routes";
import accountRoutes from "./account-routes";
import assetRoutes from "./asset-routes";
import metalRoutes from "./metal-routes";
import budgetRoutes from "./budget-routes";

// Deliberately loose. The only thing worth rejecting here is input that cannot
// be an address at all - anything stricter starts refusing real people.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "bilancio-api", time: new Date().toISOString() }),
);

app.get("/api/health/db", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const rows = await db.select().from(users).limit(1);
    return c.json({ ok: true, users: rows.length });
  } finally {
    // Never block the response on teardown, but never leak the connection either.
    c.executionCtx.waitUntil(close());
  }
});

// The publishable key is public by design, but it differs per environment, so
// the front end asks for it rather than hard-coding one and breaking the other.
app.get("/api/auth/config", (c) =>
  c.json({ publishableKey: c.env.CLERK_PUBLISHABLE_KEY }),
);

// First authenticated call. Proves the whole chain: Clerk session verified on
// the Worker, local users row created, row read back out of Neon.
app.get("/api/me", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const { user } = auth;
    return c.json({
      ok: true,
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

// The landing page waitlist. Unauthenticated by necessity - these people have
// no account, that is the whole point.
app.post("/api/waitlist", async (c) => {
  let email: unknown;
  try {
    ({ email } = await c.req.json());
  } catch {
    return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
  }

  if (typeof email !== "string") {
    return c.json({ error: "bad_request", reason: "email is required" }, 400);
  }

  const normalised = email.trim().toLowerCase();
  if (normalised.length > MAX_EMAIL_LENGTH || !LOOKS_LIKE_EMAIL.test(normalised)) {
    return c.json({ error: "bad_request", reason: "that does not look like an email" }, 400);
  }

  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    await db
      .insert(waitlist)
      .values({ email: normalised })
      // Signing up twice is not an error, and the second attempt must not
      // overwrite the original createdAt - their place in the queue is earned.
      .onConflictDoNothing({ target: waitlist.email });

    // Identical response whether the address was new or already present. The
    // alternative lets anyone test whether a given person is on the list.
    return c.json({ ok: true });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Nothing under /api is cacheable.
 *
 * These responses carried no cache headers at all, which does not mean "do
 * not cache" — it means the browser may decide for itself, and for a 200 GET
 * at a stable URL it generally decides yes. /api/budget-plan is the only
 * endpoint with no query string, so it was the one that visibly broke: a
 * method was saved, the row was written, and the next read replayed the
 * response from before the change, showing the old method back again.
 *
 * It is also simply wrong to leave somebody's bank balances sitting in a
 * shared browser cache, so this covers every route rather than the one that
 * showed the symptom.
 */
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

app.route("/api/plaid", plaidRoutes);
app.route("/api", summaryRoutes);
app.route("/api", categoryRoutes);
app.route("/api", forecastRoutes);
app.route("/api", accountRoutes);
// Siloed. Nothing else reads what this writes — see budget-v2-routes.
app.route("/api", assetRoutes);
app.route("/api", metalRoutes);
app.route("/api", budgetRoutes);

// JSON, not an HTML error page — the front end is always expecting JSON here.
app.all("/api/*", (c) =>
  c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404),
);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

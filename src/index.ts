/**
 * Bilancio Money API.
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
 * Anything else is served from public/ by the assets binding.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { users } from "./db/schema";
import { requireUser } from "./auth";

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

// JSON, not an HTML error page — the front end is always expecting JSON here.
app.all("/api/*", (c) =>
  c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404),
);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

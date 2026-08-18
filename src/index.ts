/**
 * Bilancio Money API.
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
 * Anything else is served from public/ by the assets binding.
 */

import { Hono } from "hono";
import { getDb } from "./db/client";
import { users } from "./db/schema";

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

// JSON, not an HTML error page — the front end is always expecting JSON here.
app.all("/api/*", (c) =>
  c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404),
);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

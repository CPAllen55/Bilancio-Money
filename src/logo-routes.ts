/**
 * /api/logo/:file — merchant logos, served from here rather than from Plaid.
 *
 * ── Why a proxy and not the URL Plaid gives us ────────────────────────────
 *
 * Plaid returns a logo_url per transaction pointing at its own CDN. Putting
 * that straight in an <img> would work and would quietly break something we
 * have written down: SECURITY.md says no third-party requests are made from
 * the application, and the published privacy policy says the same. A page that
 * fetches forty images from another host is making forty third-party requests,
 * whatever the images are of — and each one carries the reader's IP address
 * and, by the filename, the name of a merchant they bank with.
 *
 * Plaid already has the transaction. What they would gain is when it is being
 * looked at and from where, which is not theirs and is not worth a logo.
 *
 * So the Worker fetches it instead. The browser only ever talks to us.
 *
 * ── The filename is the whole allowlist ───────────────────────────────────
 *
 * A proxy that takes a URL is an open door: hand it an internal address and it
 * fetches that too. This one takes a filename, matches it against a strict
 * pattern, and builds the URL itself. There is no input that can reach a host
 * other than the one named below.
 */
import { Hono } from "hono";

const logo = new Hono<{ Bindings: Env }>();

const CDN = "https://plaid-merchant-logos.plaid.com/";
/* Plaid's logos are 100x100 PNGs named for the merchant — walmart_1100.png.
   Lower case, digits, underscore, hyphen, one dot before the extension. */
const SAFE = /^[a-z0-9][a-z0-9_-]{0,80}\.png$/;

/* A logo does not change. A week in the browser, a year at the edge, and a
   stale one served while it revalidates — the worst case is an out-of-date
   picture next to a correct figure. */
const BROWSER = "public, max-age=604800, stale-while-revalidate=86400";

logo.get("/logo/:file", async (c) => {
  const file = c.req.param("file");
  if (!SAFE.test(file)) return c.text("not found", 404);

  const url = CDN + file;
  const cache = caches.default;
  const key = new Request(new URL(c.req.url).origin + "/api/logo/" + file);

  const hit = await cache.match(key);
  if (hit) return hit;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      cf: { cacheEverything: true, cacheTtl: 31536000 },
      headers: { accept: "image/png" },
    });
  } catch {
    return c.text("upstream unavailable", 502);
  }

  /* A miss upstream is cached briefly too. Without it, every row for a
     merchant Plaid has no logo for asks Plaid again on every page. */
  if (!upstream.ok) {
    const miss = new Response("no logo", {
      status: 404,
      headers: { "cache-control": "public, max-age=86400" },
    });
    c.executionCtx.waitUntil(cache.put(key, miss.clone()));
    return miss;
  }

  const body = await upstream.arrayBuffer();
  const res = new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": BROWSER,
      /* Nothing about this response depends on who asked for it, which is the
         point — it is the same picture for everybody and carries no session. */
      "x-content-type-options": "nosniff",
    },
  });
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
});

export default logo;

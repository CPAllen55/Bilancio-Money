/**
 * Bilancio Money API.
 *
 * Only /api/* reaches this Worker (see run_worker_first in wrangler.jsonc).
 * Anything else is served from public/ by the assets binding.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "bilancio-api",
        time: new Date().toISOString(),
      });
    }

    // JSON, not an HTML error page — the front end is always expecting JSON here.
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not_found", path: url.pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

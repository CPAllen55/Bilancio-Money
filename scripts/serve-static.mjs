/**
 * Serves public/ over plain HTTP, using nothing but Node's own modules.
 *
 *   npm run preview        →  http://127.0.0.1:8788
 *
 * This exists because Windows Smart App Control blocks Cloudflare's workerd
 * binary on this machine, which stops `wrangler dev`. Node itself is allowed,
 * so the static site can still be previewed.
 *
 * /api/* is NOT served here - there is no Worker. Those return 501, so a
 * failure is obvious rather than looking like a bug in the page.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

const ROOT_ABS = resolve("public");
const PORT = Number(process.argv[2] ?? 8788);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    res.writeHead(501, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      error: "not_implemented",
      reason: "static preview only - run wrangler dev for the API",
    }));
  }

  // Resolve, then prove the result is still inside public/. Comparing absolute
  // paths is harder to get wrong than stripping ../ with a regex.
  let p = resolve(ROOT_ABS, "." + decodeURIComponent(url.pathname));
  if (p !== ROOT_ABS && !p.startsWith(ROOT_ABS + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("403");
  }
  try {
    if ((await stat(p)).isDirectory()) p = join(p, "index.html");
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("404");
  }

  try {
    const body = await readFile(p);
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`public/ on http://127.0.0.1:${PORT}  (no /api - static only)`);
});

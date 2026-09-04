# Bilancio-Money

Bilancio Money Website/App.

One Cloudflare Worker does two jobs: it serves the static site from `public/`
at the edge, and answers the API on `/api/*`. Data lives in Neon Postgres,
reached through Hyperdrive. Auth is Clerk.

## Layout

| Path | What it is |
| --- | --- |
| `public/index.html` | Landing page. The dashboard on it is a **browser-only demo** on generated data. |
| `public/app/` | Sign-in page. Proves the auth chain end to end; not the product yet. |
| `src/index.ts` | Worker routes. |
| `src/auth.ts` | Clerk -> Postgres bridge. `requireUser()` returns the local user row. |
| `src/db/` | Drizzle client and schema. |
| `drizzle/` | Generated migrations. |

## Local development

```bash
cp .dev.vars.example .dev.vars    # then paste your Clerk development keys in
npm install
npm run dev                        # http://127.0.0.1:8787
```

`.env` holds the Neon connection strings (used by drizzle-kit and by
`wrangler dev` for Hyperdrive). `.dev.vars` holds the Clerk keys. Both are
gitignored and neither belongs in `wrangler.jsonc`.

Check the stack is healthy:

- `/api/health` — Worker is up
- `/api/health/db` — Neon reachable through Hyperdrive
- `/app/` — every link in the auth chain, pass or fail, on one panel

## Migrations

Run from your laptop against the Neon **`dev`** branch, never `main`.
Hyperdrive does not exist outside the Worker runtime, so drizzle-kit uses the
direct connection string from `.env`.

```bash
npm run db:generate    # write the SQL — read it before applying
npm run db:migrate
npm run db:studio
```

## Secrets in deployed environments

There are no named environments. The Cloudflare build runs `wrangler deploy`
with no `--env`, so the top-level config in `wrangler.jsonc` **is** production,
including the `production` Neon branch and the Clerk production keys. Local
development overrides both from `.dev.vars` and `.env`, which point at the
`dev` branch and the Clerk development instance.

So each secret is set once, on the `bilancio-money` Worker:

```bash
npx wrangler secret put CLERK_SECRET_KEY
```

`wrangler secret put` requires a real terminal — it prompts, and there is no
`--value` flag. In a non-interactive shell it exits without ever asking. Use
`wrangler secret bulk <file>` or the Cloudflare dashboard instead.

`CLERK_PUBLISHABLE_KEY` is public by design and lives in `wrangler.jsonc` as a
var. The front end reads it from `/api/auth/config` rather than hard-coding it.

Phase 1 will add `PLAID_CLIENT_ID`, `PLAID_SECRET` and `TOKEN_ENCRYPTION_KEY`
(`openssl rand -base64 32`). That encryption key wraps every Plaid access
token — **losing it means every user re-links every bank**, so back it up
somewhere you cannot lose it before it is ever used.

## What serves the domain

Cloudflare, on both the apex and `www` — checked 2026-09-04. The Worker is
live: `/api/health` answers on each, and the root of each is served by the
assets binding out of `public/`. GitHub Pages is not in the path, whatever
`public/CNAME` implies.

An earlier version of this section said `wrangler deploy` had never been run
and warned that deploying could take the live site down. That is no longer
true — the Cloudflare build deploys on push, so `main` is production and has
been for some time. The caution that remains is the one under **Secrets**: the
top-level `wrangler.jsonc` config *is* production, including the `production`
Neon branch and the Clerk production keys.

## Conventions

- Money is stored as integers (`bigint`), always.
- Neon connection strings are **direct**, not pooled — Hyperdrive pools.
- `nodejs_compat` is required, or the `pg` driver will not load.
- One Postgres client per request, always closed via `ctx.waitUntil(close())`.
- Every authenticated query filters by `user.id` from `requireUser()`. No route
  accepts an `account_id` or `item_id` from the client without first confirming
  it belongs to the authenticated user.

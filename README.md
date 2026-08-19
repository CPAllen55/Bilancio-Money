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

**Secrets are per-environment and are not inherited.** `wrangler.jsonc`
defines a `production` environment, so every secret has to be set twice —
once for the default environment and once with `--env production`. Setting it
only the first way leaves production without the key.

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_SECRET_KEY --env production
```

`CLERK_PUBLISHABLE_KEY` is public by design but still differs per environment;
the front end reads it from `/api/auth/config` rather than hard-coding one.

Phase 1 will add `PLAID_CLIENT_ID`, `PLAID_SECRET` and `TOKEN_ENCRYPTION_KEY`
(`openssl rand -base64 32`). That encryption key wraps every Plaid access
token — **losing it means every user re-links every bank**, so back it up
somewhere you cannot lose it before it is ever used.

## Before deploying — read this

`wrangler deploy` has never been run, deliberately. `public/CNAME` points at
`www.bilanciomoney.com`, which suggests GitHub Pages currently serves the
domain, but that has never been confirmed. Deploying this Worker to that
domain, or merging these branches to `main`, could take the live site down.

**Confirm what serves `www.bilanciomoney.com` before any deploy.**

## Conventions

- Money is stored as integers (`bigint`), always.
- Neon connection strings are **direct**, not pooled — Hyperdrive pools.
- `nodejs_compat` is required, or the `pg` driver will not load.
- One Postgres client per request, always closed via `ctx.waitUntil(close())`.
- Every authenticated query filters by `user.id` from `requireUser()`. No route
  accepts an `account_id` or `item_id` from the client without first confirming
  it belongs to the authenticated user.

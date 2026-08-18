# Bilancio API

The server behind the dashboard: bank connections through Plaid, transaction storage,
and the feed the charts read.

The marketing page at bilanciomoney.com stays where it is — static files on GitHub
Pages. This is a separate, running program, because connecting a bank needs three
things a static page cannot have: a secret that never reaches the browser, somewhere
to store transactions, and a URL Plaid can call.

## What runs where

| Piece | Job | Where it lives |
|---|---|---|
| `index.html` | The marketing page and its demo dashboard | GitHub Pages, `main` branch |
| `server/` | API, bank connections, database | A Node host — Render, Railway, Fly.io, or a VPS |
| GitHub | Source history, and Pages hosting for the marketing page | github.com |
| DNS | `bilanciomoney.com` -> Pages, `app.bilanciomoney.com` -> the API | Your registrar, or Cloudflare |

**A note on Cloudflare.** It is genuinely useful for DNS, HTTPS, and caching in front
of both. It is *not* what this code runs on: Cloudflare Workers is a different runtime
with no Node filesystem and no SQLite driver, so hosting the API there would mean
rewriting the storage layer against Cloudflare D1. Use Cloudflare for DNS if you like
it; run the API on a plain Node host.

## Running it locally

```bash
cd server
npm install
cp .env.example .env          # then fill in the four required values
npm start                     # http://localhost:3000
```

Getting the values:

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com). Sandbox keys are
   free, instant, and need no approval.
2. Developers -> Keys -> copy `client_id` and the **Sandbox** secret.
3. Generate the encryption key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

Then open http://localhost:3000, create an account, and click **Connect a bank**.
In sandbox, pick any institution and use Plaid's test credentials:

```
username: user_good
password: pass_good
```

You should land back on the page with accounts listed and transactions in the table.
That is the whole pipeline working: link token -> public token -> access token ->
`/transactions/sync` -> your database.

## Tests

```bash
npm test
```

18 tests, no network required. They run the real Express app against an in-memory
database and a fake Plaid client (`test/fake-plaid.js`) that reproduces the parts of
Plaid's behaviour worth defending against: spending arrives POSITIVE, sync arrives in
pages, and items fail with `ITEM_LOGIN_REQUIRED`.

## The API

| Route | Purpose |
|---|---|
| `POST /api/auth/signup` · `/login` · `/logout` · `GET /me` | Sessions, httpOnly cookie |
| `POST /api/link/token` | Mint a `link_token` for Plaid Link |
| `POST /api/link/exchange` | Swap the `public_token`, store the item, first sync |
| `GET /api/items` · `DELETE /api/items/:id` | Connected banks; disconnect |
| `POST /api/sync` | Pull anything new for every item |
| `GET /api/transactions?start=&end=` | The dashboard's feed |
| `POST /api/transactions/:id/category` | Re-file one charge |
| `POST /api/rules` | "Always file Chewy under Pets" — past and future |
| `POST /api/plaid/webhook` | Plaid tells us there is new data |

## Decisions worth knowing

**Money is stored in integer cents.** Floats lose money: `0.1 + 0.2 !== 0.3`.

**Signs are flipped once, on the way in.** Plaid reports money leaving an account as
positive. Every chart here treats income as positive and spending as negative, so
`normalizeTransaction` inverts it and nothing downstream has to think about it.

**Access tokens are encrypted at rest** (AES-256-GCM) so a leaked database file is not
a leaked set of bank connections. `ENCRYPTION_KEY` is therefore a real secret: lose it
and every connection has to be re-linked; leak it with the database and you have leaked
the connections.

**A sync never overwrites a category the user set.** Precedence is user edit > merchant
rule > Plaid's guess.

**The cursor advances only after a page set is written.** A crash mid-sync replays;
it does not skip transactions.

**Category mapping is by substring, not exact enum.** Plaid revises its taxonomy, and a
mapper keyed to today's exact strings would silently file everything as "other" the day
they change. Unmatched values are counted by `unmappedCategories()` — check it once you
have real data and add rules.

**The webhook trusts nothing in its body.** It uses the body only to decide which of our
items to re-sync, against our own stored token, so a forged call can at worst cause an
extra sync. Add Plaid's JWT verification before production.

## Before real bank data

- [ ] Deploy somewhere with HTTPS and a persistent disk or managed Postgres
- [ ] Set `PLAID_WEBHOOK_URL` to the deployed URL so transactions arrive on their own
- [ ] Add Plaid JWT webhook verification
- [ ] Privacy policy and terms — Plaid asks for these during Production access
- [ ] Rate-limit `/api/auth/login`
- [ ] Database backups, and a tested restore
- [ ] Apply for Production access in the Plaid dashboard, then set `PLAID_ENV=production`
      with the production secret

Production access is a review, not a switch: Plaid asks who you are, what you do with
the data, and how you secure it. Expect it to take days, not minutes.

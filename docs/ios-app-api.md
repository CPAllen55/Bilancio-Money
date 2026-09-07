# The API, for the iOS app

Written from the Worker source on 2026-09-04, for a native Swift client. The
web app in `public/app/index.html` is the reference implementation of every
call below — when this document and that file disagree, the file is right.

## The short version

**No server changes are needed to read anything.** Authentication is a bearer
token rather than a browser session, and every screen the web app draws is
built from these endpoints. A native client is just another caller.

The exception is Plaid, and only the OAuth hand-off: the Worker sends a single
`redirect_uri` to every caller, and a native client needs its own. See
**Onboarding a bank**. Everything else in this document a native client can use
exactly as the web app does — the sign-in and Overview screens were built
against it without touching `src/`.

---

## Authentication

Every `/api/*` route except the Plaid webhook requires:

```
Authorization: Bearer <Clerk session token>
```

`requireUser` in `src/auth.ts` verifies the token with `@clerk/backend`, then
looks the user up in Clerk and maps them to a **local** user row. Two
consequences worth knowing before you design the sign-in screen:

- Any Clerk client works. Use **Clerk's iOS SDK**; there is nothing
  browser-specific in the check.
- The local row is created on first authenticated call, so a brand-new user
  needs no separate registration step against this API.

Failures return `401` with `{ "error": "unauthorized", "reason": "..." }`.
The reasons are distinguishable in the log but deliberately not to the caller.

---

## Money and dates

- **Every amount is an integer of cents.** Never a float, never a string.
- **Signs follow the reader, not the bank.** In responses, positive is money
  IN and negative is money OUT. Plaid's own convention is the opposite and is
  flipped at the boundary, so do not re-flip it.
- Months are `YYYY-MM`. Dates are `YYYY-MM-DD`.

## The `range` parameter

`/summary` and `/transactions` take `?range=`, defaulting to `this-month`:

| Value | Meaning |
|---|---|
| `this-month` | the calendar month in progress |
| `last-month` | the previous whole month |
| `ytd` | 1 January to today |
| `month:YYYY-MM` | one named calendar month, whole |
| `span:YYYY-MM..YYYY-MM` | an explicit run of whole months |

`month:` and `span:` are the two that let the app show history. Everything
else is an aggregate ending today.

---

## Onboarding a bank

1. `POST /api/plaid/link-token` → `{ linkToken, expiration }`
2. Hand `linkToken` to **Plaid's iOS Link SDK**.
3. On success, `POST /api/plaid/exchange` with `{ "publicToken": "..." }`
4. `POST /api/plaid/sync` (no body) → `{ ok, items, added, modified, removed }`

`POST /api/plaid/link-token/update` opens Link in update mode for an item
whose login has expired; `GET /api/plaid/items` lists connections and their
health; `DELETE /api/plaid/items/:id` removes one.

**`PLAID_REDIRECT_URI` is configured for the web OAuth flow**, and native Link
cannot use it as it stands. Three things are true and are easy to conflate:

- **There is no iOS bundle-identifier field in the Plaid dashboard.** Android
  has one ("Allowed Android package names"); iOS does not. On iOS the app
  proves it owns the redirect URL through
  `public/.well-known/apple-app-site-association`, which is where the bundle
  identifier is actually declared. Typing a bundle identifier into **Allowed
  redirect URIs** is a category error — that field takes URLs.
- **The iOS redirect must be a universal link.** Plaid does not accept custom
  URI schemes, and a universal link only works once the association file above
  is served as `application/json` (it has no extension, so `public/_headers`
  sets that) and the target has the Associated Domains capability
  (`applinks:bilanciomoney.com`).
- **The Worker sends one redirect URI to every caller.** `src/plaid.ts` adds
  `redirect_uri` from `PLAID_REDIRECT_URI` on both `/link/token/create` calls,
  so an iOS caller currently receives the *web* URL. Native Link needs its own,
  which means this is the one place the claim above — that no server changes
  are needed — stops being true.

Order matters, because Plaid will happily save a redirect URI that cannot
work: serve the association file, add the capability, then register the URL,
then teach the Worker which one to send. `PLAID_ENV` is `production`, so
every one of these steps is against real bank linking.

`POST /api/plaid/webhook` is Plaid calling us. The app must never call it.

---

## Reading

| Endpoint | Gives you |
|---|---|
| `GET /api/summary?range=` | the Overview: totals, the same figures for the previous period, pace, and the budget for that range |
| `GET /api/transactions?range=&bucket=&limit=&offset=` | the ledger, and the drill-down behind any category |
| `GET /api/trend?months=N` | monthly series by category, plus the same months a year earlier |
| `GET /api/budget` | the plan: twelve months per subcategory, what was spent, and what the shape was before any edits |
| `GET /api/forecast` | the year ahead, month by month |
| `GET /api/categories` | the category tree |
| `GET /api/assets`, `GET /api/metals` | net worth and precious metals |

### `/summary`

```
{ ok, range: { key, label, start, end },
  comparison: { label, start, end },
  totals:   { income, expense, net, byCategory, byIncomeCategory,
              byTransferCategory, transfersMoved, transfersExcluded,
              byParent, byIncomeParent },
  previous: { ...the same shape, for the comparison period },
  safeToSpend: { remaining, perDay, daysLeft, daysElapsed, daysInPeriod,
                 spent, budget, onPace },
  budget, categories, accountsCounted }
```

There is **no `savingsRate` on `totals`**. It lives on `budget`, which is a
different object with its own `income`, `expense` and `net` describing what a
month *should* cost rather than what it did. Reading `totals.savingsRate` gets
you `nil`, silently.

`safeToSpend.remaining` is **floored at zero**. For a period that spent more
than it earned it reads `0`, not the loss. Use `totals.net` for the real
figure — the web app's headline was reading the floored one and had to be
changed.

`accountsCounted` is `0` until a bank is linked, and every figure above is
then `0` too. That is not the same as a month with no activity, and a first
screen should say which it is rather than showing a bare zero.

### `/transactions`

Query: `range`, `bucket` (a category slug — the drill-down), `merchant`,
`subscription=yes|no`, `amount=asc|desc`, `account` (an account id, or `all`),
`limit` (max 200, default 50), `offset`.

`/trend` takes `account` too, and `months`.

```
{ ok, total, sum: { in, out, net },
  vendors: [ { key, name, logo, cents, count } ],
  merchants, categories,
  transactions: [ { id, date, name, amount, pending, accountId,
                    category, categorySource, logo, subscription, parts } ] }
```

- `total` is the whole filtered set; `transactions` is one page of it.
- `vendors` is rolled up over the **whole** set, not the page — build any
  merchant breakdown from it rather than from the rows.
- `logo` is a **filename**, not a URL. Build `GET /api/logo/<file>` against
  your own origin. Never fetch Plaid's CDN directly: `SECURITY.md` and the
  privacy policy both say the app makes no third-party requests, and an image
  request carries the user's IP and the name of a merchant they bank with.
- `categorySource` is `user`, `rule` or `plaid` — which of the three decided
  where the row landed.

---

## Writing

| Endpoint | Body |
|---|---|
| `POST /api/transactions/:id/category` | `{ categoryId, applyToMerchant }` — `applyToMerchant` also writes a rule so every future transaction from that merchant lands there |
| `PUT /api/transactions/:id/splits` | the parts a transaction is divided into; amounts in the reader's convention |
| `POST /api/categories` | a category the user made |
| `GET /api/rules` | the merchant rules that exist |
| `DELETE /api/rules/:id` | drop one |
| `PUT /api/budget` | `[{ slug, baseline?, month?, amount? }]` — `baseline` scales the year, `month`+`amount` pins one month, `amount: null` unpins it |
| `PUT /api/metals` | ounces held |
| `DELETE /api/account` | deletes everything |

A budget `baseline` **scales** rather than replaces: someone moving groceries
from 480 to 430 has said "about a tenth less", and December should still be
December. A pinned month is absolute. See `applyOverride` in `src/plan.ts`.

---

## Two things the app should not reimplement

**The plan.** `src/plan.ts` and `src/budget-shape.ts` are the single
definition of what a month should cost, shared by four dashboards precisely so
they cannot disagree. The app should read `/api/budget` and `/api/forecast`
rather than fit its own curve.

**Which category a transaction is in.** It is not a column. It is resolved per
row from an override, then a merchant rule, then Plaid's guess. `/transactions`
returns the resolved answer in `category`; trust it.

---

## Known gaps, before they surprise you

- **Only subcategories are budgeted.** `buildShapedPlan` skips any category
  without a parent, so money filed directly on a top-level category — and
  everything in Unsorted, which has no parent — counts as spending with no
  budget line. Expect a budget total well below actual spend.
- **The learn window reaches further back than most people's data**, and
  months with no record are read as months of zero spending rather than as
  absent. On a median-based level that is worth about 5%.

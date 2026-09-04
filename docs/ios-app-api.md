# The API, for the iOS app

Written from the Worker source on 2026-09-04, for a native Swift client. The
web app in `public/app/index.html` is the reference implementation of every
call below — when this document and that file disagree, the file is right.

## The short version

**No server changes are needed to build the app.** Authentication is a bearer
token rather than a browser session, and every screen the web app draws is
built from these endpoints. A native client is just another caller.

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

**`PLAID_REDIRECT_URI` is configured for the web OAuth flow.** Native Link
uses a different mechanism, so the Plaid dashboard needs an iOS redirect and
a bundle identifier registered before OAuth banks will work in the app. This
is the one piece of setup the app cannot inherit from the web.

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
  totals:   { income, expense, net, savingsRate },
  previous: { income, expense, net, savingsRate },
  safeToSpend: { remaining, perDay, daysLeft, daysElapsed, daysInPeriod,
                 spent, budget, onPace },
  budget, categories, accountsCounted }
```

`safeToSpend.remaining` is **floored at zero**. For a period that spent more
than it earned it reads `0`, not the loss. Use `totals.net` for the real
figure — the web app's headline was reading the floored one and had to be
changed.

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

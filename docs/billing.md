# Billing

Two processors, one column. This document is the contract between them.

## Why there are two

A subscription bought on the website goes through **Stripe** and costs nothing
to collect. One bought inside the **iOS app** must go through Apple's in-app
purchase: App Store Review Guideline 3.1.1 requires it for anything that
unlocks features, and a budgeting app is not a "reader" app, so none of the
carve-outs (3.1.3(a) reader, 3.1.3(e) goods consumed outside the app) apply.
Comparable apps — Copilot, Monarch, YNAB — all use in-app purchase on iOS.

This is not a preference and there is no version of it where one processor
serves both platforms.

## What keeps it from being two systems

Neither processor decides anything. Both write two columns on `users`:

| column | meaning |
|---|---|
| `plan` | `trial` · `active` · `free` · `lapsed` |
| `plan_until` | when the current state runs out; NULL means it does not |

`src/entitlement.ts` reads those and nothing else, and everything downstream
reads `entitlement.ts`. The rest of the app has never heard of Stripe or of
StoreKit.

Four more columns record **who** is charging, which has to be recorded rather
than inferred:

| column | why it exists |
|---|---|
| `billing_source` | `"stripe"` or `"apple"`; NULL while trialling or comped |
| `stripe_customer_id` | how a Stripe webhook finds the user; outlives the subscription |
| `stripe_subscription_id` | the current subscription, NULL once it ends |
| `apple_original_transaction_id` | Apple's one id that survives every renewal |

Two reasons it must be recorded. **Cancelling happens where you bought** —
Apple will not let anyone else cancel an App Store subscription, so sending a
subscriber to the wrong place is a support ticket at best. And **a webhook
from one processor must never overwrite a subscription held at the other**;
knowing the source is what makes that check possible. Both checks are in
`src/billing-routes.ts` and both are deliberate.

## Rules both sides obey

- **A comped account (`free`) is never touched by a processor.** It is a
  promise made by a person and is not Stripe's or Apple's to revoke.
- **A failed payment does not lapse anybody.** Stripe retries for days and
  most failures are a card that expired over a weekend. `past_due` still
  counts as paid. Access ends when the processor says the subscription is
  over, or when the paid period simply runs out.
- **Nothing is switched on by default.** Every Stripe binding is optional;
  unset, `/api/billing/checkout` answers 503 and the page offers nothing
  rather than half-working.

## The web half — done

| endpoint | auth | what it does |
|---|---|---|
| `POST /api/billing/checkout` | user | `{plan: "monthly" \| "yearly"}` → `{url}` for Stripe Checkout |
| `POST /api/billing/portal` | user | → `{url}` for Stripe's manage/cancel page |
| `POST /api/billing/stripe-webhook` | **signature** | grants and revokes |
| `GET /api/billing/status` | user | plan, when it ends, where it is managed |

`status` answers **per caller**. A purchase made inside the iOS app has to go
through Apple and one made in a browser goes through Stripe, so "is billing
switched on" has two different answers; `configured` and `canSubscribeHere`
reflect the Apple bindings when the caller sends `X-Bilancio-Client: ios` and
the Stripe ones otherwise. The header is a hint and is treated as one — nothing
is granted by it, and the worst a lie achieves is being shown the wrong thing
to buy. This is what lets the app ship before the Apple secrets exist: the
subscription screen shows the plan and offers nothing, rather than offering
products App Store Connect does not yet have.

The webhook is unauthenticated by necessity — Stripe has no session — and
therefore signature-verified before a byte of it is believed. It reads
`req.text()`, never `req.json()`: the signature is over the bytes Stripe sent
and re-serialising changes them. That is the single most common way webhook
verification is broken, and it fails closed.

Bindings, all optional, all secrets:

```
STRIPE_SECRET_KEY        sk_live_… or sk_test_…
STRIPE_WEBHOOK_SECRET    whsec_…   — per endpoint, NOT the API key
STRIPE_PRICE_MONTHLY     price_…   — not prod_…
STRIPE_PRICE_YEARLY      price_…
```

## The iOS half

StoreKit 2, two auto-renewable subscriptions in one subscription group so a
user can move between monthly and yearly without holding both.

`API/Subscriptions.swift` — products fetched by id, prices read **from
StoreKit** rather than hard-coded (Apple localises and converts them),
`Transaction.updates` listened to from birth so renewals and purchases made on
another device arrive, and Restore, which Apple requires.

`API/Billing.swift` — `GET /api/billing/status`, and the handover below.

`Views/SubscriptionView.swift` — More → Subscription. Shows the plan and when
it runs out; offers the products only when the server says billing is
configured and this device may sell; shows an Apple subscriber where to cancel
and gives them no button; says nothing about price or checkout anywhere else.

The signed transaction is handed over whether or not StoreKit says it verified,
and the local transaction is finished only after the server has accepted it.
The phone's opinion is not evidence, and a transaction dropped because a
request failed is a person who paid and cannot prove it.

### What the app must not do

- No link to the website's checkout, and no text mentioning a price available
  elsewhere. That is anti-steering (3.1.1(a)); the US position changed after
  the 2025 Epic injunction, but do not rely on it without checking the current
  guideline text.
- No "manage subscription" button that calls the Stripe portal. An Apple
  subscription is cancelled through Apple; `/api/billing/portal` already
  answers 409 for an Apple subscriber, and the app should not ask.

## The Apple half — Apple is asked, not believed

| endpoint | auth | what it does |
|---|---|---|
| `POST /api/billing/apple` | user | `{signedTransaction}` → `{plan, planUntil}` |
| `POST /api/billing/apple-notifications` | none needed | renewals, expiries, refunds |

### Why no signature is verified anywhere

The obvious thing to do with StoreKit's JWS is check it: ES256, public key from
the leaf certificate in the `x5c` header, chain walked to Apple's Root CA G3,
validity windows checked at every hop. That is a real amount of cryptography,
it is the code that decides who has paid, and it is wrong in ways nobody
notices until somebody is already in for free.

So it is not written. Instead **every payload the server believes came back
from `api.storekit.itunes.apple.com` over TLS**, in answer to a request signed
with our own App Store Connect key. The certificate authenticating that
connection is checked by the runtime, by people who do nothing else. That is a
better chain of trust than one written here.

The rule that follows shapes `src/apple.ts` and both routes:

> A payload that arrived from a phone is a **pointer**, never evidence.

It is read exactly far enough to get an `originalTransactionId` out of it, and
that id is then put to Apple. A phone that lies about its payload has managed
to ask a question.

The same reasoning is why the notifications endpoint needs no signature check.
Nothing in a notification is believed either: it is read for a transaction id,
that id is put to Apple in a fresh request, and what Apple answers is what gets
written. A forged notification achieves either nothing (an id Apple does not
know) or the truth about a subscription — which is what would have been written
anyway. That is a stronger position than a verified webhook whose contents are
then trusted.

### Whose subscription it is

An original transaction id is not a secret, so "I know this id" must not mean
"this is mine". Two things stand between them:

1. **`appAccountToken`.** The app attaches the account's `users.id` — already a
   UUID, which is the form Apple requires — to the purchase. Apple stores it
   and returns it in *its own* description of the transaction. When it is
   there it settles the question, because Apple is the one saying it.
2. **First claim wins**, for purchases made before the app started sending one.
   A subscription already recorded against another account is refused with 409.

### What counts as paid

Apple's subscription status: 1 active, 3 billing retry, 4 grace period. `2`
(expired) and `5` (revoked) do not, and a `revocationDate` ends access whatever
the status says — a refund is Apple taking the money back, not a payment that
will sort itself out. Billing retry and grace period keeping access is the same
call as `past_due` on the Stripe side.

Two guards on the way out, both about not making things worse:

- **A comped account is never touched.** The id is recorded so the
  subscription behind it is known when the comp ends; the plan is left alone.
- **An expired transaction may only end the subscription it belongs to.**
  Restoring on a new phone replays old transactions, and one from two years ago
  must not knock somebody out of a trial or out of a Stripe subscription.

### Environment

Production is tried first and sandbox second, on a 404 **or a 401**. There is no field that
can be trusted to say which one a transaction came from — `environment` lives
inside the payload we have decided not to trust — and an id is unknown in the
other world, so the answer is unambiguous. A TestFlight build buys in sandbox
and works without being told.

A 401 counts as "try the other one" rather than as an error because it often
is not one. An account whose Paid Applications Agreement has not gone Active
is refused by production and served by sandbox on the very same credentials,
so treating the first 401 as fatal made every sandbox purchase fail for a
reason that had nothing to do with it. Only a refusal from *every* host means
the key is wrong, and `GET /api/admin/apple-check` — admin-only, prints the
key id and bundle id but never the key — says which of the two it is.

Production also refuses **every** app that has no release on the App Store
yet. Apple keeps the production API closed until then — "Until you have a
release in production, access to the production APIs is not allowed. Once you
have a release in production this will be unlocked" (App Store Commerce
Engineer, Apple Developer Forums thread 806452). So production cannot be
proven before launch. App Review buys in sandbox and is served by the fallback
above; after release, production answers 404 for a sandbox transaction, which
the same fallback handles. **Run `/api/admin/apple-check` on launch day**: it
must read `production: accepted`, or real customers' purchases will not be
credited.

### Bindings

All four together, all optional; with any missing, `/api/billing/apple` answers
503 and the app offers nothing.

```
APPLE_ISSUER_ID      the UUID shown on the key page
APPLE_KEY_ID         10 characters
APPLE_PRIVATE_KEY    the .p8 contents, whole, BEGIN and END lines included
APPLE_BUNDLE_ID      com.bilanciomoney.Bilancio
```

The key is an **In-App Purchase** key — App Store Connect → Users and Access →
Integrations → In-App Purchase — **not** an App Store Connect API key. They
look identical, both download as a `.p8`, and the wrong one answers 401 to
everything. The issuer id is on that same page and is not the same UUID as the
App Store Connect API issuer id.

The `.p8` downloads once and cannot be downloaded again. It goes into
`wrangler secret put APPLE_PRIVATE_KEY` and nowhere else — not into the repo,
not into `.dev.vars` that gets committed, not pasted into a chat window.

Point App Store Server Notifications V2 at
`https://<host>/api/billing/apple-notifications` in App Store Connect → your
app → General → App Information → App Store Server Notifications. Sandbox and
production have separate URL fields; both want this one. The "send test
notification" button answers `{ok: true, test: true}`.

### Sandbox testing

Sandbox subscriptions renew on a compressed clock — a month is minutes — so a
full year of renewals can be watched in an afternoon. Use a Sandbox Apple
Account from App Store Connect, not a real one; sign into it under Settings →
Developer, not the main App Store login.

## What has to be true before any of this can take money

In App Store Connect, in this order, because the first has lead time:

1. **Paid Applications Agreement** signed, plus tax and banking. Nothing can
   be sold until this clears and bank verification takes days to weeks.
2. The two subscription products created, in one group.
3. At least one product attached to a submitted build — a subscription that
   has never shipped in a binary cannot be reviewed.

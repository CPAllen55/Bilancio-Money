# Billing

Two processors, one column. This document is the contract between them, and
the brief for the iOS half, which does not exist yet.

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

## The iOS half — not built

This is the brief. Nothing here exists yet, and it needs the Mac.

### What the app builds

StoreKit 2, two auto-renewable subscriptions in one subscription group so a
user can move between monthly and yearly without holding both.

1. Fetch products, show prices **from StoreKit** — never hard-coded, because
   Apple localises and converts them.
2. On purchase, and on `Transaction.updates`, send the signed transaction to
   the server (below) and refresh entitlement from `/api/billing/status`.
3. Offer **Restore Purchases**. Apple rejects subscription apps without it.
4. Read `canSubscribeHere` from `/api/billing/status` rather than deciding
   locally, so the rule lives in one place.

### What the app must not do

- No link to the website's checkout, and no text mentioning a price available
  elsewhere. That is anti-steering (3.1.1(a)); the US position changed after
  the 2025 Epic injunction, but do not rely on it without checking the current
  guideline text.
- No "manage subscription" button that calls the Stripe portal. An Apple
  subscription is cancelled through Apple; `/api/billing/portal` already
  answers 409 for an Apple subscriber, and the app should not ask.

### The server endpoint to add

```
POST /api/billing/apple           auth: user
  { "signedTransaction": "<JWS from StoreKit>" }
  → { ok, plan, planUntil }
```

It must:

1. Verify the JWS — ES256, public key from the leaf certificate in the `x5c`
   header, chain terminating at Apple's Root CA G3.
2. Check the `bundleId` matches, so a transaction signed for another app is
   refused.
3. Read `originalTransactionId` and `expiresDate`.
4. Refuse if that `original_transaction_id` already belongs to a **different**
   user — one purchase, one account, or a single family subscription unlocks
   any number of them.
5. Write `plan = "active"`, `plan_until = expiresDate`,
   `billing_source = "apple"`, and the id.

Plus `POST /api/billing/apple-notifications` for App Store Server
Notifications V2, unauthenticated and verified the same way, handling
`DID_RENEW`, `EXPIRED`, `DID_CHANGE_RENEWAL_STATUS` and `REFUND`.

**Why this is not written yet.** The verification needs Apple's root
certificate and a real signed payload to test against, and shipping untested
signature verification on the path that decides who has paid is not a trade
worth making. It should be written once the Mac can produce a sandbox
transaction to verify against — with the certificate supplied as a binding,
not pasted from memory into source.

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

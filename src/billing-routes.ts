/**
 * Taking the money, and deciding who is entitled because of it.
 *
 * ── Two processors, one column ──────────────────────────────────────────────
 *
 * A subscription bought on the web goes through Stripe. One bought inside the
 * iOS app must go through Apple's in-app purchase — App Store guideline 3.1.1
 * requires it for anything that unlocks features, and a budgeting app is not
 * a "reader" app, so none of the carve-outs apply. There is no version of this
 * where one processor serves both.
 *
 * What keeps that from becoming two systems is that neither of them decides
 * anything. Both write `plan` and `plan_until` on `users`, and entitlement.ts
 * reads those and nothing else. The rest of the app has never heard of Stripe.
 *
 * ── What a webhook is allowed to do ─────────────────────────────────────────
 *
 * Only ever narrow things. A processor may say "this person is paid up until
 * March" and it may say "this person stopped paying". It may NOT overrule a
 * comped account, and it may not overrule a subscription held at the other
 * processor. Both of those are checked here rather than trusted, because a
 * webhook is a message from outside and the worst case — a Stripe event
 * silently cancelling somebody who pays through Apple — is invisible until
 * they complain.
 *
 * ── Apple is asked, not believed ────────────────────────────────────────────
 *
 * Nothing here checks a StoreKit signature. A payload from a phone is read
 * exactly far enough to get a transaction id out of it, and that id is then put
 * to Apple over TLS with our own key; what Apple answers is what gets written.
 * The full reasoning, and why it also makes the notifications endpoint safe
 * without a signature, is at the top of apple.ts.
 *
 * ── The unpaid-invoice question ─────────────────────────────────────────────
 *
 * A failed payment does NOT lapse anybody. Stripe retries for days and most
 * failures are a card that expired over a weekend; cutting access on the first
 * failure punishes the wrong people at the wrong moment. Access ends when
 * Stripe says the subscription is over, which is what `customer.subscription.
 * deleted` means, or when the paid period simply runs out. The comment in
 * entitlement.ts puts it well: until Stripe says so, the benefit of the doubt
 * belongs to the person who paid.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { users } from "./db/schema";
import { requireUser } from "./auth";
import {
  createCustomer, createCheckoutSession, createPortalSession, getSubscription,
  verifyWebhook, StripeError,
} from "./stripe";
import {
  configured as appleConfigured, isPaid as applePaid, peek, subscriptionStatus,
  AppleError, type AppleNotification, type AppleSubscription,
} from "./apple";

const billing = new Hono<{ Bindings: Env }>();

/** Which price a request may ask for. A price id from the client is a price
 *  the client chose, so only these two names are accepted. */
const PLANS = { monthly: "STRIPE_PRICE_MONTHLY", yearly: "STRIPE_PRICE_YEARLY" } as const;
type PlanName = keyof typeof PLANS;

/* Stripe subscription statuses that mean "this person may use the app".
 *
 * `past_due` is deliberately in the list and `unpaid` deliberately is not.
 * past_due is a payment that failed and is still being retried; unpaid is
 * Stripe having given up. */
const PAID = new Set(["active", "trialing", "past_due"]);

/**
 * POST /api/billing/checkout   { plan: "monthly" | "yearly" }
 *
 * Answers with a Stripe-hosted URL to send the browser to. Never called from
 * the iOS app: see the note at the top of this file.
 */
billing.post("/billing/checkout", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    if (!c.env.STRIPE_SECRET_KEY) {
      return c.json({ error: "unavailable", message: "Billing is not configured yet." }, 503);
    }

    let body: { plan?: unknown };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }

    const plan = String(body.plan ?? "monthly") as PlanName;
    if (!(plan in PLANS)) {
      return c.json({ error: "bad_request", message: "Unknown plan." }, 400);
    }
    const price = c.env[PLANS[plan]];
    if (!price) {
      return c.json({ error: "unavailable", message: "That plan is not configured." }, 503);
    }

    /* Somebody already paying through Apple must not be sold a second
       subscription here. They would be charged twice and could only cancel
       one of them from this side. */
    if (auth.user.billingSource === "apple" && auth.user.plan === "active") {
      return c.json({
        error: "conflict",
        message: "This account already subscribes through the App Store. " +
                 "Manage it in Settings on your iPhone.",
      }, 409);
    }

    let customerId = auth.user.stripeCustomerId;
    if (!customerId) {
      const customer = await createCustomer(c.env, auth.user.email, auth.user.id);
      customerId = customer.id;
      await db.update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.id, auth.user.id));
    }

    const origin = new URL(c.req.url).origin;
    const session = await createCheckoutSession(c.env, {
      customer: customerId,
      price,
      userId: auth.user.id,
      /* Back into the app, not onto a Stripe page. The webhook is what
         actually grants access -- these two only decide where the browser
         lands, and the success page must therefore cope with arriving before
         the webhook has been processed. */
      successUrl: `${origin}/app/?checkout=done`,
      cancelUrl: `${origin}/app/?checkout=cancelled`,
    });

    return c.json({ ok: true, url: session.url });
  } catch (err) {
    if (err instanceof StripeError) {
      return c.json({ error: "stripe", message: err.message }, 502);
    }
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * POST /api/billing/portal
 *
 * Stripe's own page for changing a card or cancelling. Cancelling is done
 * where the subscription was bought, which is why this refuses an Apple
 * subscriber rather than showing them a portal that knows nothing about it.
 */
billing.post("/billing/portal", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    if (auth.user.billingSource === "apple") {
      return c.json({
        error: "conflict",
        message: "This subscription is managed by Apple. " +
                 "Open Settings on your iPhone, tap your name, then Subscriptions.",
      }, 409);
    }
    if (!auth.user.stripeCustomerId) {
      return c.json({ error: "not_found", message: "No subscription to manage." }, 404);
    }

    const origin = new URL(c.req.url).origin;
    const session = await createPortalSession(
      c.env, auth.user.stripeCustomerId, `${origin}/app/`,
    );
    return c.json({ ok: true, url: session.url });
  } catch (err) {
    if (err instanceof StripeError) {
      return c.json({ error: "stripe", message: err.message }, 502);
    }
    throw err;
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * POST /api/billing/stripe-webhook
 *
 * Unauthenticated by necessity — Stripe has no session — and therefore
 * signature-verified before a single byte of it is believed. Mounted outside
 * any auth middleware for the same reason.
 *
 * Answers 200 to anything it has understood, INCLUDING events it does not act
 * on. A non-2xx tells Stripe to retry, and retrying an event that will never
 * be interesting just fills the log. It answers 400 only when the signature
 * fails, which is the one case where Stripe should not retry either, but where
 * something is wrong and ought to be visible.
 */
billing.post("/billing/stripe-webhook", async (c) => {
  /* The raw text, not c.req.json(). The signature is over the bytes Stripe
     sent, and re-serialising the parsed object changes them. */
  const raw = await c.req.text();
  const verified = await verifyWebhook(
    raw, c.req.header("stripe-signature") ?? null, c.env.STRIPE_WEBHOOK_SECRET ?? "",
  );
  if (!verified.ok) {
    console.warn("stripe webhook rejected:", verified.reason);
    return c.json({ error: "bad_signature", reason: verified.reason }, 400);
  }

  const event = verified.event;
  const kind: string = event?.type ?? "";
  const object: any = event?.data?.object ?? {};

  /* Only these four matter. Stripe sends dozens of event types and an endpoint
     that tries to interpret all of them is an endpoint that will one day
     interpret one wrongly. */
  const INTERESTING = new Set([
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]);
  if (!INTERESTING.has(kind)) return c.json({ ok: true, ignored: kind });

  const { db, ready, close } = getDb(c.env);
  try {
    await ready;

    /* A checkout session names a subscription but does not describe it, so it
       is fetched. One extra call, on the one event per subscriber where an
       extra call does not matter, and it means every branch below is reading
       the same shape. */
    let sub: any = object;
    if (kind === "checkout.session.completed") {
      if (!object.subscription) return c.json({ ok: true, ignored: "no subscription" });
      sub = await getSubscription(c.env, String(object.subscription));
    }

    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    const userId: string | undefined =
      sub.metadata?.bilancio_user_id ?? object.metadata?.bilancio_user_id;

    /* By customer id first, because that is the durable link; by the metadata
       we stamped on the subscription second, for the case where the local row
       lost its customer id. */
    const [found] = customerId
      ? await db.select().from(users).where(eq(users.stripeCustomerId, customerId)).limit(1)
      : [];
    const [byMeta] = !found && userId
      ? await db.select().from(users).where(eq(users.id, userId)).limit(1)
      : [];
    const user = found ?? byMeta;

    if (!user) {
      /* Not an error worth retrying: a customer that belongs to no user here
         is either from another environment sharing the Stripe account, or a
         user who deleted themselves. Logged, accepted, dropped. */
      console.warn("stripe webhook for unknown customer", customerId);
      return c.json({ ok: true, ignored: "unknown customer" });
    }

    /* A comped account is a promise made by a person and is not Stripe's to
       revoke. Payment details can still be recorded against it. */
    if (user.plan === "free") {
      await db.update(users)
        .set({ stripeCustomerId: customerId ?? user.stripeCustomerId })
        .where(eq(users.id, user.id));
      return c.json({ ok: true, ignored: "comped account" });
    }

    /* Nor may Stripe touch somebody whose subscription lives at Apple. */
    if (user.billingSource === "apple" && user.plan === "active") {
      console.warn("stripe webhook ignored for Apple subscriber", user.id);
      return c.json({ ok: true, ignored: "subscribed through Apple" });
    }

    const paid = kind !== "customer.subscription.deleted" && PAID.has(String(sub.status));
    /* current_period_end is seconds, and it is the moment access actually runs
       out -- including for somebody who has cancelled but paid to the end of
       the month, which is why cancel_at_period_end is not consulted here. */
    const until = sub.current_period_end
      ? new Date(Number(sub.current_period_end) * 1000)
      : null;

    await db.update(users).set({
      plan: paid ? "active" : "lapsed",
      planUntil: paid ? until : new Date(),
      billingSource: paid ? "stripe" : user.billingSource,
      stripeCustomerId: customerId ?? user.stripeCustomerId,
      stripeSubscriptionId: paid ? String(sub.id) : null,
      planNote: paid ? "stripe" : "stripe:ended",
    }).where(eq(users.id, user.id));

    return c.json({ ok: true, plan: paid ? "active" : "lapsed" });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * GET /api/billing/status
 *
 * What the page needs to decide what to offer: the plan, when it runs out,
 * and where it is managed. No Stripe call — everything here is already local,
 * and a page load should not depend on Stripe being up.
 */
billing.get("/billing/status", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    /* Which processor this caller would be buying through.
     *
     * Not a preference: a purchase made inside the iOS app has to go through
     * Apple (guideline 3.1.1) and one made in a browser goes through Stripe,
     * so "is billing switched on" has two different answers depending on who
     * is asking. Answered here rather than in each client, so the rule lives
     * in one place -- which is what the field below has always promised and
     * did not previously do.
     *
     * The header is a hint from the caller and is treated as one. Nothing is
     * granted by it; the worst a lie achieves is being shown the wrong thing
     * to buy, and the purchase itself is verified either way. */
    const onApple = c.req.header("x-bilancio-client") === "ios";
    const sellable = onApple ? appleConfigured(c.env) : !!c.env.STRIPE_SECRET_KEY;

    return c.json({
      ok: true,
      plan: auth.user.plan,
      planUntil: auth.user.planUntil,
      source: auth.user.billingSource ?? null,
      /* Whether this device can sell, to this caller. False on iOS until the
         Apple bindings are set, which is what lets the app ship with the
         subscription screen showing a plan and offering nothing -- rather
         than offering products that App Store Connect does not yet have. */
      canSubscribeHere: sellable,
      manageAt: auth.user.billingSource === "apple" ? "apple" : "stripe",
      configured: sellable,
      /* Handed to StoreKit as the purchase's appAccountToken, so that Apple
         itself will later tell us which account bought it. It is the user id
         and nothing more secret than that -- the caller is already
         authenticated as this user -- and it is what stops one person's
         original transaction id from being usable to claim their subscription
         somewhere else. See the note in apple.ts. */
      accountToken: auth.user.id,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------ apple -- */

/**
 * Turning what Apple says into the two columns, in one place.
 *
 * Shared by the route the app calls and the notifications Apple sends, because
 * a renewal that arrives by one path and by the other must mean the same thing.
 * `user` is the row as it stands; the caller has already decided this
 * subscription is theirs to write.
 */
function applyApple(
  user: { id: string; plan: string; billingSource: string | null;
          appleOriginalTransactionId: string | null },
  sub: AppleSubscription,
  originalTransactionId: string,
) {
  /* A refund is not a lapse that will sort itself out -- Apple has taken the
     money back -- so it ends access whatever the status field says. */
  const paid = applePaid(sub.status) && !sub.transaction.revocationDate;
  const until = sub.transaction.expiresDate
    ? new Date(Number(sub.transaction.expiresDate))
    : null;

  return {
    paid,
    set: {
      plan: paid ? "active" as const : "lapsed" as const,
      /* Not null when unpaid: an account with no end date reads as comped
         everywhere else. The moment it stopped is the honest answer. */
      planUntil: paid ? until : new Date(),
      billingSource: paid ? "apple" : user.billingSource,
      appleOriginalTransactionId: originalTransactionId,
      planNote: paid ? "apple" : "apple:ended",
    },
  };
}

/**
 * POST /api/billing/apple      { signedTransaction: "<JWS from StoreKit>" }
 *
 * The app finishes a purchase, hands the signed transaction over, and this
 * decides what it means.
 *
 * ── What is done with the phone's payload ───────────────────────────────────
 *
 * One thing: an id is taken out of it. The signature is not checked, the
 * expiry is not read, and nothing in it is believed. That id is then put to
 * Apple over TLS with our own credentials, and what comes back is what is
 * written. A phone that lies about its payload has managed to ask a question.
 *
 * ── Whose subscription it is ────────────────────────────────────────────────
 *
 * An original transaction id is not a secret, so "I know this id" cannot be
 * allowed to mean "this is mine". Two checks stand between the two:
 *
 *   1. `appAccountToken`, which the app attaches at purchase and Apple hands
 *      back in its own reply. When it is there it settles the question, because
 *      Apple is the one saying it.
 *   2. First claim wins, for purchases made before the app started sending one.
 *      A subscription already recorded against another account is refused.
 */
billing.post("/billing/apple", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    if (!appleConfigured(c.env)) {
      return c.json({ error: "unavailable", message: "Apple billing is not configured yet." }, 503);
    }

    let body: { signedTransaction?: unknown };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "bad_request", message: "Body must be JSON." }, 400); }

    const jws = body.signedTransaction;
    if (typeof jws !== "string" || !jws) {
      return c.json({ error: "bad_request", message: "signedTransaction is required." }, 400);
    }

    // Pointer, not evidence. See the note above and the one in apple.ts.
    const claimed = peek(jws);
    const askAbout = claimed?.originalTransactionId ?? claimed?.transactionId;
    if (!askAbout) {
      return c.json({ error: "bad_request", message: "That is not a StoreKit transaction." }, 400);
    }

    let sub: AppleSubscription | null;
    try { sub = await subscriptionStatus(c.env, String(askAbout)); }
    catch (err) {
      if (err instanceof AppleError) {
        console.warn("apple:", err.message);
        return c.json({ error: "apple", message: err.message }, err.status as 502);
      }
      throw err;
    }

    if (!sub) {
      /* Apple has never heard of it, in either environment. A made-up id, or a
         transaction from a different App Store account than the key we hold. */
      return c.json({
        error: "not_found",
        message: "Apple has no record of that purchase.",
      }, 404);
    }

    // A transaction signed for another app is not evidence about this one.
    if (sub.transaction.bundleId && sub.transaction.bundleId !== c.env.APPLE_BUNDLE_ID) {
      console.warn("apple transaction for another bundle:", sub.transaction.bundleId);
      return c.json({ error: "bad_request", message: "That purchase belongs to another app." }, 400);
    }

    const originalTransactionId =
      sub.transaction.originalTransactionId ?? String(askAbout);

    /* Apple's own word on who bought it, where there is one. Compared
       case-insensitively because a UUID's hex is written either way and Apple
       does not promise which. */
    const token = sub.transaction.appAccountToken;
    if (token && token.toLowerCase() !== auth.user.id.toLowerCase()) {
      console.warn("apple purchase claimed by the wrong account", auth.user.id);
      return c.json({
        error: "conflict",
        message: "That subscription belongs to a different Bilancio account. " +
                 "Sign in with the account it was bought on.",
      }, 409);
    }

    if (!token) {
      // First claim wins, for anything bought before the app sent a token.
      const [held] = await db.select().from(users)
        .where(eq(users.appleOriginalTransactionId, originalTransactionId)).limit(1);
      if (held && held.id !== auth.user.id) {
        return c.json({
          error: "conflict",
          message: "That subscription is already on another Bilancio account.",
        }, 409);
      }
    }

    const { paid, set } = applyApple(auth.user, sub, originalTransactionId);

    /* A comped account is a promise made by a person and is not Apple's to
       revoke. The id is still recorded, so that when the comp ends the
       subscription behind it is already known. */
    if (auth.user.plan === "free") {
      await db.update(users)
        .set({ appleOriginalTransactionId: originalTransactionId })
        .where(eq(users.id, auth.user.id));
      return c.json({ ok: true, plan: "free", planUntil: auth.user.planUntil });
    }

    /* An expired or refunded transaction may only end the subscription it
       belongs to. Restoring on a new phone replays old transactions, and an
       expired one from two years ago must not knock somebody out of a trial
       -- or out of a subscription they are currently paying Stripe for. */
    if (!paid &&
        auth.user.appleOriginalTransactionId !== originalTransactionId &&
        auth.user.billingSource !== "apple") {
      return c.json({ ok: true, plan: auth.user.plan, planUntil: auth.user.planUntil });
    }

    if (paid && auth.user.billingSource === "stripe" && auth.user.plan === "active") {
      /* They are about to be paying twice. Apple's is honoured, because they
         have just paid it and only they can cancel it; the Stripe ids are left
         in place so the web side can still find and cancel that one. */
      console.warn("apple purchase by an active Stripe subscriber", auth.user.id);
    }

    await db.update(users).set(set).where(eq(users.id, auth.user.id));

    console.log(`apple ${sub.environment} ${paid ? "active" : "ended"}`,
                sub.transaction.productId ?? "?");
    return c.json({ ok: true, plan: set.plan, planUntil: set.planUntil });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * POST /api/billing/apple-notifications
 *
 * Renewals, cancellations, refunds and billing failures, sent by Apple.
 * Unauthenticated by necessity: Apple has no session here.
 *
 * ── Why it is not signature-verified ────────────────────────────────────────
 *
 * Because it does not need to be. Nothing in the notification is believed.
 * It is read for a transaction id, and that id is put to Apple in a fresh
 * request over TLS; what Apple answers is what gets written. A forged
 * notification therefore achieves one of two things: an id Apple does not
 * know, which does nothing, or an id it does, in which case we write the truth
 * about a subscription — which is what we would have written anyway.
 *
 * That is a stronger position than a verified webhook whose contents are then
 * trusted, and it is the same trade made on the route above.
 *
 * Answers 200 to everything it has understood, including what it ignores.
 * A non-2xx tells Apple to retry, and retrying something that will never be
 * interesting only fills the log.
 */
billing.post("/billing/apple-notifications", async (c) => {
  let body: { signedPayload?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "bad_request" }, 400); }

  if (typeof body.signedPayload !== "string") {
    return c.json({ error: "bad_request" }, 400);
  }

  const note = peek<AppleNotification>(body.signedPayload);
  const kind = note?.notificationType ?? "";

  /* Apple sends around twenty types. These are the ones that change whether
     somebody may use the app; TEST is here so that App Store Connect's "send
     a test notification" button gets a clean 200 rather than an ignore. */
  const INTERESTING = new Set([
    "DID_RENEW", "EXPIRED", "DID_CHANGE_RENEWAL_STATUS", "REFUND",
    "SUBSCRIBED", "DID_FAIL_TO_RENEW", "GRACE_PERIOD_EXPIRED", "REVOKE",
  ]);
  if (kind === "TEST") return c.json({ ok: true, test: true });
  if (!INTERESTING.has(kind)) return c.json({ ok: true, ignored: kind || "unreadable" });

  const inner = note?.data?.signedTransactionInfo
    ? peek(note.data.signedTransactionInfo)
    : null;
  const askAbout = inner?.originalTransactionId ?? inner?.transactionId;
  if (!askAbout) return c.json({ ok: true, ignored: "no transaction" });

  const { db, ready, close } = getDb(c.env);
  try {
    await ready;

    const [user] = await db.select().from(users)
      .where(eq(users.appleOriginalTransactionId, String(askAbout))).limit(1);
    if (!user) {
      /* A subscription belonging to no account here: bought and then never
         handed over, or an account since deleted. Nothing to write. */
      return c.json({ ok: true, ignored: "unknown subscription" });
    }
    if (user.plan === "free") return c.json({ ok: true, ignored: "comped account" });

    let sub: AppleSubscription | null;
    try { sub = await subscriptionStatus(c.env, String(askAbout)); }
    catch (err) {
      if (err instanceof AppleError) {
        /* 500, deliberately, so Apple retries. Unlike a bad payload, "we could
           not reach Apple" is a condition that goes away on its own. */
        console.warn("apple notification:", err.message);
        return c.json({ error: "apple", message: err.message }, 500);
      }
      throw err;
    }
    if (!sub) return c.json({ ok: true, ignored: "unknown to Apple" });

    const { paid, set } = applyApple(user, sub, String(askAbout));
    await db.update(users).set(set).where(eq(users.id, user.id));

    console.log(`apple notification ${kind} -> ${paid ? "active" : "lapsed"}`);
    return c.json({ ok: true, plan: set.plan });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default billing;

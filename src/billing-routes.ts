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

    return c.json({
      ok: true,
      plan: auth.user.plan,
      planUntil: auth.user.planUntil,
      source: auth.user.billingSource ?? null,
      /* Whether this device can sell. The web can; the iOS app must not, and
         reads this rather than deciding for itself, so the rule lives in one
         place if it ever changes. */
      canSubscribeHere: true,
      manageAt: auth.user.billingSource === "apple" ? "apple" : "stripe",
      configured: !!c.env.STRIPE_SECRET_KEY,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default billing;

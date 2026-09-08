/**
 * Stripe, over plain fetch.
 *
 * No SDK. The same decision src/plaid.ts made and for the same reasons: the
 * Worker bundle is shipped to every edge location on every deploy, Stripe's
 * Node library carries a great deal that a subscription flow never touches,
 * and the four calls below are four HTTP requests. The one thing an SDK would
 * genuinely have saved — webhook signature verification — is thirty lines of
 * WebCrypto, and writing it out is worth more than importing it, because it
 * is the part where getting it subtly wrong means accepting forged webhooks.
 *
 * ── Where this fits ─────────────────────────────────────────────────────────
 *
 * Stripe collects on the web only. Inside the iOS app, App Store guideline
 * 3.1.1 requires Apple's in-app purchase and forbids anything else, so this
 * module must never be reachable from there. Both paths write to the same
 * `plan` and `plan_until` columns; see src/billing-routes.ts.
 */

/** Stripe wants form encoding, including for nested objects. */
function formEncode(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      out.push(...formEncode(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

/* Fields written out rather than declared as constructor parameter properties.
   That shorthand is TypeScript-only syntax rather than a type annotation, so
   Node's type stripping refuses it — and this module is worth being able to
   import from a plain test runner, since the verification below is the part
   that must not be subtly wrong. */
export class StripeError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
  }
}

const API = "https://api.stripe.com/v1";

async function call<T>(
  env: Env, method: "GET" | "POST", path: string, body?: Record<string, unknown>,
  /* Stripe deduplicates by this for 24 hours. Passed on any call that creates
     something, so a retry after a timeout cannot make a second customer or a
     second subscription out of one click. */
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const encoded = body ? formEncode(body).join("&") : undefined;
  const url = method === "GET" && encoded ? `${API}${path}?${encoded}` : `${API}${path}`;

  const res = await fetch(url, {
    method, headers, body: method === "POST" ? encoded : undefined,
  });

  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new StripeError(`Stripe returned non-JSON from ${path}`, res.status); }

  if (!res.ok) {
    throw new StripeError(
      json?.error?.message ?? `Stripe ${path} failed`,
      res.status,
      json?.error?.code,
    );
  }
  return json as T;
}

export interface StripeCustomer { id: string }
export interface StripeSession { id: string; url: string }
export interface StripeSubscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  customer: string;
}

/** A customer for this user, created once and reused. */
export function createCustomer(
  env: Env, email: string, userId: string,
): Promise<StripeCustomer> {
  return call(env, "POST", "/customers", {
    email,
    /* The user id travels with the customer so a webhook can find its way
       home even if the local row lost the customer id somehow. Belt and
       braces: the lookup is by customer id, this is the fallback. */
    metadata: { bilancio_user_id: userId },
  }, `customer:${userId}`);
}

/** A hosted checkout page for one subscription. */
export function createCheckoutSession(
  env: Env,
  opts: { customer: string; price: string; successUrl: string; cancelUrl: string; userId: string },
): Promise<StripeSession> {
  return call(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    customer: opts.customer,
    line_items: [{ price: opts.price, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    /* Copied onto the subscription itself, not just the session. The session
       is gone by the time a renewal three months from now fires a webhook;
       the subscription is what that webhook carries. */
    subscription_data: { metadata: { bilancio_user_id: opts.userId } },
    /* Stripe collects the address it needs for tax; nothing here stores it. */
    billing_address_collection: "auto",
  });
}

/** Stripe's own page for changing a card or cancelling. */
export function createPortalSession(
  env: Env, customer: string, returnUrl: string,
): Promise<StripeSession> {
  return call(env, "POST", "/billing_portal/sessions", {
    customer, return_url: returnUrl,
  });
}

export function getSubscription(env: Env, id: string): Promise<StripeSubscription> {
  return call(env, "GET", `/subscriptions/${id}`);
}

/* ────────────────────────────────────────────────── webhook verification ── */

const encoder = new TextEncoder();

/** Constant-time compare. A fast `!==` on a signature leaks it a byte at a time. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/* How far out of step with Stripe a webhook may be and still be accepted.
 *
 * The timestamp is inside the signed payload, so replaying an old event means
 * replaying its signature with its original timestamp. Five minutes is
 * Stripe's own recommendation: long enough to survive a slow retry and a
 * clock that drifts, short enough that a captured request stops working
 * before anybody can do much with it. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Is this really from Stripe?
 *
 * The Stripe-Signature header carries a timestamp and one or more v1
 * signatures, each an HMAC-SHA256 of "timestamp.body" under the endpoint
 * secret. More than one appears while a secret is being rotated, so any
 * matching signature is enough.
 *
 * Takes the RAW body text. Parsing and re-serialising the JSON first would
 * change the bytes — key order, spacing, number formatting — and the
 * signature is over the bytes Stripe sent. This is the single most common way
 * webhook verification is broken, and it fails closed, so it fails loudly.
 */
export async function verifyWebhook(
  rawBody: string, header: string | null, secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; event: any } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: "no signature header" };
  if (!secret) return { ok: false, reason: "no endpoint secret configured" };

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") timestamp = v ?? "";
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed signature header" };

  const age = now - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = hex(await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`${timestamp}.${rawBody}`),
  ));

  if (!signatures.some((s) => equal(s, mac))) return { ok: false, reason: "signature mismatch" };

  try { return { ok: true, event: JSON.parse(rawBody) }; }
  catch { return { ok: false, reason: "signed body was not JSON" }; }
}

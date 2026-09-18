/**
 * Asking Google Play who has paid.
 *
 * ── The same rule as apple.ts ───────────────────────────────────────────────
 *
 * A purchase token from a phone is a pointer, never evidence. The app hands
 * one over after a purchase; it is put to the Google Play Developer API over
 * TLS with our own service account, and what Google answers is what gets
 * written. A phone that lies has managed to ask a question. The reasoning is
 * set out at the top of apple.ts and holds here unchanged.
 *
 * ── Whose subscription it is ────────────────────────────────────────────────
 *
 * The app passes the Bilancio user id to Play as the purchase's obfuscated
 * account id, and Google hands it back inside its own answer. That is Google
 * saying who bought it, and it settles the question the way appAccountToken
 * does for Apple.
 *
 * ── One product, two base plans ─────────────────────────────────────────────
 *
 * Play's model is a subscription product with base plans under it, and moving
 * between monthly and yearly is a plan change inside one product rather than
 * a second subscription. PRODUCT_ID below must match the product created in
 * Play Console, and the base plan ids must be "monthly" and "yearly".
 *
 * ── Acknowledgement ─────────────────────────────────────────────────────────
 *
 * Google refunds any purchase not acknowledged within three days. It is done
 * here, by the server, once Google has confirmed the purchase -- not by the
 * app, which would be acknowledging something nobody had checked.
 *
 * ── Everything is optional ──────────────────────────────────────────────────
 *
 * Until GOOGLE_PLAY_SERVICE_ACCOUNT is set, configured() is false, the route
 * answers 503 and the Android app offers nothing to buy.
 */

import { ANDROID_PACKAGE } from "./plaid";

/** The subscription product in Play Console. Base plans: monthly, yearly. */
export const PRODUCT_ID = "bilancio_subscription";

export class GoogleError extends Error {
  constructor(message: string, readonly status: number = 502) {
    super(message);
    this.name = "GoogleError";
  }
}

export function configured(env: Env): boolean {
  return !!env.GOOGLE_PLAY_SERVICE_ACCOUNT;
}

/* ------------------------------------------------------------------ auth -- */

interface ServiceAccount { client_email: string; private_key: string }

function serviceAccount(env: Env): ServiceAccount {
  let parsed: Partial<ServiceAccount>;
  try { parsed = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT ?? ""); }
  catch { throw new GoogleError("The Google service account is not valid JSON.", 503); }
  if (!parsed.client_email || !parsed.private_key) {
    throw new GoogleError("The Google service account is missing its email or key.", 503);
  }
  return parsed as ServiceAccount;
}

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* Held for the life of the isolate. Google's tokens last an hour; one is
   reused until five minutes before it runs out. */
let cached: { token: string; until: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const sa = serviceAccount(env);

  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  let key: CryptoKey;
  try {
    const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
    key = await crypto.subtle.importKey(
      "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
  } catch {
    throw new GoogleError("The Google service account key is not readable.", 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.warn("google token refused:", res.status, body.error ?? "");
    throw new GoogleError("Google refused the service account.", 502);
  }
  cached = { token: body.access_token, until: Date.now() + (Number(body.expires_in ?? 3600) - 300) * 1000 };
  return cached.token;
}

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE}`;

async function call(env: Env, method: string, path: string): Promise<Response> {
  return fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(env)}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: method === "POST" ? "{}" : undefined,
  });
}

/* ----------------------------------------------------------- subscription -- */

export interface GoogleSubscription {
  /** SUBSCRIPTION_STATE_ACTIVE, _IN_GRACE_PERIOD, _CANCELED, _ON_HOLD, ... */
  state: string;
  /** The latest expiry across the line items; when access runs out. */
  expiry: Date | null;
  productId: string | null;
  /** The Bilancio user id the app attached at purchase, as Google reports it. */
  accountId: string | null;
  acknowledged: boolean;
  /** The token this one replaced, on a plan change or resubscribe. */
  linkedPurchaseToken: string | null;
  test: boolean;
}

/** Google's answer about one purchase token, or null when it has none. */
export async function subscription(env: Env, token: string): Promise<GoogleSubscription | null> {
  const res = await call(env, "GET", `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  if (res.status === 404 || res.status === 410 || res.status === 400) return null;
  if (!res.ok) {
    console.warn("google subscription lookup:", res.status);
    throw new GoogleError("Google Play could not be reached.", 502);
  }
  const s: any = await res.json();
  const items: any[] = Array.isArray(s.lineItems) ? s.lineItems : [];
  let expiry: Date | null = null;
  let productId: string | null = null;
  for (const li of items) {
    const at = li.expiryTime ? new Date(li.expiryTime) : null;
    if (at && (!expiry || at > expiry)) { expiry = at; productId = li.productId ?? productId; }
    productId ??= li.productId ?? null;
  }
  return {
    state: String(s.subscriptionState ?? ""),
    expiry,
    productId,
    accountId: s.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    acknowledged: s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    linkedPurchaseToken: s.linkedPurchaseToken ?? null,
    test: !!s.testPurchase,
  };
}

/* A cancelled subscription has had auto-renew switched off and still runs to
   the end of what was paid for, which is why CANCELED is here. ON_HOLD and
   PAUSED are payment trouble or a chosen pause: no access until it resumes. */
const PAID_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);

export function isPaid(sub: GoogleSubscription, now = new Date()): boolean {
  return PAID_STATES.has(sub.state) && !!sub.expiry && sub.expiry > now;
}

/** Tells Google the purchase has been granted, so it is not refunded. */
export async function acknowledge(env: Env, sub: GoogleSubscription, token: string): Promise<void> {
  if (sub.acknowledged || !sub.productId) return;
  const res = await call(env, "POST",
    `/purchases/subscriptions/${encodeURIComponent(sub.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  if (!res.ok) console.warn("google acknowledge failed:", res.status);
}

/** Stops renewal. Access runs to the end of the paid period, as at Stripe. */
export async function cancel(env: Env, token: string): Promise<void> {
  const sub = await subscription(env, token);
  if (!sub || !sub.productId || !isPaid(sub) || sub.state === "SUBSCRIPTION_STATE_CANCELED") return;
  const res = await call(env, "POST",
    `/purchases/subscriptions/${encodeURIComponent(sub.productId)}/tokens/${encodeURIComponent(token)}:cancel`);
  if (!res.ok) throw new GoogleError(`Google Play would not cancel the subscription (${res.status}).`);
}

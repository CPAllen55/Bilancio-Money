/**
 * Sending a notification to a phone, through Apple.
 *
 * ── Straight to APNs, from the Worker ───────────────────────────────────────
 *
 * APNs speaks only HTTP/2, and fetch reaches it from a deployed Worker. The
 * same request fails under local workerd on macOS (cloudflare/workerd#4841),
 * so this can only ever be tried against the deployed Worker and a real phone,
 * never from a laptop. No relay and no third party: a JSON body, a signed
 * token, one POST.
 *
 * ── The provider token ──────────────────────────────────────────────────────
 *
 * An ES256 JWT signed with the APNs key. Apple wants it refreshed no more often
 * than every twenty minutes and no less often than every sixty, and answers
 * TooManyProviderTokenUpdates to anybody who signs a fresh one per request. So
 * one is kept for the life of the isolate and reused for forty-five minutes.
 *
 * It signs its own rather than sharing apple.ts's signer. Same algorithm,
 * different key and claims -- and apple.ts decides who has paid and has been
 * checked against Apple exactly as it stands, which is not worth disturbing to
 * save thirty lines.
 *
 * ── Everything optional ─────────────────────────────────────────────────────
 *
 * With APNS_KEY_ID or APNS_PRIVATE_KEY unset nothing is sent and nothing
 * fails: `pushConfigured` is false, the alert check returns before doing any
 * work, and the app shows alerts as not yet available.
 */

import type { pushDevices } from "./db/schema";

type Device = Pick<typeof pushDevices.$inferSelect, "token" | "environment">;

export function pushConfigured(env: Env): boolean {
  return !!(env.APNS_KEY_ID && env.APNS_PRIVATE_KEY && env.APNS_TEAM_ID);
}

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextEncoder();
const REUSE_MS = 45 * 60 * 1000;
let cached: { token: string; madeAt: number; keyId: string } | null = null;

async function providerToken(env: Env): Promise<string> {
  const now = Date.now();
  const keyId = String(env.APNS_KEY_ID);
  if (cached && cached.keyId === keyId && now - cached.madeAt < REUSE_MS) return cached.token;

  /* Whitespace in every form a pasted secret picks up: real newlines, the
     two literal characters a shell leaves behind, stray spaces. */
  const pem = String(env.APNS_PRIVATE_KEY)
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", fromBase64(pem) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );

  const head = toBase64Url(utf8.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = toBase64Url(utf8.encode(JSON.stringify({
    iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000),
  })));
  // WebCrypto signs ECDSA as raw r||s, which is exactly the JWS form.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(`${head}.${claims}`) as BufferSource,
  ));

  cached = { token: `${head}.${claims}.${toBase64Url(sig)}`, madeAt: now, keyId };
  return cached.token;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Matches a UNNotificationCategory the app registered, for its buttons. */
  category?: string;
  /** Groups related notifications together in Notification Centre. */
  threadId?: string;
  /** A later notification with the same id replaces this one on the phone. */
  collapseId?: string;
  /** Top-level keys the app reads when the notification is opened. */
  data?: Record<string, string>;
}

export interface PushResult {
  ok: boolean;
  /** The token will never work again, and should be forgotten. */
  gone: boolean;
  reason?: string;
}

export async function sendPush(env: Env, device: Device, message: PushMessage): Promise<PushResult> {
  if (!pushConfigured(env)) return { ok: false, gone: false, reason: "not configured" };
  // Hex, as the app sends it. Anything else was never a token and never will be.
  if (!/^[0-9a-f]{32,200}$/i.test(device.token)) return { ok: false, gone: true, reason: "malformed token" };

  const host = device.environment === "sandbox" ? HOSTS.sandbox : HOSTS.production;
  const payload = {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: "default",
      ...(message.category ? { category: message.category } : {}),
      ...(message.threadId ? { "thread-id": message.threadId } : {}),
    },
    ...(message.data ?? {}),
  };

  const headers: Record<string, string> = {
    authorization: `bearer ${await providerToken(env)}`,
    "apns-topic": env.APPLE_BUNDLE_ID ?? "com.bilanciomoney.Bilancio",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  };
  if (message.collapseId) headers["apns-collapse-id"] = message.collapseId;

  let res: Response;
  try {
    res = await fetch(`${host}/3/device/${device.token}`, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, gone: false, reason: `unreachable: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true, gone: false };

  let reason = "";
  try { reason = ((await res.json()) as { reason?: string }).reason ?? ""; } catch { /* empty body */ }

  // A token Apple has stopped accepting is re-signed on the next send.
  if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") cached = null;

  /* Forget the device only when the token itself is finished. BadDeviceToken
     is most often a sandbox token sent to production or the reverse; the app
     registers again on its next launch, with the right environment. */
  const gone = res.status === 410 || reason === "Unregistered" ||
    reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
  return { ok: false, gone, reason: `${res.status} ${reason}`.trim() };
}

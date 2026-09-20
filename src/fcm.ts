/**
 * Sending a notification to an Android phone, through Firebase.
 *
 * ── Why a second sender ─────────────────────────────────────────────────────
 *
 * Apple's phones are reached at APNs with an ES256 token; Google's are reached
 * at FCM with an OAuth token minted from a service account. Nothing about the
 * two is shared except the shape of the message, so push.ts holds that shape
 * and hands each device to whichever of the two can reach it.
 *
 * ── What is sent ────────────────────────────────────────────────────────────
 *
 * A `notification` block, so Android draws the alert itself whether or not the
 * app is running, plus the same data keys the iPhone gets. `collapse_key` is
 * FCM's own collapsing: "over budget" replaces "nearly spent" on the phone
 * rather than stacking beneath it, exactly as apns-collapse-id does.
 *
 * ── Everything optional ─────────────────────────────────────────────────────
 *
 * With FCM_SERVICE_ACCOUNT unset, `configured` is false and Android devices
 * are simply not sent to. The iPhone side is unaffected either way.
 */

export function configured(env: Env): boolean {
  return !!env.FCM_SERVICE_ACCOUNT;
}

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

function account(env: Env): ServiceAccount {
  let parsed: Partial<ServiceAccount>;
  try { parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT ?? ""); }
  catch { throw new Error("The Firebase service account is not valid JSON."); }
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error("The Firebase service account is missing its email, key or project.");
  }
  return parsed as ServiceAccount;
}

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* Held for the life of the isolate; Google's last an hour and one is reused
   until five minutes before it runs out. */
let cached: { token: string; until: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const sa = account(env);

  const pem = sa.private_key
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned) as BufferSource,
  ));

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
    throw new Error(`Firebase refused the service account (${res.status}).`);
  }
  cached = { token: body.access_token, until: Date.now() + (Number(body.expires_in ?? 3600) - 300) * 1000 };
  return cached.token;
}

export interface FcmMessage {
  title: string;
  body: string;
  collapseKey?: string;
  data?: Record<string, string>;
}

export interface FcmResult { ok: boolean; gone: boolean; reason?: string }

/** The notification channel the app creates; without it Android 8+ is silent. */
export const CHANNEL_ID = "budget_alerts";

export async function sendFcm(env: Env, token: string, message: FcmMessage): Promise<FcmResult> {
  if (!configured(env)) return { ok: false, gone: false, reason: "not configured" };

  let bearer: string;
  let projectId: string;
  try {
    bearer = await accessToken(env);
    projectId = account(env).project_id;
  } catch (err) {
    return { ok: false, gone: false, reason: (err as Error).message };
  }

  const payload = {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      android: {
        priority: "HIGH",
        ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
        notification: {
          channel_id: CHANNEL_ID,
          /* Same tag, same slot on the phone: the later alert about a category
             replaces the earlier one instead of queueing behind it. */
          ...(message.collapseKey ? { tag: message.collapseKey } : {}),
        },
      },
      ...(message.data ? { data: message.data } : {}),
    },
  };

  let res: Response;
  try {
    res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, gone: false, reason: `unreachable: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true, gone: false };

  /* A token Google will never accept again: the app was uninstalled, or the
     token was replaced. Anything else is worth trying again next time. */
  let status = "";
  try {
    const body: any = await res.json();
    status = body?.error?.status ?? body?.error?.message ?? "";
  } catch { /* empty body */ }
  if (res.status === 401 || res.status === 403) cached = null;
  const gone = res.status === 404 || status === "NOT_FOUND" || status === "UNREGISTERED" ||
    (res.status === 400 && /registration token/i.test(status));
  return { ok: false, gone, reason: `${res.status} ${status}`.trim() };
}

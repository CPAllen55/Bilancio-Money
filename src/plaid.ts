/**
 * A thin Plaid client.
 *
 * Plaid's Node SDK targets Node, not Workers, and we need four endpoints — so
 * this is plain fetch instead. Credentials go in the body, which is how Plaid's
 * API expects them; there is no Authorization header.
 */

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class PlaidError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly errorType?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

async function plaidPost<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const host = HOSTS[env.PLAID_ENV] ?? HOSTS.sandbox;

  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body,
    }),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlaidError(`Plaid returned non-JSON from ${path}`, res.status);
  }

  if (!res.ok) {
    // Plaid's error_message is written for developers and is worth keeping;
    // request_id is what their support asks for first.
    throw new PlaidError(
      json.error_message ?? `Plaid ${path} failed`,
      res.status,
      json.error_code,
      json.error_type,
      json.request_id,
    );
  }

  return json as T;
}

/**
 * Which client is opening Link. Web is the default because it is what every
 * existing caller is, and an unrecognised value is treated as web rather than
 * refused — a new client sending something we do not know about should get a
 * working non-OAuth link, not an error.
 */
export type Platform = "web" | "ios";

export const platformFrom = (value: unknown): Platform => (value === "ios" ? "ios" : "web");

/**
 * Where the bank sends the browser back to, which is not the same place for
 * every client.
 *
 * redirect_uri is sent only when one is configured. Plaid rejects
 * /link/token/create outright if the value is not already registered under
 * Developers -> API -> Allowed redirect URIs, so sending a plausible guess
 * breaks linking entirely. It is only needed for banks that use an OAuth
 * hand-off, which none of the sandbox institutions do.
 *
 * The web value is an ordinary page. The iOS value must be a universal link:
 * Plaid does not accept custom URI schemes, and iOS only routes the URL into
 * the app if `.well-known/apple-app-site-association` says the app may claim
 * it and the app's Associated Domains entitlement names the host. Sending the
 * web URL to a native client is the failure this function exists to prevent —
 * Link would return into Safari and simply stop.
 *
 * Unset for iOS means no redirect_uri rather than the web one. A native client
 * then links every bank except OAuth ones, which is a smaller, more legible
 * failure than a hand-off that leaves the user staring at a browser.
 */
function redirectFor(env: Env, platform: Platform): string | undefined {
  return platform === "ios" ? env.PLAID_REDIRECT_URI_IOS : env.PLAID_REDIRECT_URI;
}

/**
 * A Link token for repairing an existing connection, not making a new one.
 *
 * When a bank changes credentials, adds an MFA step, or simply expires its
 * consent, Plaid puts the Item into ITEM_LOGIN_REQUIRED and every sync fails
 * until a person signs in again. Update mode is how they do that: the same
 * Link flow, opened against the Item that already exists, so the access token
 * survives and so does every transaction already stored against it.
 *
 * Two differences from a first link, both required rather than stylistic:
 *
 *   - `access_token` names the Item being repaired.
 *   - `products` must be ABSENT. Sending it alongside an access token is an
 *     error, because products are a property of an Item that already exists
 *     and cannot be renegotiated here. `transactions.days_requested` goes with
 *     it for the same reason — history was fixed when the Item was created.
 *
 * The public token Link hands back on success is NOT exchanged. The Item is
 * already ours; exchanging would mint a second one pointed at the same bank.
 */
export function createUpdateLinkToken(
  env: Env,
  clerkUserId: string,
  accessToken: string,
  platform: Platform = "web",
) {
  const redirect = redirectFor(env, platform);
  return plaidPost<{ link_token: string; expiration: string }>(env, "/link/token/create", {
    user: { client_user_id: clerkUserId },
    client_name: "Bilancio Money",
    access_token: accessToken,
    ...(env.PLAID_WEBHOOK_URL ? { webhook: env.PLAID_WEBHOOK_URL } : {}),
    country_codes: ["US"],
    language: "en",
    ...(redirect ? { redirect_uri: redirect } : {}),
  });
}

export function createLinkToken(env: Env, clerkUserId: string, platform: Platform = "web") {
  const redirect = redirectFor(env, platform);
  return plaidPost<{ link_token: string; expiration: string }>(env, "/link/token/create", {
    user: { client_user_id: clerkUserId },
    client_name: "Bilancio Money",
    products: ["transactions"],
    // Ask for everything the bank will give. Left unset, Plaid backfills 90
    // days and no more — which is why the first production link produced
    // exactly ninety days of history and looked like a bank limitation rather
    // than a default. 730 is the maximum Plaid accepts; institutions supply
    // what they hold, so less is normal and is not an error.
    //
    // This is honoured when the Item is created. An existing connection does
    // not gain history retroactively: to extend it, disconnect the bank and
    // link it again.
    transactions: { days_requested: 730 },
    ...(env.PLAID_WEBHOOK_URL ? { webhook: env.PLAID_WEBHOOK_URL } : {}),
    country_codes: ["US"],
    language: "en",
    ...(redirect ? { redirect_uri: redirect } : {}),
  });
}

/** Swaps the browser's short-lived public token for the long-lived access token. */
export function exchangePublicToken(env: Env, publicToken: string) {
  return plaidPost<{ access_token: string; item_id: string }>(
    env,
    "/item/public_token/exchange",
    { public_token: publicToken },
  );
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export function getAccounts(env: Env, accessToken: string) {
  return plaidPost<{ accounts: PlaidAccount[]; item: { institution_id: string | null } }>(
    env,
    "/accounts/get",
    { access_token: accessToken },
  );
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  merchant_entity_id: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  payment_channel: string | null;
  personal_finance_category: { primary: string; detailed: string } | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

/**
 * One page of /transactions/sync. The caller loops on has_more and stores
 * next_cursor, so a resync resumes rather than refetching everything.
 */
export function syncTransactions(env: Env, accessToken: string, cursor: string | null) {
  return plaidPost<SyncPage>(env, "/transactions/sync", {
    access_token: accessToken,
    ...(cursor ? { cursor } : {}),
    count: 500,
  });
}

export function getInstitution(env: Env, institutionId: string) {
  return plaidPost<{ institution: { name: string } }>(env, "/institutions/get_by_id", {
    institution_id: institutionId,
    country_codes: ["US"],
  });
}

/**
 * Tells Plaid to forget an Item, and reports whether it worked.
 *
 * Deleting our copy is only half of a disconnect. Until /item/remove is called
 * the access token stays live at Plaid and the connection keeps appearing in
 * the user's Plaid Portal — so the person who asked to disconnect their bank
 * would still be connected to it, just invisibly.
 *
 * An Item Plaid has already forgotten counts as success: the desired end state
 * is that it is gone, and it is.
 */
export async function removeItem(env: Env, accessToken: string): Promise<void> {
  try {
    await plaidPost<Record<string, never>>(env, "/item/remove", { access_token: accessToken });
  } catch (err) {
    const code = err instanceof PlaidError ? err.errorCode : null;
    if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") return;
    throw err;
  }
}
/** Points an existing Item at a webhook URL. New Items get it from the link token. */
export function updateItemWebhook(env: Env, accessToken: string, webhook: string) {
  return plaidPost<{ item: unknown }>(env, "/item/webhook/update", {
    access_token: accessToken,
    webhook,
  });
}

/**
 * Verifies that a webhook really came from Plaid.
 *
 * Without this the endpoint is an open invitation: anyone who guesses the URL
 * could name an item_id and make us sync it repeatedly. Plaid signs each
 * delivery with an ES256 JWT whose payload carries a SHA-256 of the body, so
 * both origin and contents are checked.
 *
 * The verification key is fetched per key id. Plaid rotates them, so this is
 * looked up rather than configured, and cached for the life of the isolate
 * because a key does not change between two webhooks a second apart.
 */
const verifyKeys = new Map<string, JsonWebKey>();

async function verificationKey(env: Env, keyId: string): Promise<JsonWebKey> {
  const cached = verifyKeys.get(keyId);
  if (cached) return cached;
  const res = await plaidPost<{ key: JsonWebKey }>(env, "/webhook_verification_key/get", {
    key_id: keyId,
  });
  verifyKeys.set(keyId, res.key);
  return res.key;
}

const b64urlToBytes = (s: string) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export async function verifyWebhook(
  env: Env,
  jwtHeader: string | undefined,
  rawBody: string,
): Promise<boolean> {
  if (!jwtHeader) return false;
  const parts = jwtHeader.split(".");
  if (parts.length !== 3) return false;

  let header: { alg?: string; kid?: string };
  let claims: { iat?: number; request_body_sha256?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return false;
  }

  // Only ES256. Accepting whatever the token names would let a caller pick
  // "none" and sign nothing at all.
  if (header.alg !== "ES256" || !header.kid) return false;

  // Replay window. Plaid's own guidance is five minutes.
  if (!claims.iat || Math.abs(Date.now() / 1000 - claims.iat) > 5 * 60) return false;

  let key: JsonWebKey;
  try {
    key = await verificationKey(env, header.kid);
  } catch {
    return false;
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    b64urlToBytes(parts[2]),
    signed,
  );
  if (!ok) return false;

  // The signature covers the claims, and the claims commit to the body — so
  // this is what stops a valid token being replayed over different contents.
  return claims.request_body_sha256 === (await sha256Hex(rawBody));
}

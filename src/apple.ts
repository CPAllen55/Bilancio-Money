/**
 * Asking Apple who has paid.
 *
 * ── Why nothing here verifies a signature ───────────────────────────────────
 *
 * StoreKit hands the app a JWS, and the obvious thing to do with it is check
 * the signature: ES256, public key from the leaf certificate in the `x5c`
 * header, chain walked up to Apple's Root CA G3, validity windows checked at
 * every hop. That is a real amount of cryptography, it is the code that
 * decides who has paid, and it is the kind of code that is wrong in a way
 * nobody notices until somebody has already got in for free.
 *
 * So it is not written. Instead, every payload this module believes came back
 * from `api.storekit.itunes.apple.com` over TLS, in answer to a request signed
 * with our own App Store Connect key. The certificate that authenticates that
 * connection is checked by the runtime, by code that is maintained by people
 * who do nothing else. That is a better chain of trust than one written here,
 * and it is the whole argument for this approach.
 *
 * The consequence is the rule that shapes the rest of this file: **a payload
 * that arrived from a phone is a pointer, never evidence.** It is read only far
 * enough to get an identifier out of it, and then that identifier is put to
 * Apple. If a phone lies about it, the worst it can do is ask a question.
 *
 * ── Which identifier ────────────────────────────────────────────────────────
 *
 * `originalTransactionId`: the one id that survives every renewal, upgrade,
 * restore and change of device. The per-transaction id changes monthly and is
 * no use for finding somebody again.
 *
 * ── Everything is optional ──────────────────────────────────────────────────
 *
 * Every binding below may be unset, which is what an environment looks like
 * until in-app purchase is deliberately switched on. Unset, `configured()` is
 * false and the route answers 503 rather than half-working.
 */

/** Something went wrong talking to Apple, said in a way a route can answer with. */
export class AppleError extends Error {
  constructor(message: string, readonly status: number = 502) {
    super(message);
    this.name = "AppleError";
  }
}

/** Whether there is enough here to ask Apple anything at all. */
export function configured(env: Env): boolean {
  return !!(env.APPLE_ISSUER_ID && env.APPLE_KEY_ID &&
            env.APPLE_PRIVATE_KEY && env.APPLE_BUNDLE_ID);
}

/* Production first, sandbox second, always in that order.
 *
 * There is no field on a transaction that can be trusted to say which one it
 * came from -- the `environment` field is inside the very payload we have
 * decided not to trust -- and Apple's own advice is to try production and fall
 * back on a 404. A sandbox transaction is unknown in production and vice
 * versa, so the answer is unambiguous either way, and a TestFlight build
 * (which buys in sandbox) works without being told. */
const HOSTS = [
  "https://api.storekit.itunes.apple.com",
  "https://api.storekit-sandbox.itunes.apple.com",
] as const;

/* ------------------------------------------------------------ base64url -- */

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const utf8 = new TextEncoder();

/* ---------------------------------------------------------------- payloads -- */

/**
 * The fields of a signed transaction this app has any use for.
 *
 * Apple sends a good deal more. Naming only what is read keeps it obvious
 * which parts of the payload actually decide anything.
 */
export interface AppleTransaction {
  bundleId?: string;
  productId?: string;
  originalTransactionId?: string;
  transactionId?: string;
  /** "Auto-Renewable Subscription" for the two products this app sells. */
  type?: string;
  /** Milliseconds. Absent on a non-renewing product. */
  expiresDate?: number;
  /** Set when Apple has refunded or otherwise pulled the purchase. */
  revocationDate?: number;
  /**
   * The UUID the app attached at purchase, which is our `users.id`.
   *
   * This is the field that makes the whole scheme safe. Without it, anybody
   * who knew somebody else's original transaction id could claim their
   * subscription; with it, Apple itself says which account bought this, and a
   * claim from any other account is refused. Absent on a purchase made before
   * the app started sending one, which is why it is optional and why there is
   * a fallback for that case in the route.
   */
  appAccountToken?: string;
  environment?: string;
}

/**
 * Read a JWS payload WITHOUT checking the signature.
 *
 * Deliberate, and safe only because of what the caller does with the result:
 * it is used as an identifier to ask Apple about, and for nothing else. See
 * the note at the top of this file. Nothing that decides entitlement may be
 * read through this function.
 */
export function peek<T = AppleTransaction>(jws: string): T | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  /* A bound on input from outside. A real payload is well under a kilobyte
     and the only reason to send a megabyte of base64 is to see what happens. */
  if (parts[1].length > 16_384) return null;
  try {
    const json = new TextDecoder().decode(fromBase64Url(parts[1]));
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value as T : null;
  } catch {
    return null;
  }
}

/**
 * The outside of an App Store Server Notification V2.
 *
 * Read for one reason only: to find a transaction id to ask Apple about. See
 * the note on the notifications route about why that makes an unverified
 * notification harmless.
 */
export interface AppleNotification {
  notificationType?: string;
  subtype?: string;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

/* --------------------------------------------------------------------- jwt -- */

/** The signing key, imported from the .p8 as stored. */
async function signingKey(env: Env): Promise<CryptoKey> {
  const pem = (env.APPLE_PRIVATE_KEY ?? "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    /* Whitespace, in every form a secret can pick up on its way into a
       dashboard: real newlines, the literal two characters backslash-n that a
       shell leaves behind, tabs and stray spaces. */
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  if (!pem) throw new AppleError("No Apple private key configured.", 503);

  let der: Uint8Array;
  try { der = fromBase64Url(pem.replace(/\+/g, "-").replace(/\//g, "_")); }
  catch { throw new AppleError("The Apple private key is not readable.", 503); }

  try {
    return await crypto.subtle.importKey(
      "pkcs8", der as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
  } catch {
    /* Almost always the wrong kind of key: an App Store Connect API key rather
       than an In-App Purchase key, or a .cer pasted where the .p8 goes. */
    throw new AppleError(
      "The Apple private key is not a P-256 key in PKCS#8 form.", 503,
    );
  }
}

/**
 * A bearer token for the App Store Server API.
 *
 * Short-lived on purpose. Apple allows up to an hour; twenty minutes is long
 * enough that clock skew is irrelevant and short enough that one leaking out
 * of a log is not much of a key.
 *
 * `bid` is required by this API and is not decoration — it scopes the token to
 * one app.
 */
async function bearer(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" };
  const claims = {
    iss: env.APPLE_ISSUER_ID,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1",
    bid: env.APPLE_BUNDLE_ID,
  };
  const signed = `${toBase64Url(utf8.encode(JSON.stringify(header)))}.` +
                 `${toBase64Url(utf8.encode(JSON.stringify(claims)))}`;

  /* WebCrypto returns ECDSA as raw r||s, which is exactly what JWS wants --
     no DER unwrapping, which is the step this would otherwise get wrong. */
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(env),
    utf8.encode(signed) as BufferSource,
  ));
  return `${signed}.${toBase64Url(sig)}`;
}

/* ---------------------------------------------------------------- the call -- */

/** What Apple currently says about one subscription. */
export interface AppleSubscription {
  /** The transaction as Apple has it, not as the phone described it. */
  transaction: AppleTransaction;
  /** 1 active · 2 expired · 3 billing retry · 4 grace period · 5 revoked. */
  status: number;
  /** Which of Apple's two worlds this came from, for the log. */
  environment: "production" | "sandbox";
}

/* Statuses that mean "let them in".
 *
 * 3 and 4 are a payment that has failed and is being retried, and the grace
 * period Apple grants while it does. Both are somebody whose card expired over
 * a weekend, and both keep access, for the same reason `past_due` counts as
 * paid on the Stripe side: a failed payment is not a cancellation, and cutting
 * access on the first one punishes the wrong people at the wrong moment. */
const PAID_STATUSES = new Set([1, 3, 4]);

export function isPaid(status: number): boolean {
  return PAID_STATUSES.has(status);
}

/**
 * Ask Apple about one subscription, by any transaction id belonging to it.
 *
 * Returns null when Apple has never heard of the id in either environment,
 * which is what a made-up id looks like and is not an error worth logging as
 * one.
 */
export async function subscriptionStatus(
  env: Env, transactionId: string,
): Promise<AppleSubscription | null> {
  if (!configured(env)) throw new AppleError("Apple billing is not configured.", 503);
  /* Apple's ids are digits. Checked because this value goes into a URL and
     arrived, one step back, from a phone. */
  if (!/^[0-9]{1,32}$/.test(transactionId)) return null;

  const token = await bearer(env);
  /* Hosts that would not talk to us at all, as opposed to hosts that talked
     and had never heard of the id. See the note where this is read. */
  let rejected = 0;

  for (const host of HOSTS) {
    const url = `${host}/inApps/v1/subscriptions/${transactionId}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new AppleError(`Could not reach Apple: ${(err as Error).message}`);
    }

    // Unknown here; try the other environment before giving up.
    if (res.status === 404) continue;

    if (res.status === 401) {
      /* Counted and carried on, not thrown.
       *
       * A 401 from one host is not necessarily anything to do with the key.
       * An account whose Paid Applications Agreement has not gone Active is
       * refused by production and served by sandbox, using the very same
       * credentials -- so throwing here made every sandbox purchase fail with
       * a 502 for a reason that had nothing to do with it. Which is exactly
       * the state this app is in while its agreement clears.
       *
       * The signal is not lost, only deferred: if every host refuses, the
       * credentials really are wrong, and that is raised below. */
      rejected++;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppleError(
        `Apple answered ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }

    const body = await res.json() as {
      environment?: string;
      data?: { lastTransactions?: {
        originalTransactionId?: string;
        status?: number;
        signedTransactionInfo?: string;
      }[] }[];
    };

    /* One entry per subscription group, each listing the last transaction per
       subscription in it. This app sells one group with two products in it, so
       in practice there is one -- but it is flattened rather than assumed,
       because "there is only one" is the kind of thing that stops being true
       the week a second product is added. */
    const all = (body.data ?? []).flatMap((g) => g.lastTransactions ?? []);
    /* The most recently expiring wins. A person who switched from monthly to
       yearly can briefly have both listed, and the one that matters is the one
       that runs out last. */
    let best: AppleSubscription | null = null;
    for (const entry of all) {
      if (!entry.signedTransactionInfo || typeof entry.status !== "number") continue;
      /* Read with `peek` -- but this payload came from Apple over TLS, not
         from a phone, which is the whole difference. */
      const transaction = peek(entry.signedTransactionInfo);
      if (!transaction) continue;
      const candidate: AppleSubscription = {
        transaction, status: entry.status,
        environment: host === HOSTS[0] ? "production" : "sandbox",
      };
      if (!best || (transaction.expiresDate ?? 0) > (best.transaction.expiresDate ?? 0)) {
        best = candidate;
      }
    }
    if (best) return best;
    // Apple knows the id but told us nothing usable about it.
    return null;
  }

  /* Nobody would talk to us. Now it is the key -- one host refusing can be an
     account restriction, but both refusing is the three values not matching
     each other. /api/admin/apple-check says which. */
  if (rejected === HOSTS.length) {
    throw new AppleError("Apple rejected our credentials.", 502);
  }

  return null;
}

/* ------------------------------------------------------------- self-test -- */

/** What is wrong with the Apple setup, said without saying the one secret. */
export interface AppleCheck {
  /** Which bindings are present. */
  present: Record<string, boolean>;
  /* The two identifiers, printed.
   *
   * Deliberate, and a narrower rule than "never print a value". A key id and a
   * bundle id are not credentials -- Apple prints the key id in the filename
   * it hands you and shows it in its own UI, and the bundle id is in the
   * binary and on the App Store. Neither signs anything. The private key is
   * the secret, and it is not here.
   *
   * Printed because the likeliest failure is a key id that does not match the
   * key, and comparing two strings by eye takes seconds where guessing takes
   * an evening. */
  keyId: string | null;
  bundleId: string | null;
  /** Whether the issuer id is even shaped like the UUID Apple issues. */
  issuerLooksRight: boolean;
  /** Whether the .p8 imports as a P-256 key in PKCS#8 form. */
  keyReadable: boolean;
  /* What each of Apple's two worlds made of the token. "accepted" means Apple
     read it, checked it, and answered about the id -- which is all we need to
     know. Both are probed rather than stopping at the first refusal, because
     which ones refuse is the thing that separates a wrong key id from an
     account that cannot use the API yet. */
  production: string;
  sandbox: string;
  appleAccepts: boolean | null;
  says: string;
}

/** One host's verdict on our token, from the status code alone. */
async function probe(host: string, token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${host}/inApps/v1/subscriptions/1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return `unreachable: ${(err as Error).message}`;
  }
  // 404 is the expected answer: the token was read and the id does not exist.
  if (res.status === 404 || res.ok) return "accepted";
  if (res.status === 401) return "rejected";
  const body = await res.text().catch(() => "");
  return `http ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

/**
 * Ask Apple a question we know the answer to, in both of its worlds.
 *
 * The transaction id is deliberately not a real one, so the interesting part
 * is not the answer but which failure comes back, and from where. Nothing is
 * written and nothing is charged.
 */
export async function selfTest(env: Env): Promise<AppleCheck> {
  const present = {
    APPLE_ISSUER_ID: !!env.APPLE_ISSUER_ID,
    APPLE_KEY_ID: !!env.APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: !!env.APPLE_PRIVATE_KEY,
    APPLE_BUNDLE_ID: !!env.APPLE_BUNDLE_ID,
  };
  const keyId = env.APPLE_KEY_ID ?? null;
  const bundleId = env.APPLE_BUNDLE_ID ?? null;
  const issuerLooksRight = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(env.APPLE_ISSUER_ID ?? "");

  const base = {
    present, keyId, bundleId, issuerLooksRight,
    keyReadable: false, production: "not tried", sandbox: "not tried",
    appleAccepts: null as boolean | null,
  };

  const missing = Object.entries(present).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { ...base, says: `Not set yet: ${missing.join(", ")}. All four are needed together.` };
  }
  if (!issuerLooksRight) {
    return { ...base, says:
      "APPLE_ISSUER_ID is not a UUID. It should look like " +
      "69a6de70-....-....-....-............ and is shown above the key list " +
      "on Users and Access, Integrations, In-App Purchase." };
  }

  let token: string;
  try {
    await signingKey(env);
    token = await bearer(env);
  } catch (err) {
    return { ...base, says: err instanceof AppleError ? err.message
      : "The Apple private key could not be read." };
  }

  const [production, sandbox] = await Promise.all([
    probe(HOSTS[0], token), probe(HOSTS[1], token),
  ]);
  const result = { ...base, keyReadable: true, production, sandbox };
  const good = production === "accepted" || sandbox === "accepted";

  if (production === "accepted" && sandbox === "accepted") {
    return { ...result, appleAccepts: true,
      says: "Apple accepted the key in both environments. This is set up correctly." };
  }
  if (good) {
    /* One world and not the other. The credentials are therefore right --
       they are the same credentials -- and what differs is what the app is
       allowed to do.

       The usual reason is that the app is not on the App Store yet. Apple does
       not open the production API to an app until it has a release there
       ("Until you have a release in production, access to the production APIs
       is not allowed" -- App Store Commerce Engineer, Apple Developer Forums
       thread 806452). A Paid Applications Agreement that has not gone Active
       looks exactly the same, which is why this used to name that instead:
       it was the cause the first time and was not the second. */
    return { ...result, appleAccepts: true, says:
      `Apple accepted the key in ${production === "accepted" ? "production" : "sandbox"} ` +
      `and not the other, so the key itself is right. Before the app has a ` +
      `release on the App Store this is expected: Apple keeps the production ` +
      `API closed until then, and purchases are checked against sandbox, ` +
      `which is what App Review uses. Run this again once the app is live -- ` +
      `production should then say accepted. If it still does not, check that ` +
      `the Paid Applications Agreement is Active.` };
  }
  if (production === "rejected" && sandbox === "rejected") {
    return { ...result, appleAccepts: false, says:
      `Apple rejected the key in both environments, so this is the three ` +
      `values not matching each other. Check, in this order: (1) APPLE_KEY_ID ` +
      `is "${keyId}" here -- it must be the ten characters in the .p8's own ` +
      `filename, SubscriptionKey_XXXXXXXXXX.p8; (2) APPLE_ISSUER_ID was taken ` +
      `from the In-App Purchase section, which shows its own, not the App ` +
      `Store Connect API one; (3) the secret was edited but not redeployed, ` +
      `so the Worker still holds the old value. A key generated in the last ` +
      `few minutes can also need time to propagate.` };
  }
  return { ...result, appleAccepts: null, says:
    `Could not finish the check. Production said "${production}", sandbox ` +
    `said "${sandbox}".` };
}

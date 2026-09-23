/**
 * Bindings that are not in the generated types.
 *
 * worker-configuration.d.ts is written by `wrangler types` from wrangler.jsonc
 * and .dev.vars, so anything set only as a deployed secret is missing from it
 * and would be a type error to read. Declared here instead of hand-editing a
 * generated file, which the next `wrangler types` would silently undo.
 */

declare global {
  interface Env {
    /**
     * Verifies Clerk session tokens and reads the user behind them.
     * `wrangler secret put CLERK_SECRET_KEY`.
     */
    CLERK_SECRET_KEY: string;

    /**
     * Wraps every stored Plaid access token. Losing it means every user
     * re-links every bank, so it is backed up somewhere outside Cloudflare.
     */
    TOKEN_ENCRYPTION_KEY: string;

    /** Plaid API credentials. Must both belong to the same PLAID_ENV. */
    PLAID_CLIENT_ID: string;
    PLAID_SECRET: string;

    /**
     * The one Clerk user id allowed to reach /api/admin/*.
     *
     * Optional on purpose. Unset — which is what every environment looks like
     * until it is deliberately set — every admin route answers 404, so a
     * missing value fails closed rather than open.
     *
     * A Clerk user id, not an email: an email can be changed from inside
     * Clerk's own account settings, and an admin check that a user can edit is
     * not an admin check. Not a column on `users` either, for the same reason
     * one step further out — a flag in the database is reachable from anything
     * that can write to the database, whereas this can only be changed by
     * somebody who can already deploy.
     */
    ADMIN_CLERK_USER_ID?: string;

    /* ── Stripe, for subscriptions bought on the web ─────────────────────
     *
     * All optional. Unset -- which is every environment until billing is
     * deliberately switched on -- /api/billing/checkout answers 503 and the
     * page does not offer to sell anything, rather than half-working.
     *
     * The iOS app never reaches any of this: App Store guideline 3.1.1
     * requires in-app purchase for anything bought inside the app.
     */
    STRIPE_SECRET_KEY?: string;
    /* The endpoint secret, which is NOT the API key. One per webhook
       endpoint, so dev and production have different ones, and a webhook
       verified against the wrong one fails closed. */
    STRIPE_WEBHOOK_SECRET?: string;
    /* Price ids from the Stripe dashboard -- price_..., not product_... */
    STRIPE_PRICE_MONTHLY?: string;
    STRIPE_PRICE_YEARLY?: string;

    /* ── Apple, for subscriptions bought in the iOS app ──────────────────
     *
     * Also all optional, and all four needed together -- with any of them
     * missing, /api/billing/apple answers 503 and the app shows nothing to
     * buy. Used to sign requests to the App Store Server API, which is asked
     * who has paid rather than trusting a payload from a phone. See apple.ts.
     *
     * The key is an **In-App Purchase** key, from Users and Access →
     * Integrations → In-App Purchase, NOT an App Store Connect API key. They
     * look identical, they both download as a .p8, and the wrong one answers
     * 401 to everything. The issuer id is the one shown on that same page.
     */
    APPLE_ISSUER_ID?: string;
    /** The 10-character Key ID, shown next to the key it belongs to. */
    APPLE_KEY_ID?: string;
    /** The .p8 file's contents, whole, BEGIN and END lines included. */
    APPLE_PRIVATE_KEY?: string;
    /** com.bilanciomoney.Bilancio. Not a secret; it scopes the token. */
    APPLE_BUNDLE_ID?: string;

    /* ── Google Play, for subscriptions bought in the Android app ────────
     *
     * The whole JSON key file of a Google Cloud service account that has been
     * invited into Play Console with the "View financial data" and "Manage
     * orders and subscriptions" permissions. Secret. Unset, /api/billing/google
     * answers 503 and the Android app shows nothing to buy. See google.ts.
     */
    GOOGLE_PLAY_SERVICE_ACCOUNT?: string;

    /* ── Firebase, for notifications to Android phones ───────────────────
     *
     * The whole JSON key file of the Firebase project's service account, with
     * the Firebase Cloud Messaging API enabled. Secret, and a different
     * account from the Play one above -- one sends notifications, the other
     * reads purchases. Unset, Android phones are simply not sent to. See
     * fcm.ts.
     */
    FCM_SERVICE_ACCOUNT?: string;

    /* ── Telling the operator about a sign-up ────────────────────────────
     *
     * Cloudflare's email binding, and the address it may write to. Both are
     * needed together; without them the quarter-hourly job does nothing. The
     * address must be verified as a destination in Email Routing -- Cloudflare
     * will not deliver anywhere else, which is what stops a Worker being a
     * spam cannon. See signup-alerts.ts.
     */
    NOTIFY_EMAIL?: { send(message: unknown): Promise<void> };
    NOTIFY_EMAIL_TO?: string;

    /* ── APNs, for budget alerts ─────────────────────────────────────────
     *
     * An APNs key: Certificates, Identifiers & Profiles → Keys → Apple Push
     * Notifications service. Neither the In-App Purchase key above nor an App
     * Store Connect API key -- a third kind, which downloads as
     * AuthKey_XXXXXXXXXX.p8. Both optional; unset, nothing is sent and the app
     * shows alerts as not yet available. The team id is a plain var in
     * wrangler.jsonc, because it is not a secret.
     */
    APNS_KEY_ID?: string;
    /** The .p8 contents, whole, BEGIN and END lines included. */
    APNS_PRIVATE_KEY?: string;
  }
}

export {};

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
  }
}

export {};

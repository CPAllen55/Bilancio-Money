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
  }
}

export {};

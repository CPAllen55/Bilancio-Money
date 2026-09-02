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

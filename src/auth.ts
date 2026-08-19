/**
 * Clerk -> Postgres bridge.
 *
 * Everything authenticated goes through requireUser(). It returns the LOCAL
 * user row, not the Clerk ID, because the local `id` is what every other table
 * hangs off. Routes filter by `user.id` and never by anything the client sent.
 */

import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context } from "hono";
import { users } from "./db/schema";
import type { getDb } from "./db/client";

type Db = ReturnType<typeof getDb>["db"];
export type LocalUser = typeof users.$inferSelect;

/**
 * Why a request was refused. Coarse on purpose: enough for the caller to know
 * whether to retry or re-authenticate, never enough to probe the instance.
 * The underlying error goes to the log, where only we can read it.
 */
export type AuthFailure =
  | "no_bearer_token"
  | "token_rejected"
  | "clerk_lookup_failed"
  | "no_email_on_clerk_user";

export type AuthResult =
  | { ok: true; user: LocalUser }
  | { ok: false; reason: AuthFailure };

/**
 * Verifies the session and returns the local user row, creating it on first
 * login.
 *
 * The email lives on Clerk, not in the session token - tokens carry `sub` and
 * little else - so first contact costs one Backend API call.
 */
export async function requireUser(
  c: Context<{ Bindings: Env }>,
  db: Db,
): Promise<AuthResult> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return { ok: false, reason: "no_bearer_token" };

  let clerkUserId: string;
  try {
    const claims = await verifyToken(header.slice(7), {
      secretKey: c.env.CLERK_SECRET_KEY,
    });
    clerkUserId = claims.sub;
  } catch (err) {
    // Expired, malformed, or signed by a different instance than the secret
    // key belongs to. Indistinguishable to the caller, but not to the log -
    // and a key mismatch looks identical to an expired token without it.
    console.error("verifyToken failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "token_rejected" };
  }

  let clerkUser;
  try {
    const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
    clerkUser = await clerk.users.getUser(clerkUserId);
  } catch (err) {
    console.error("Clerk getUser failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "clerk_lookup_failed" };
  }

  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
      ?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;

  // users.email is NOT NULL, so a Clerk account with no email cannot be mirrored.
  if (!email) return { ok: false, reason: "no_email_on_clerk_user" };

  const [user] = await db
    .insert(users)
    .values({ clerkUserId, email })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { email } })
    .returning();

  return { ok: true, user };
}

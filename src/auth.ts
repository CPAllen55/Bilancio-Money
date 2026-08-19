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

/** Reads the bearer token and returns the Clerk user ID, or null. */
async function verifySession(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;

  try {
    const claims = await verifyToken(header.slice(7), {
      secretKey: c.env.CLERK_SECRET_KEY,
    });
    return claims.sub;
  } catch {
    // Expired, malformed, or signed by a different instance. All the same to us.
    return null;
  }
}

/**
 * Verifies the session and returns the local user row, creating it on first
 * login. Returns null if the caller is not authenticated.
 *
 * The email lives on Clerk, not in the session token - tokens carry `sub` and
 * little else - so first contact costs one Backend API call.
 */
export async function requireUser(
  c: Context<{ Bindings: Env }>,
  db: Db,
): Promise<LocalUser | null> {
  const clerkUserId = await verifySession(c);
  if (!clerkUserId) return null;

  const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
  const clerkUser = await clerk.users.getUser(clerkUserId);

  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
      ?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;

  // users.email is NOT NULL, so a Clerk account with no email cannot be mirrored.
  if (!email) return null;

  const [user] = await db
    .insert(users)
    .values({ clerkUserId, email })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { email } })
    .returning();

  return user;
}

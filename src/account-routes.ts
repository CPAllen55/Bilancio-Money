/**
 * DELETE /api/account — the user erasing themselves.
 *
 * Separate from the Plaid routes because it is not a Plaid operation, even
 * though it has to talk to Plaid on the way through. It is the other half of
 * the promise the privacy policy makes, and both app stores require it before
 * they will list an app that lets people sign up.
 *
 * Deliberately not a soft delete. `users.deletedAt` exists for suspending an
 * account; "delete my account" means the transactions are gone, and a row
 * quietly retained with a timestamp on it would not be that.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createClerkClient } from "@clerk/backend";
import { getDb } from "./db/client";
import { items, users } from "./db/schema";
import { requireUser } from "./auth";
import { openToken } from "./crypto";
import { cancelSubscription } from "./stripe";
import { cancel as cancelGoogle, configured as googleConfigured } from "./google";
import { removeItem } from "./plaid";
import { plaidFailure } from "./plaid-routes";

const account = new Hono<{ Bindings: Env }>();

account.delete("/account", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    // Every bank is revoked at Plaid before anything local is touched. Deleting
    // our rows first would destroy the only tokens that can revoke them, and
    // the connections would stay live at Plaid with nothing left to close them.
    // If one fails, nothing is deleted and the user is told — better than a
    // cheerful confirmation that their banks are disconnected when they are not.
    /* A website subscription is cancelled first, before anything else is
       touched: an account that no longer exists must not go on being charged,
       and once the row is gone nothing remembers which subscription to stop.
       If Stripe cannot be reached nothing is deleted and the person is told.

       An App Store subscription cannot be cancelled from here -- Apple allows
       only the subscriber to do that -- so the answer says it is still live. */
    if (auth.user.stripeSubscriptionId && c.env.STRIPE_SECRET_KEY) {
      try {
        await cancelSubscription(c.env, auth.user.stripeSubscriptionId);
      } catch (err) {
        console.error("stripe cancel failed during account delete", err);
        return c.json({
          error: "stripe",
          reason: "Your subscription could not be cancelled, so nothing was deleted. Try again in a moment.",
        }, 502);
      }
    }
    /* A Google Play subscription, unlike Apple's, can be cancelled by the
       developer, and is -- for the same reason as Stripe's, and with the same
       refusal to carry on if it cannot be. */
    if (auth.user.googlePurchaseToken && googleConfigured(c.env)) {
      try {
        await cancelGoogle(c.env, auth.user.googlePurchaseToken);
      } catch (err) {
        console.error("google cancel failed during account delete", err);
        return c.json({
          error: "google",
          reason: "Your Google Play subscription could not be cancelled, so nothing was deleted. Try again in a moment.",
        }, 502);
      }
    }
    const appleStillActive = auth.user.billingSource === "apple" && auth.user.plan === "active";

    const mine = await db.select().from(items).where(eq(items.userId, auth.user.id));
    for (const item of mine) {
      if (item.closedAt) continue;   // closed at Plaid already, when access ended
      try {
        await removeItem(c.env, await openToken(c.env, item.accessTokenCiphertext, item.accessTokenIv));
      } catch (err) {
        return c.json(plaidFailure(err), 502);
      }
    }

    // Cascades from the user row: items, accounts, transactions, overrides,
    // merchant rules, and any categories they made themselves.
    await db.delete(users).where(eq(users.id, auth.user.id));

    // Last, and survivable if it fails. The financial data is already gone,
    // which is the part that matters; a stranded Clerk identity is a login to
    // an account that no longer exists. Logged so it can be cleaned up.
    try {
      const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
      await clerk.users.deleteUser(auth.user.clerkUserId);
    } catch (err) {
      console.error("clerk user delete failed after local delete", err);
    }

    return c.json({ ok: true, banksRevoked: mine.length, appleStillActive });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default account;

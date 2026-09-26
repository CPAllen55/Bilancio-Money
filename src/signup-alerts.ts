/**
 * Telling the operator when somebody signs up.
 *
 * ── Why a digest, and why a column ──────────────────────────────────────────
 *
 * A quarter-hourly digest rather than a mail per sign-up: close enough to
 * immediate to be useful, and a good afternoon does not fill an inbox. The
 * column on `users` is what makes it exactly-once — a job that worked out who
 * is new by comparing timestamps to its own schedule sends twice whenever a run
 * is retried, and sends nothing at all if one is missed.
 *
 * ── What is said ────────────────────────────────────────────────────────────
 *
 * Who signed up, when, and how many accounts there are now. Nothing about
 * anybody's money: this is an operational notice, and a mailbox is not a place
 * to keep financial data.
 *
 * ── Sending ─────────────────────────────────────────────────────────────────
 *
 * Cloudflare's own email binding: no third party, no API key, and nothing new
 * in the privacy policy's list of who touches data. It will only deliver to an
 * address verified as a destination in Email Routing, which is the whole of its
 * abuse protection and the reason NOTIFY_EMAIL is a binding rather than a
 * setting. Unbound -- which is every environment that has not asked for this --
 * nothing is sent and nothing fails.
 */

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { EmailMessage } from "cloudflare:email";
import { getDb } from "./db/client";
import { users } from "./db/schema";

/** Where the mail comes from. The domain is this account's; the box is not. */
const FROM = "alerts@bilanciomoney.com";

/* Accounts older than this that have never been announced are marked without
   being sent -- everybody who existed before this job did. Otherwise the first
   run mails the entire user table. */
const BACKFILL_HOURS = 24;

/** At most this many in one mail, so a strange day cannot send a novel. */
const BATCH = 50;

function escapeHeader(s: string): string {
  return s.replace(/[\r\n]/g, " ").slice(0, 200);
}

function mime(to: string, subject: string, body: string): string {
  /* Assembled by hand: one plain-text part, which needs no library and no
     boundary. CRLF line endings, because SMTP counts them. */
  return [
    `From: Bilancio <${FROM}>`,
    `To: <${to}>`,
    `Subject: ${escapeHeader(subject)}`,
    `Message-ID: <${crypto.randomUUID()}@bilanciomoney.com>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  ].join("\r\n");
}

/**
 * Announces whoever has signed up since the last run. Safe to call as often as
 * you like: an account is announced once, and nothing is sent when nobody is
 * new.
 */
export async function announceSignups(env: Env): Promise<{ sent: number }> {
  const to = env.NOTIFY_EMAIL_TO;
  if (!env.NOTIFY_EMAIL || !to) return { sent: 0 };

  const { db, ready, close } = getDb(env);
  try {
    await ready;

    const cutoff = new Date(Date.now() - BACKFILL_HOURS * 60 * 60 * 1000);

    /* Everybody who was already here when this job arrived: marked, not
       mailed. One statement, so a second worker doing the same thing at the
       same moment cannot double-send. */
    await db.update(users)
      .set({ signupNotifiedAt: new Date() })
      .where(and(isNull(users.signupNotifiedAt), sql`${users.createdAt} <= ${cutoff}`));

    const fresh = await db.select({
      id: users.id, email: users.email, createdAt: users.createdAt, plan: users.plan,
    })
      .from(users)
      .where(and(isNull(users.signupNotifiedAt), gt(users.createdAt, cutoff)))
      .orderBy(asc(users.createdAt))
      .limit(BATCH);

    if (!fresh.length) return { sent: 0 };

    /* Claimed before the mail is sent, not after. A send that fails is one
       missed notice; a claim that fails is the same notice every quarter of an
       hour until somebody notices. */
    for (const row of fresh) {
      await db.update(users).set({ signupNotifiedAt: new Date() }).where(eq(users.id, row.id));
    }

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(isNull(users.deletedAt));

    const when = (d: Date) =>
      d.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

    const lines = fresh.map((r) => `  ${r.email}\n    signed up ${when(r.createdAt)} (Central)`);
    const subject = fresh.length === 1
      ? `Bilancio: ${fresh[0].email} signed up`
      : `Bilancio: ${fresh.length} new sign-ups`;
    const body = [
      fresh.length === 1 ? "A new account:" : `${fresh.length} new accounts:`,
      "",
      ...lines,
      "",
      `${total} people have signed up in total.`,
      "",
      "-- ",
      "Sent by Bilancio's own Worker. Nothing about anybody's money is in this mail.",
    ].join("\n");

    await env.NOTIFY_EMAIL.send(new EmailMessage(FROM, to, mime(to, subject, body)));
    console.log(`signup notice sent for ${fresh.length}`);
    return { sent: fresh.length };
  } finally {
    await close().catch(() => {});
  }
}

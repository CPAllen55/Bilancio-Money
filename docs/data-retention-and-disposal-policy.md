# Data Retention and Disposal Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
**Version 1.1 — 16 September 2026**

Companion to [SECURITY.md](../SECURITY.md) and the
[Access Control Policy](./access-control-policy.md). Where they differ, this
document governs retention and disposal.

Reviewed **annually**, and whenever the data model changes. This file is
version-controlled; its commit history is the review record.

Changes from 1.0: the waitlist is closed; subscriptions, push tokens and
payment records added; connections closed after access ends; account deletion
cancels a website subscription first; the backup window is stated.

---

## 1. Purpose and scope

To state what data is kept, for how long, what causes it to be destroyed, and
how we know it is gone.

Covers every store holding consumer data: the Neon PostgreSQL database, the
Clerk authentication tenant, data held on our behalf at Plaid, subscription
records at Stripe and Apple, and platform logs at Cloudflare.

## 2. Principles

1. **Collect only what the product needs.** No advertising identifiers, no
   analytics, no behavioural tracking, no data collected in case it is useful
   later.
2. **Keep it only while it serves the purpose it was collected for.** A budget
   derived from history needs the history; nothing needs it after the account
   is gone.
3. **Delete completely, not logically.** A deleted row is deleted, not flagged.
4. **The user decides.** Deletion is available to them at any time, from inside
   the application, without contacting us.

## 3. What we hold, and for how long

| Data | Purpose | Retained |
|---|---|---|
| Transactions, balances, account and institution names | The product itself | While the account exists |
| Plaid access tokens (encrypted) | Maintaining the bank connection | While that bank is connected; a connection closed after access ends has its token destroyed at Plaid |
| Categories, merchant rules, splits, budget settings | The user's own configuration | While the account exists |
| Precious metal holdings entered by hand | Net worth | While the account exists |
| Email address and authentication factors | Sign-in, held by Clerk | While the account exists |
| Plan, trial dates, Stripe and Apple subscription identifiers | Knowing whether the account is paid | While the account exists |
| Push tokens and chosen alert categories | Budget alerts on iPhone | Until alerts are turned off on that phone, Apple reports the token dead, or the account is deleted |
| Former waitlist email addresses | Collected before sign-up opened; no longer collected | Until removal is requested or the list is deleted |
| Request and error logs | Diagnosing faults | The platform window, currently days |
| Database restore history | Recovering from a fault | Up to 7 days |
| Card details, billing address, payment history | Taking payment | Held by Stripe or Apple, never by us, under their own obligations |

Transaction history reaches back at most **24 months**, because that is the
maximum Plaid supplies. We do not accumulate beyond what Plaid provides and we
do not retain data for users who have deleted their accounts.

## 4. What causes deletion

**The user deletes their account.** Available inside the application, on the
web or in the iPhone app, at any time. In order:

1. A subscription bought on the website is **cancelled at Stripe first**, so a
   deleted account is not charged again. If Stripe cannot be reached, nothing is
   deleted and the user is told.
2. Every open bank connection is revoked at Plaid. Deleting our records before
   revoking would destroy the only token capable of revoking them, and leave the
   connection live at Plaid with nothing able to close it.
3. Their accounts, transactions, categories, merchant rules, splits, overrides,
   budget settings, metal holdings, push tokens and alert choices are erased by
   cascade from the user row.
4. Their authentication identity is removed from Clerk.

If cancellation or revocation fails, **nothing is deleted** and the user is told.
A partial deletion that reports success is worse than a failure that reports
itself.

A subscription bought in the iPhone app cannot be cancelled by us — Apple lets
only the subscriber cancel it — so both apps tell the user to cancel it in their
Apple account.

**The user disconnects one bank.** That item, its accounts and all of its
transactions are deleted immediately by cascade — this does not wait for the
account to be closed. Categories and merchant rules survive, because they are
the user's own work rather than the bank's data, and are waiting if they
reconnect.

**A former waitlist address asks to be removed.**

## 4a. What is closed but not deleted

**Access ends.** Once billing is open, an account whose free trial or
subscription has ended becomes view-only. **Seven days later** a daily scheduled
job removes each of its bank connections at Plaid — destroying the access token
and ending the connection — and marks it closed. The accounts and transactions
under it are **kept**: the person can still see their history, and if they
subscribe again, connecting the same bank replaces the closed connection and
its copy of the data.

This is deliberate. Closing the connection stops the ongoing collection of
financial data from someone who has stopped using the service; deleting their
history without being asked would be a decision that belongs to them, and they
can make it at any time by disconnecting the bank or deleting the account.

## 5. Disposal

Disposal here is **logical deletion on managed infrastructure**, not physical
destruction. We own no servers, no disks and no removable media; there is
nothing to shred, degauss or wipe. Media sanitisation is performed by the
underlying providers under their own published programmes, and is one of the
reasons for using them.

**Deletion is immediate in the live database.** A `DELETE` removes the row; there
is no soft-delete flag, no archive table, no export bucket, and no analytics
warehouse holding a second copy.

**Backups are the honest exception.** Neon provides point-in-time recovery, so
for up to **seven days** a deleted row remains restorable from the platform's
history. It is not reachable by the application, is not queryable by us in the
ordinary course, and ages out on the provider's schedule. The published privacy
policy states this window; it must not be raised above seven days without
changing that policy first.

**Data held by third parties on our behalf** is disposed of by instructing them:
`/item/remove` at Plaid, subscription cancellation at Stripe, user deletion at
Clerk. Their own retention after that instruction — including the payment
records Stripe and Apple must keep under tax and financial law — is governed by
their agreements with us and their published policies.

## 6. Verification

Deletion is exercised by the same code path every time — one endpoint, one
order of operations — rather than by a manual runbook that could be performed
differently on different days. Closing connections after access ends is likewise
one scheduled job, logged on every run. Failures surface to the user, or to the
logs, rather than being swallowed.

## 7. Legal basis and compliance

The company is a Texas LLC serving consumers in the United States. Applicable
state privacy law includes the Texas Data Privacy and Security Act, and
comparable regimes where users reside.

The controls above are designed to meet the substance of those obligations:
deletion on request, without charge, without contacting support, and completed
in a single action. **Whether they satisfy each applicable statute in detail is
subject to an outside legal review of our published privacy policy and terms,
which has not yet been completed.** That review is recorded here as a dependency
rather than assumed to have concluded.

## 8. Known gaps

- **No automated deletion of dormant accounts.** An account nobody uses is
  retained until its owner deletes it; its bank connections are closed once
  access ends, but its history is not removed. Whether to expire dormant
  accounts is an open question rather than a decided policy.
- **The former waitlist has no outer limit.** Addresses are held until removal
  is requested; now that sign-up is open, deleting the list outright is the
  likely next step.
- **Periodic review has not yet been performed.** The cadence starts with
  version 1.0.

## 9. Requests and contact

Deletion is self-service inside the application and requires no request. For
anything else — a question about what is held, or a request under an applicable
privacy statute — **privacy@bilanciomoney.com** for privacy requests, or
**security@bilanciomoney.com** for security matters, acknowledged within three
business days.

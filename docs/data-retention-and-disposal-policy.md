# Data Retention and Disposal Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
**Version 1.0 — 24 August 2026**

Companion to [SECURITY.md](../SECURITY.md) and the
[Access Control Policy](./access-control-policy.md). Where they differ, this
document governs retention and disposal.

Reviewed **annually**, and whenever the data model changes. This file is
version-controlled; its commit history is the review record.

---

## 1. Purpose and scope

To state what data is kept, for how long, what causes it to be destroyed, and
how we know it is gone.

Covers every store holding consumer data: the Neon PostgreSQL database, the
Clerk authentication tenant, data held on our behalf at Plaid, and platform
logs at Cloudflare.

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
| Plaid access tokens (encrypted) | Maintaining the bank connection | While that bank is connected |
| Categories, merchant rules, budget settings | The user's own configuration | While the account exists |
| Email address and authentication factors | Sign-in, held by Clerk | While the account exists |
| Precious metal holdings entered by hand | Net worth | While the account exists |
| Waitlist email addresses | Inviting people in order | Until invited, or until removal is requested |
| Request and error logs | Diagnosing faults | The platform window, currently days |

Transaction history reaches back at most **24 months**, because that is the
maximum Plaid supplies. We do not accumulate beyond what Plaid provides and we
do not retain data for users who have left.

## 4. What causes deletion

**The user deletes their account.** Available inside the application at any
time. In order:

1. Every bank connection is revoked at Plaid *first*. Deleting our records
   before revoking would destroy the only token capable of revoking them, and
   leave the connection live at Plaid with nothing able to close it.
2. Their accounts, transactions, categories, merchant rules, overrides, budget
   settings and metal holdings are erased by cascade from the user row.
3. Their authentication identity is removed from Clerk.

If revocation at Plaid fails, **nothing is deleted** and the user is told. A
partial deletion that reports success is worse than a failure that reports
itself.

**The user disconnects one bank.** That item, its accounts and all of its
transactions are deleted immediately by cascade — this does not wait for the
account to be closed. Categories and merchant rules survive, because they are
the user's own work rather than the bank's data, and are waiting if they
reconnect.

**A waitlist address is invited or asks to be removed.**

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
for the length of that window a deleted row remains restorable from the
platform's history. It is not reachable by the application, is not queryable by
us in the ordinary course, and ages out on the provider's schedule. Any
statement that data is destroyed "immediately and everywhere" would be false
while point-in-time recovery exists, and it exists for good reason.

**Data held by third parties on our behalf** is disposed of by instructing them:
`/item/remove` at Plaid, user deletion at Clerk. Their own retention after that
instruction is governed by their agreements with us and their published
policies.

## 6. Verification

Deletion is exercised by the same code path every time — one endpoint, one
order of operations — rather than by a manual runbook that could be performed
differently on different days. Failures surface to the user rather than being
swallowed.

## 7. Legal basis and compliance

The company is a Texas LLC serving consumers in the United States. Applicable
state privacy law includes the Texas Data Privacy and Security Act, and
comparable regimes where users reside.

The controls above are designed to meet the substance of those obligations:
deletion on request, without charge, without contacting support, and completed
in a single action. **Whether they satisfy each applicable statute in detail is
subject to the outside legal review of our published privacy policy and terms,
which is in progress at the time of writing.** That review is recorded here as
a dependency rather than assumed to have concluded.

## 8. Known gaps

- **Point-in-time recovery window.** As above: deleted data remains restorable
  from platform history for the length of the provider's window. The exact
  duration follows the current Neon plan and should be confirmed and stated
  here explicitly at the next review.
- **No automated deletion of dormant accounts.** An account nobody uses is
  retained until its owner deletes it. Whether to expire dormant accounts is an
  open question rather than a decided policy.
- **Waitlist retention has no outer limit.** Addresses are held until invited or
  until removal is requested; there is no automatic expiry for people who are
  never invited.
- **Periodic review has not yet been performed.** The cadence starts with this
  version.

## 9. Requests and contact

Deletion is self-service inside the application and requires no request. For
anything else — a question about what is held, or a request under an applicable
privacy statute — **security@bilanciomoney.com**, acknowledged within three
business days.

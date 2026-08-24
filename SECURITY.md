# Information Security Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
Owner: the Member of the LLC, who is the accountable party for everything below.

This document states the controls that are in force today. Where something is
planned rather than in place it says so — a policy that describes intentions as
though they were controls is worse than no policy, because it cannot be relied
on by anybody, including us.

**Version 1.0 — 24 August 2026.** Reviewed at least annually, and whenever the
architecture changes materially. This file is version-controlled: its commit
history is the review record, so the claim that the policy is maintained is
checkable rather than asserted.

---

## 1. Scope and governance

Bilancio Money is a personal finance dashboard. It reads a user's bank account
balances and transaction history through Plaid, categorises that activity, and
presents it back to them. It is **read-only**: it holds no ability to move
money, initiate payments, or alter anything at a financial institution.

The company is a single-member LLC with **one person having system access**.
That is the central fact about this environment and it cuts both ways: there is
no risk of over-broad internal access, lateral movement between employees, or
offboarding failures, and equally there is no separation of duties. Controls
below are chosen accordingly — they lean on the platform and on automation
rather than on process that a single person could quietly skip.

**Security contact:** security@bilanciomoney.com — monitored, and the address to
use for vulnerability reports or security correspondence.

## 2. Architecture and data flow

| | |
|---|---|
| Application | Cloudflare Workers, one Worker serving the site and `/api/*` |
| Database | Neon PostgreSQL, TLS-only, reached through Cloudflare Hyperdrive |
| Authentication | Clerk (production instance) |
| Financial data | Plaid — Transactions product only |
| Hosting region | United States |

No part of the system is self-hosted. There are no servers to patch, no SSH
access, and no long-lived compute; Workers are ephemeral per request.

## 3. Data we hold

- Account and transaction records retrieved from Plaid, including balances,
  amounts, dates, merchant names and institution names.
- A user's email address and authentication identity, held by Clerk.
- Plaid access tokens, encrypted (§4).
- Category assignments and budget figures the user has set themselves.

We do **not** hold bank credentials at any point. Credentials are entered by the
user inside Plaid Link and are never transmitted to, seen by, or stored by
Bilancio. We do not hold card numbers, government identifiers, or date of birth.

**No analytics, advertising, or third-party tracking of any kind** is present in
the application. This is deliberate, is stated in the published privacy policy,
and adding any would make that policy false.

## 4. Encryption

**In transit.** TLS everywhere. The public site and API are served over HTTPS by
Cloudflare. The database connection is TLS-enforced by Neon. Calls to Plaid and
Clerk are HTTPS to their published endpoints.

**At rest.** Neon encrypts stored data at the platform level.

**Plaid access tokens** receive an additional layer, because a token is the one
secret in the database that would let a holder read somebody's bank data:

- **AES-256-GCM**, via the Workers runtime's own WebCrypto implementation.
- A **fresh 96-bit IV for every encryption**, never reused, stored alongside the
  ciphertext.
- GCM is authenticated, so decryption fails loudly if the ciphertext has been
  altered rather than silently returning wrong data.
- The key is held as a **Cloudflare Worker secret**. It is not in source
  control, not in any configuration file, and not recoverable from the
  repository.

No plaintext access token is ever written to the database.

## 5. Secrets management

All credentials — the Plaid secret, the Clerk secret key, the token encryption
key, and database connection strings — are stored as **Cloudflare Worker
secrets** or in local files excluded from source control (`.env`, `.dev.vars`,
both in `.gitignore`).

Nothing secret is committed. Configuration that *is* committed
(`wrangler.jsonc`) carries only values that are public by design, such as the
Clerk publishable key, with comments recording why each one is safe to publish.

Separate encryption keys are used for development and production, so a
development compromise cannot decrypt production data.

## 6. Access control

**End users** authenticate through Clerk. The production instance has **Require
multi-factor authentication enabled**, so a second factor is enforced after sign-in
and sign-up rather than offered. The available factors are an authenticator
application (TOTP), SMS one-time code, and single-use backup codes.

These are strong but **not phishing-resistant**: a convincing fake sign-in page can
capture a TOTP or SMS code and replay it within its validity window. Only
WebAuthn, passkeys or hardware keys bind a credential to the domain, and none is
in use today. This is recorded rather than glossed, and passkeys are the intended
next step.

Sign-up is **invitation-only** — Clerk access mode is set to invite-only, so there
is no open registration.

**Application access to data** is scoped per user on every query. Ownership is
proved by joining through the account and item tables to the authenticated user
rather than by trusting an identifier supplied in a request — an id belonging to
someone else matches no rows rather than returning their data.

**Administrative access** is limited to the single Member, protected by
multi-factor authentication on Cloudflare, Neon, Clerk, Plaid and GitHub.

**Database roles.** The application connects as a dedicated role created for it
rather than as the database owner. Schema migrations are run separately, from a
developer machine, against an explicitly named target — production is never the
default.

Stated precisely, because it is a real gap: that same role is used for both the
application and its migrations, so it carries DDL rights the running application
never needs. Splitting it — a read-write role for the Worker, a separate one for
migrations — is a planned change, and would mean that leaked Worker credentials
could not drop a table.

## 7. Secure development

- All changes are version-controlled in Git with a written rationale in each
  commit message.
- **Four runtime dependencies** (`@clerk/backend`, `drizzle-orm`, `hono`, `pg`).
  A deliberately small surface: every dependency is a supply-chain risk, and the
  application is written to need as few as possible.
- TypeScript with strict checking; the build fails on a type error.
- Development runs against a **separate Neon branch** and against **Plaid's
  sandbox**, so no local work can touch production data or a real bank account.
- Deployment is automated from the `main` branch; there is no manual upload path
  and no way to ship code that is not in version control.

## 8. Third parties

| Provider | Purpose | Handles |
|---|---|---|
| Plaid | Bank connectivity | Bank credentials (never seen by us), transactions |
| Clerk | Authentication | Email address, authentication factors |
| Cloudflare | Hosting, TLS, DNS, email routing | Traffic in transit |
| Neon | Database | Stored application data |

All four are established providers with published security programmes. We rely
on their platform controls for physical security, host patching, and
infrastructure hardening, which are not things a company of this size could
perform better itself.

## 9. Webhooks and input handling

Plaid webhooks are **cryptographically verified** against Plaid's published
verification key before the payload is acted upon. An unverified request is
rejected, so an attacker cannot forge instructions by posting to the endpoint.

Request bodies are validated for type and range before use. Values that reach
the database go through parameterised queries via the ORM; no SQL is assembled
by string concatenation from user input.

## 10. Data retention and deletion

Users can **delete their account from inside the application**. Deletion:

1. Revokes every bank connection at Plaid first, so no connection is left live
   with no way to reach it;
2. Erases the user's accounts, transactions, categories, rules and overrides by
   cascade;
3. Removes the authentication identity from Clerk.

This is a hard delete, not a flag. If revocation at Plaid fails, nothing is
deleted and the user is told, rather than being given a false confirmation.

## 11. Logging and monitoring

Cloudflare Workers observability is enabled, providing request logs, error
traces and metrics. Application errors are logged with enough context to
diagnose them and deliberately without financial detail or access tokens.

Neon provides database-level monitoring and point-in-time recovery within the
retention window of the current plan.

## 12. Incident response

The Member is the responder. In the event of a suspected compromise:

1. **Contain.** Rotate the affected credential — Worker secrets can be replaced
   and redeployed in minutes. If the token encryption key is implicated,
   affected Plaid items are revoked rather than re-encrypted.
2. **Assess.** Determine what data was reachable, using Cloudflare and Neon
   logs.
3. **Notify.** Affected users, and Plaid, without undue delay; and any
   regulator to the extent required by applicable law.
4. **Remediate and record.** Fix the cause, write down what happened and what
   changed.

Vulnerability reports are accepted at security@bilanciomoney.com and will be
acknowledged within three business days.

## 13. Business continuity

Source code is held in GitHub and is fully reproducible from it — the
application has no state outside the database. The database is managed by Neon
with automated backups and point-in-time recovery. No data exists solely on a
developer machine.

## 14. What is not in place

Stated plainly, because a reviewer will ask and discovering it later is worse:

- **No SOC 2, ISO 27001 or equivalent certification.** Not proportionate at
  current scale.
- **No third-party penetration test** has been performed to date.
- **No formal security awareness training programme** — with one person and no
  employees, there is nobody to train.
- **No separation of duties**, for the same reason.
- **Incident response has not been rehearsed**, only documented.

These are consequences of size rather than of neglect, and each will be revisited
as the company grows — a penetration test being the first of them once there is
a meaningful user base.

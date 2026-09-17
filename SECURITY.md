# Information Security Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
Owner: the Member of the LLC, who is the accountable party for everything below.

This document states the controls that are in force today. Where something is
planned rather than in place it says so — a policy that describes intentions as
though they were controls is worse than no policy, because it cannot be relied
on by anybody, including us.

**Version 1.1 — 16 September 2026.** Reviewed at least annually, and whenever the
architecture changes materially. This file is version-controlled: its commit
history is the review record, so the claim that the policy is maintained is
checkable rather than asserted.

Changes from 1.0: open sign-up replaces invitation-only; subscriptions through
Stripe and Apple; push notifications; the 14-day trial and the daily job that
closes bank connections after access ends; the admin page; account deletion
cancelling a website subscription; the backup window stated; and end-user MFA
corrected to what the live configuration actually enforces (§6).

---

## 1. Scope and governance

Bilancio Money is a personal finance dashboard, on the web and as a native
iPhone app. It reads a user's bank account balances and transaction history
through Plaid, categorises that activity, and presents it back to them. It is
**read-only**: it holds no ability to move money, initiate payments, or alter
anything at a financial institution.

The company is a single-member LLC with **one person having system access** —
the Member, who builds and operates both the web service and the iPhone app.
That is the central fact about this environment and it cuts both ways: there is
no risk of over-broad internal access, lateral movement between employees, or
offboarding failures, and equally there is no separation of duties. Controls
below are chosen accordingly — they lean on the platform and on automation
rather than on process that a single person could quietly skip.

**Security contact:** security@bilanciomoney.com — delivered to the Member, and
the address to use for vulnerability reports or security correspondence.

## 2. Architecture and data flow

| | |
|---|---|
| Application | Cloudflare Workers, one Worker serving the site and `/api/*`, plus a daily scheduled job |
| iPhone app | Native Swift client of the same API; holds no data of its own beyond a session |
| Database | Neon PostgreSQL (Launch plan), TLS-only, reached through Cloudflare Hyperdrive |
| Authentication | Clerk (production instance) |
| Financial data | Plaid — Transactions product only |
| Payments | Stripe on the web; Apple in-app purchase in the iPhone app |
| Notifications | Apple Push Notification service, for budget alerts a user turns on |
| Hosting region | United States |

No part of the system is self-hosted. There are no servers to patch, no SSH
access, and no long-lived compute; Workers are ephemeral per request.

## 3. Data we hold

- Account and transaction records retrieved from Plaid, including balances,
  amounts, dates, merchant names and institution names.
- A user's email address and authentication identity, held by Clerk.
- Plaid access tokens, encrypted (§4).
- Category assignments, rules, splits, budget figures and precious-metal
  holdings the user has set themselves.
- The state of the account: trial dates, plan, and the **identifiers** Stripe
  or Apple assign to a subscription. Never a card number.
- For users who turn on budget alerts: the Apple push token for that install,
  and which categories they chose.
- Email addresses from the former waitlist (sign-up is now open; no new ones
  are collected).

We do **not** hold bank credentials at any point. Credentials are entered by the
user inside Plaid Link and are never transmitted to, seen by, or stored by
Bilancio. We do not hold card numbers — those are entered with Stripe or held by
Apple — government identifiers, or date of birth.

**No analytics, advertising, or third-party tracking of any kind** is present in
the application. This is deliberate, is stated in the published privacy policy,
and adding any would make that policy false.

## 4. Encryption

**In transit.** TLS everywhere. The public site and API are served over HTTPS by
Cloudflare. The database connection is TLS-enforced by Neon. Calls to Plaid,
Clerk, Stripe and Apple are HTTPS to their published endpoints.

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
key, the Stripe API key and webhook signing secret, the App Store Connect and
Apple Push keys, and database connection strings — are stored as **Cloudflare
Worker secrets** or in local files excluded from source control (`.env`,
`.dev.vars`, both in `.gitignore`). Private keys downloaded from Apple are kept
in a password manager, not on disk in the repository.

The Stripe key is a **restricted key** limited to the five resources the
application uses (customers, checkout sessions, the customer portal,
subscriptions, and reading prices), so a leaked key cannot issue refunds, move
balances or read unrelated data.

Nothing secret is committed. Configuration that *is* committed
(`wrangler.jsonc`) carries only values that are public by design, such as the
Clerk publishable key and the Apple team id, with comments recording why each
one is safe to publish.

Separate encryption keys are used for development and production, so a
development compromise cannot decrypt production data.

## 6. Access control

**End users** authenticate through Clerk: email and password with the address
verified by an emailed code at sign-up, or Sign in with Apple or Google.
Automated sign-up is resisted by Clerk's bot protection (CAPTCHA).

**Multi-factor authentication is optional, and each user controls it.** Any
user can turn it on or off at any time — on the web under *Profile settings →
Security* — with an authenticator application (TOTP), SMS one-time codes, and
single-use backup codes. Once a user has turned it on, Clerk requires the
second factor at every sign-in for that user.

It is not required for everyone, by decision. Version 1.0 of this policy said it
was enforced; it was switched off so that Apple's App Review could sign in to
the demo account, and has been kept optional since. This version records that
state rather than the earlier one (§14).

None of the available factors is **phishing-resistant**: a convincing fake
sign-in page can capture a TOTP or SMS code and replay it within its validity
window. Only WebAuthn, passkeys or hardware keys bind a credential to the
domain, and none is in use today.

**Sign-up is open to the public.** A new account starts a 14-day free trial when
its first bank is connected, limited to two bank connections until it
subscribes.

**Application access to data** is scoped per user on every query. Ownership is
proved by joining through the account and item tables to the authenticated user
rather than by trusting an identifier supplied in a request — an id belonging to
someone else matches no rows rather than returning their data.

**Administrative access** is limited to the single Member, protected by
multi-factor authentication on Cloudflare, Neon, Clerk, Plaid, Stripe, Apple
and GitHub. Inside the application there is one **admin page**, reachable only
by the one Clerk user id held in the `ADMIN_CLERK_USER_ID` secret; every other
caller gets a 404. It shows the former waitlist and each account's email
address, plan and number of bank connections, and can change a plan. It
**cannot** read anybody's transactions, balances or budgets.

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
  Stripe, Plaid and Apple are called over plain HTTPS rather than through their
  SDKs. A deliberately small surface: every dependency is a supply-chain risk.
- TypeScript with strict checking; the build fails on a type error.
- Development runs against a **separate Neon branch** and against **Plaid's
  sandbox**, so no local work can touch production data or a real bank account.
- Deployment is automated from the `main` branch; there is no manual upload path
  and no way to ship code that is not in version control. The iPhone app is
  built on the Member's Mac and distributed only through TestFlight and the App
  Store.

## 7a. Vulnerability management

**Dependencies are scanned continuously.** GitHub Dependabot watches the four
runtime packages and opens a pull request when an advisory is published; a
scheduled job additionally runs `npm audit` weekly against unchanged code,
because a dependency does not have to change for a vulnerability in it to be
disclosed. The same job typechecks every push, so a build that would fail on
deploy fails earlier and more visibly.

**Patching targets.** Measured from the advisory becoming known to us:

| Severity | Target |
|---|---|
| Critical | 7 days |
| High | 30 days |
| Moderate and below | Next routine update |

These are achievable for four dependencies and one person, which is why they
are the numbers chosen. A target that cannot be met is not a control.

**Production assets** are serverless and managed. There are no server instances
to scan or patch: Cloudflare Workers are ephemeral per request with no
persistent host, and Neon patches the database platform. Host-level
vulnerability management is therefore the providers’, and is covered by their
own published programmes.

**Endpoint scanning** is not performed. There are two machines, both belonging to
the sole Member — a Windows PC for the web service and a Mac for the iPhone app
— kept current with operating-system updates and platform antimalware. A managed
endpoint programme is not proportionate to a single-person company and is
recorded here rather than claimed.

**End-of-life software.** The dependency surface is four packages and a managed
runtime, all currently supported. Versions are reviewed alongside the quarterly
access review.

## 8. Third parties

| Provider | Purpose | Handles |
|---|---|---|
| Plaid | Bank connectivity | Bank credentials (never seen by us), transactions |
| Clerk | Authentication | Email address, authentication factors, sign-up bot protection |
| Cloudflare | Hosting, TLS, DNS, email routing, request logs | Traffic in transit |
| Neon | Database | Stored application data |
| Stripe | Web subscriptions and sales tax | Card details and billing address (never seen by us) |
| Apple | In-app subscriptions; push notification delivery; Sign in with Apple | Payment for App Store purchases; alert text in transit |
| Google | Optional sign-in, for users who choose it | Email address and basic profile |

Google and Apple sign-in appear only for users who choose them. A user who signs
in with a password involves neither.

All of them are established providers with published security programmes. We rely
on their platform controls for physical security, host patching, and
infrastructure hardening, which are not things a company of this size could
perform better itself.

## 9. Webhooks and input handling

Every inbound call from a provider is authenticated before it is acted upon:

- **Plaid** webhooks are cryptographically verified against Plaid's published
  verification key.
- **Stripe** webhooks are verified against the endpoint's signing secret, over
  the raw request bytes, with a constant-time comparison.
- **Apple** subscription notifications are not trusted as sent. The payload is
  used only to learn which subscription changed; its current state is then
  fetched from Apple's App Store Server API over TLS, with a request signed by
  our own key, and only that answer is believed.

An unverified request is rejected, so an attacker cannot forge instructions by
posting to an endpoint.

Request bodies are validated for type and range before use. Values that reach
the database go through parameterised queries via the ORM; no SQL is assembled
by string concatenation from user input.

## 10. Data retention and deletion

Expanded in [docs/data-retention-and-disposal-policy.md](docs/data-retention-and-disposal-policy.md),
which covers disposal on managed infrastructure and the backup window.
Summarised here.

### Retention

Data is kept for as long as it is being used for the purpose it was collected
for, and no longer. In practice that means while the account exists — a budget
derived from history needs the history, and a two-year window is what the
product is built around.

| Data | Kept |
|---|---|
| Transactions, balances, accounts | While the account exists; deleted with it |
| Plaid access tokens | While the bank is connected; destroyed on disconnect |
| Categories, rules, budget settings, metal holdings | While the account exists |
| Authentication identity | While the account exists, held by Clerk |
| Plan and subscription identifiers | While the account exists |
| Push tokens | Until alerts are turned off on that phone, Apple reports the token dead, or the account is deleted |
| Former waitlist email addresses | Until removal is requested or the list is deleted |
| Request and error logs | The platform window, currently days |
| Database restore history | Up to 7 days |
| Payment records | Held by Stripe or Apple under their own obligations |

**Disconnecting a bank deletes its data immediately** — the item, its accounts
and every transaction under it, by cascade — without waiting for the account to
be closed. Categories and merchant rules survive, because they are the user’s
own work rather than the bank’s data, and will be there if they reconnect.

**When access ends, connections are closed but history is kept.** Once billing
is open, an account whose trial or subscription has ended becomes view-only,
and seven days later a daily scheduled job removes its bank connections at
Plaid and marks them closed. The accounts and transactions stay, so a returning
subscriber still has their history; connecting the same bank again replaces the
closed connection and its copy. Nothing is deleted by this job.

There is no archive, no cold storage and no analytics copy. When a row is
deleted there is no second copy of it anywhere in our systems beyond the
database restore window.

### Deletion

Users can **delete their account from inside the application**, on the web or
in the iPhone app. Deletion:

1. Cancels a subscription bought on the website, at Stripe, first — so a deleted
   account is not charged again;
2. Revokes every open bank connection at Plaid, so no connection is left live
   with no way to reach it;
3. Erases the user's accounts, transactions, categories, rules, overrides,
   budget settings, metal holdings and push tokens by cascade;
4. Removes the authentication identity from Clerk.

This is a hard delete, not a flag. If cancellation at Stripe or revocation at
Plaid fails, nothing is deleted and the user is told, rather than being given a
false confirmation. A subscription bought in the iPhone app cannot be cancelled
by us — Apple allows only the subscriber to do that — so both apps tell the user
to cancel it with Apple.

This section is reviewed annually with the rest of this policy, and whenever the
data model changes. Its adequacy under applicable state privacy law is part of
the outside legal review of the published privacy policy and terms, which has
not yet been completed.

## 11. Logging and monitoring

Cloudflare Workers observability is enabled, providing request logs, error
traces and metrics, including the output of the daily scheduled job.
Application errors are logged with enough context to diagnose them and
deliberately without financial detail, card data or access tokens.

Neon provides database-level monitoring and point-in-time recovery within a
restore window of up to seven days.

## 12. Incident response

The Member is the responder. In the event of a suspected compromise:

1. **Contain.** Rotate the affected credential — Worker secrets can be replaced
   and redeployed in minutes; a Stripe restricted key or Apple key is revoked in
   the provider's dashboard. If the token encryption key is implicated, affected
   Plaid items are revoked rather than re-encrypted.
2. **Assess.** Determine what data was reachable, using Cloudflare, Neon, Stripe
   and Clerk logs.
3. **Notify.** Affected users, and Plaid, without undue delay; and regulators to
   the extent required by applicable law — under Texas law, individuals within
   60 days of determining a breach, and the Texas Attorney General where 250 or
   more Texas residents are affected.
4. **Remediate and record.** Fix the cause, write down what happened and what
   changed.

Vulnerability reports are accepted at security@bilanciomoney.com and will be
acknowledged within three business days.

## 13. Business continuity

Source code is held in GitHub and is fully reproducible from it — the
application has no state outside the database. The database is managed by Neon
with automated backups and point-in-time recovery. Subscription state is held by
Stripe and Apple as well as locally, and can be re-derived from them. No data
exists solely on a developer machine.

## 14. What is not in place

Stated plainly, because a reviewer will ask and discovering it later is worse:

- **End-user MFA is not required** (§6). Each user can turn it on; it is not
  enforced for everyone.
- **No phishing-resistant authentication** (passkeys or WebAuthn).
- **No SOC 2, ISO 27001 or equivalent certification.** Not proportionate at
  current scale.
- **No third-party penetration test** has been performed to date.
- **No endpoint vulnerability scanning** on the two developer machines (§7a).
- **No formal security awareness training programme** — with one person and no
  employees, there is nobody to train.
- **No separation of duties**, for the same reason.
- **Incident response has not been rehearsed**, only documented.

These are consequences of size rather than of neglect, and each will be revisited
as the company grows — a penetration test being the first of them once there is
a meaningful user base.

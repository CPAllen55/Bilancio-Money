# Access Control Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
**Version 1.1 — 16 September 2026**

Companion to [SECURITY.md](../SECURITY.md), which this expands on. Where the two
differ, this document governs for access control and that one governs for
everything else.

Reviewed **quarterly** and whenever the architecture changes materially. This
file is version-controlled; its commit history is the review record.

Changes from 1.0: open sign-up; Stripe, Apple and Google Cloud added to scope
and to the register; the in-app admin page; the Stripe restricted key and the
Apple keys; and end-user MFA corrected to the configuration actually in force.

---

## 1. Purpose and scope

To state who may reach production systems and user financial data, how that
access is granted and removed, and how it is verified.

In scope: the Cloudflare account and Worker, the Neon database, the Clerk
authentication tenant, the Plaid dashboard, the Stripe account, the Apple
Developer and App Store Connect accounts, the Google Cloud project used for
Google sign-in, the GitHub repository, and the application itself.

## 2. Principles

1. **Least privilege.** An identity gets what it needs for its purpose and no
   more. Where this is not yet true, §7 says so.
2. **No implicit trust from network position.** There is no VPN, no bastion and
   no private network to be "inside". Every request is authenticated on its own
   merits, including requests from us.
3. **Separate identities for separate purposes.** Human access and machine
   access never share a credential.
4. **Nothing shared.** No shared logins, no shared passwords, no service account
   used interactively.

## 3. Human access

**Who.** One person: the Member of the LLC, who builds and operates both the web
service and the iPhone app. There are no employees, contractors, or third
parties with access to production systems or user data. This is the defining
constraint of this environment — most access-control risk concerns managing many
people, and there are none to manage.

**How it is protected.** Every administrative account — Cloudflare, Neon, Clerk,
Plaid, Stripe, Apple, Google Cloud, GitHub — requires **multi-factor
authentication**. Credentials are unique per provider and held in a password
manager, never reused and never written down in the repository or in
configuration.

**Granting access.** Any additional person would require: a documented business
reason, the narrowest role that serves it, MFA enrolled before first use, and an
entry in the register at §8. None has been granted to date.

**Removing access.** On departure or when a reason ends: revoke at each provider,
rotate every shared secret the person could have observed (§6), and record it.
Because access is provider-by-provider rather than through a single directory,
revocation is a checklist rather than one action — the checklist is §8.

## 4. End-user access to the application

Users authenticate through **Clerk**, which is the single identity provider for
the application. There is no separate password store and the application never
handles a password.

- **Sign-up is open.** Anyone may create an account. Email addresses are verified
  with a one-time code at sign-up, and Clerk's bot protection (CAPTCHA) screens
  automated sign-ups. Sign in with Apple and with Google are offered as
  alternatives to a password.
- **Multi-factor authentication is optional, and each user controls it.** A user
  can turn it on or off at any time (web: *Profile settings → Security*) with an
  authenticator application (TOTP), SMS one-time code, or single-use backup
  codes; once on, Clerk requires it at every sign-in for that user. It is not
  required for everyone, by decision: it was switched off so Apple's App Review
  could sign in to the demo account. Version 1.0 of this policy said it was
  enforced. None of the factors is phishing-resistant — see §7.
- Sessions are issued and verified by Clerk; the API verifies the session on
  every request rather than trusting anything the client asserts.
- **Entitlement is enforced on the server.** Once billing is open, an account
  whose trial or subscription has ended is refused every write, and a trial
  account is refused a third bank connection, by the API itself rather than by
  the client hiding a button.

**Data isolation.** A user reaches their own data and no one else's. Ownership is
proved on every query by joining through the account and item tables to the
authenticated user, so an identifier belonging to somebody else matches no rows
rather than returning their records. This is enforced in the query, not by a
check that could be forgotten at a call site.

**The admin page.** There is one privileged view inside the application. It
answers only to the single Clerk user id held in the `ADMIN_CLERK_USER_ID`
Worker secret — a secret rather than a database column, so that nothing able to
write to the database can grant itself the role — and answers **404** to
everyone else, so its existence is not disclosed. It lists the former waitlist
and each account's email address, plan and number of bank connections, and can
change an account's plan. It **cannot** read transactions, balances, budgets or
anything else from inside an account. There is no impersonation feature and no
support tool that reads another user's financial data.

## 5. Machine and service access

| Identity | Reaches | Credential | Held as |
|---|---|---|---|
| The Worker | Neon database | Connection string | Cloudflare Worker secret |
| The Worker | Plaid API | Client id and secret | Cloudflare Worker secret |
| The Worker | Clerk API | Secret key | Cloudflare Worker secret |
| The Worker | Stripe API | **Restricted** key: customers, checkout sessions, customer portal, subscriptions (write); prices (read) | Cloudflare Worker secret |
| The Worker | App Store Server API | App Store Connect API key | Cloudflare Worker secret |
| The Worker | Apple Push Notification service | APNs signing key | Cloudflare Worker secret |
| Plaid | Our webhook | Signed request | Verified against Plaid's key |
| Stripe | Our webhook | Signed request | Verified against the endpoint signing secret |
| Apple | Our notification endpoint | Unsigned pointer | State re-fetched from Apple over TLS; payload not trusted |
| Per-user | A bank, via Plaid | Access token | AES-256-GCM encrypted at rest |

All machine-to-machine traffic is over TLS. Inbound calls from providers are
**authenticated before the payload is acted upon**, so posting to an endpoint
achieves nothing without the provider's signature — or, for Apple, without Apple
itself confirming the state.

No machine credential is committed to source control. `.env` and `.dev.vars`
are excluded by `.gitignore`, and the committed configuration carries only
values that are public by design.

## 6. Credential rotation

- **On suspicion of exposure: immediately.** Worker secrets can be replaced and
  redeployed within minutes. Stripe restricted keys and Apple keys are revoked in
  the provider's dashboard and reissued. A private key that has appeared anywhere
  it should not — a screenshot, a chat, a file outside the password manager — is
  treated as exposed.
- **On any change of who has access: immediately**, for every secret that person
  could have observed.
- The **token encryption key is the exception and cannot be rotated in place** —
  it decrypts stored Plaid tokens, so changing it invalidates them. Rotating it
  means re-linking every bank. It is backed up in a password manager, and this
  constraint is understood rather than discovered later.

## 7. Known gaps

Stated because a policy that hides its weaknesses cannot be relied on.

- **End-user MFA is not required.** Each user can turn it on; it is not
  enforced for everyone.
- **End-user MFA is not phishing-resistant.** TOTP and SMS codes can be captured
  and replayed by a convincing fake sign-in page within their validity window.
  Passkeys or WebAuthn would bind the credential to the domain and remove that
  class of attack.
- **One database role does two jobs.** The application and its migrations both
  connect as `hyperdrive-user`, so the running Worker holds DDL rights it never
  needs. Splitting it into a read-write application role and a separate
  migration role is planned, and would mean leaked Worker credentials could not
  drop a table.
- **Administrative identity is not centralised.** Eight providers, eight logins,
  each with its own MFA. Single sign-on across them is not proportionate at this
  size, but it does mean revocation is a checklist rather than one switch.
- **Access reviews have not yet been performed.** The first is due November
  2026. With one identity there is little to find, but "performed" means
  performed and it has not been.
- **No automated de-provisioning**, there being no employee lifecycle to
  automate.

## 8. Access register and review

Reviewed quarterly. The review is: confirm each row is still correct, confirm
MFA is still enrolled, and confirm no account has been added that is not listed.

| System | Who | Level | MFA |
|---|---|---|---|
| Cloudflare | The Member | Account owner | Yes |
| Neon | The Member | Project owner | Yes |
| Clerk | The Member | Admin | Yes |
| Plaid | The Member | Account admin | Yes |
| Stripe | The Member | Account owner | Yes |
| Apple Developer / App Store Connect | The Member | Account holder | Yes (Apple two-factor) |
| Google Cloud (sign-in project) | The Member | Project owner | To be confirmed at first review |
| GitHub | The Member | Repository owner | Yes |
| Application admin page | The Member | The one `ADMIN_CLERK_USER_ID` | Inherits the Member's Clerk sign-in |

| Review date | Performed by | Findings |
|---|---|---|
| — | — | First review due November 2026 |

## 9. Reporting

Access concerns and vulnerability reports: **security@bilanciomoney.com**,
acknowledged within three business days.

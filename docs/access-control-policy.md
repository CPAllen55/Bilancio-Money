# Access Control Policy

**Guardiano del Faro LLC**, trading as Bilancio Money
**Version 1.0 — 24 August 2026**

Companion to [SECURITY.md](../SECURITY.md), which this expands on. Where the two
differ, this document governs for access control and that one governs for
everything else.

Reviewed **quarterly** and whenever the architecture changes materially. This
file is version-controlled; its commit history is the review record.

---

## 1. Purpose and scope

To state who may reach production systems and user financial data, how that
access is granted and removed, and how it is verified.

In scope: the Cloudflare account and Worker, the Neon database, the Clerk
authentication tenant, the Plaid dashboard, the GitHub repository, and the
application itself.

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

**Who.** One person: the Member of the LLC. There are no employees,
contractors, or third parties with access to production systems or user data.
This is the defining constraint of this environment — most access-control risk
concerns managing many people, and there are none to manage.

**How it is protected.** Every administrative account — Cloudflare, Neon, Clerk,
Plaid, GitHub — requires **multi-factor authentication**. Credentials are unique
per provider and held in a password manager, never reused and never written
down in the repository or in configuration.

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

- **Multi-factor authentication is required** on the production tenant.
- **Registration is invitation-only.** There is no open sign-up.
- Sessions are issued and verified by Clerk; the API verifies the session on
  every request rather than trusting anything the client asserts.

**Data isolation.** A user reaches their own data and no one else's. Ownership is
proved on every query by joining through the account and item tables to the
authenticated user, so an identifier belonging to somebody else matches no rows
rather than returning their records. This is enforced in the query, not by a
check that could be forgotten at a call site.

**Users hold no privileged role.** There is no admin role inside the
application, no impersonation feature, and no support tool that reads another
user's data.

## 5. Machine and service access

| Identity | Reaches | Credential | Held as |
|---|---|---|---|
| The Worker | Neon database | Connection string | Cloudflare Worker secret |
| The Worker | Plaid API | Client id and secret | Cloudflare Worker secret |
| The Worker | Clerk API | Secret key | Cloudflare Worker secret |
| Plaid | Our webhook | Signed request | Verified against Plaid's key |
| Per-user | A bank, via Plaid | Access token | AES-256-GCM encrypted at rest |

All machine-to-machine traffic is over TLS. Inbound webhooks from Plaid are
**cryptographically verified before the payload is acted upon**, so posting to
the endpoint achieves nothing without Plaid's signature.

No machine credential is committed to source control. `.env` and `.dev.vars`
are excluded by `.gitignore`, and the committed configuration carries only
values that are public by design.

## 6. Credential rotation

- **On suspicion of exposure: immediately.** Worker secrets can be replaced and
  redeployed within minutes.
- **On any change of who has access: immediately**, for every secret that person
  could have observed.
- The **token encryption key is the exception and cannot be rotated in place** —
  it decrypts stored Plaid tokens, so changing it invalidates them. Rotating it
  means re-linking every bank. It is backed up in a password manager, and this
  constraint is understood rather than discovered later.

## 7. Known gaps

Stated because a policy that hides its weaknesses cannot be relied on.

- **One database role does two jobs.** The application and its migrations both
  connect as `hyperdrive-user`, so the running Worker holds DDL rights it never
  needs. Splitting it into a read-write application role and a separate
  migration role is planned, and would mean leaked Worker credentials could not
  drop a table.
- **Administrative identity is not centralised.** Five providers, five logins,
  each with its own MFA. Single sign-on across them is not proportionate at this
  size, but it does mean revocation is a checklist rather than one switch.
- **Access reviews have not yet been performed.** The cadence above starts from
  this version. With one identity there is little to find, but "performed" means
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
| GitHub | The Member | Repository owner | Yes |

| Review date | Performed by | Findings |
|---|---|---|
| — | — | First review due November 2026 |

## 9. Reporting

Access concerns and vulnerability reports: **security@bilanciomoney.com**,
acknowledged within three business days.

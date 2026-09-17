# The Android app

Started 17 September 2026. A native Kotlin/Compose client of the same API the
iPhone app uses — the contract is [docs/ios-app-api.md](./ios-app-api.md), and
it is the contract for both phones. Nothing here changes the web app or the
iPhone app; every server addition below is additive and switched off until it is
configured, the way Stripe and Apple already are.

## Pinned versions, checked 17 September 2026

| | |
|---|---|
| Android Gradle Plugin | 9.4.0 |
| Kotlin | 2.4.20 |
| Compose BOM | 2026.09.00 |
| Clerk Android (auth) | `com.clerk:clerk-android-ui:1.1.7` |
| Plaid Link | `com.plaid.link:sdk-core:6.2.1` |
| Play Billing | `com.android.billingclient:billing-ktx:9.1.0` |

`applicationId` **`com.bilanciomoney.bilancio`** (lowercase; the iPhone bundle id
is `com.bilanciomoney.Bilancio` and the two are separate registrations).
minSdk 26, targetSdk the current one Studio offers.

## Phases

1. **Sign in, Overview, Transactions, Banks, delete account.** Clerk session,
   the API client, Plaid Link, the read-only screens. Enough to be a real app.
2. **Budgeting and Trend.**
3. **Play Billing**, and the server side of it (below).
4. **Push alerts** (Firebase), then Play Console submission.

## Server work, when each phase needs it

Additive, and each piece stays dormant until its secrets exist:

- **Play Billing** — `billing_source = "google"` beside `stripe` and `apple`; a
  `POST /api/billing/google` that verifies a purchase token with the Play
  Developer API, and Real-time Developer Notifications for renewals and
  cancellations. `src/apple.ts` is the shape to copy: the phone's claim is a
  pointer, the state is re-fetched from Google.
- **Push** — Firebase Cloud Messaging beside APNs. `push_devices` needs a
  `platform` column (migration, nullable, defaults to apple).
- **Plaid** — register the Android package name and SHA-256 signing certificate
  in the Plaid dashboard; add `/.well-known/assetlinks.json` under `public/` for
  the OAuth hand-back.
- **Clerk** — add the Android app under Native applications.
- **Legal** — Privacy Policy and Terms gain Google Play billing and Firebase.

## Play Console

- **Register as an organisation** (Guardiano del Faro LLC, D-U-N-S in hand).
  A personal account would have to run a 12-tester, 14-day closed test first;
  an organisation account does not. $25, once.
- Needed before release: Data safety form, **Financial features declaration**,
  privacy policy URL, in-app account deletion **and a deletion web page**
  (`/support/` covers it), content rating, "no ads", a reviewer demo account
  (plan `free`, no MFA), and the subscription products at $4.99 and $47.90.

## No Android phone

The emulator (a Pixel image **with Google Play**) covers development, including
Play Billing with licence-test accounts. Firebase Test Lab runs a build on real
devices for a pre-launch check. A cheap handset is worth having before release
for the bank OAuth hand-offs, which are the one thing an emulator handles
awkwardly, but nothing here is blocked without one.

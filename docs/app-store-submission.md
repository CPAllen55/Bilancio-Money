# What App Store Connect needs

Copy for the listing, and the answers to the questionnaires. The privacy
answers are not a matter of taste: they have to agree with
`ios/Bilancio/Bilancio/PrivacyInfo.xcprivacy`, which ships inside the binary,
and Apple compares the two.

## App Review Information → Sign-In Required

Tick it, and give the demo account. Then, in **Notes**:

```
Accounts are invitation only, so the Sign up flow is deliberately closed —
please sign in with the account above rather than registering. It signs in
with an email address and a password, and needs no emailed code.

The account is pre-populated with about two years of transactions, so every
screen has data in it. There is no need to connect a bank, and we would ask
you not to: bank linking runs against Plaid in production and would connect a
real financial institution.

Where to look:
  Overview      the month so far, against the plan
  Trend         spending by category over time; touch a bar for a figure,
                touch the readout to open that category's transactions
  Budgeting     the plan per subcategory; the chart can be opened on its own
                and a month dragged up or down to plan it
  Transactions  search, filter, split a transaction, re-file a merchant
  More          Calendar, Categories, Subscription, Banks, appearance
```

## App Privacy — what to answer

Three data types, and no others. Each is **linked to the user's identity** and
**not used for tracking**, with the purpose **App Functionality**.

| Apple's category | Type | Why |
|---|---|---|
| Contact Info | Email Address | The Clerk identity an account belongs to |
| Identifiers | User ID | The Clerk user id everything is stored against |
| Financial Info | Other Financial Info | Transactions and balances, which are the app |

Answer **No** to tracking, and do not add a tracking domain: nothing is shared
with a data broker or joined to anything outside the app.

Two that look like they might apply and do not. **Payment Info** — Apple takes
the payment for a subscription and we never see a card. **Purchase History** —
what is stored is a plan and a date, which is entitlement rather than a record
of purchases; if you would rather over-declare, add it, but then add it to the
manifest too or the two documents disagree.

## Export compliance

Already answered in the project: `ITSAppUsesNonExemptEncryption` is `NO`. The
app uses HTTPS and the platform keychain, which is exempt.

## Age rating

17+ is not needed. Nothing here is age-gated; a personal finance app with no
user-generated content, no ads and no third-party advertising identifiers
rates 4+.

## Category

Primary **Finance**. No secondary category — Productivity is tempting and it
puts the app in a list it does not win.

## Screenshots

From the demo account, never from a real one: screenshots are published and
permanent, and your own finances would be in them. 6.9" is required.

Take them with the app in Light appearance unless you deliberately want the
dark set, and take the same five screens in the same order so the set reads as
one product rather than five features.

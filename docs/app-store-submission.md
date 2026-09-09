# What App Store Connect needs

Copy for the listing, and the answers to the questionnaires. The privacy
answers are not a matter of taste: they have to agree with
`ios/Bilancio/Bilancio/PrivacyInfo.xcprivacy`, which ships inside the binary,
and Apple compares the two.

## The listing

Fill in the price before pasting the description — it is the one thing here
that cannot be written from the repo, and Apple requires it on the listing for
an auto-renewable subscription.

**Name** `Bilancio Money`

**Subtitle** (30 characters) `Know where the money went`

**Promotional text** (170, editable without a new build)

```
Every account in one place, categorised the way you actually think about
money — and a plan you can see yourself keeping.
```

**Keywords** (100 characters, commas, no spaces, no competitor names — Apple
rejects trademarked terms). Nothing here repeats the name or subtitle, which
are indexed separately and would be a wasted character each.

```
budget,spending,expenses,tracker,finance,bank,transactions,networth,categories,savings,cashflow
```

**Description**

```
Bilancio Money shows you your own money. It connects to your accounts, sorts
what comes in and goes out, and gives you one place to see whether the month
is going the way you meant it to.

It cannot move your money, spend it, or touch it. It reads.

WHAT IT DOES

Overview — the month so far against your plan, and what is left.

Trend — spending by category over months or years. Touch any bar for the
figure. Pinch to zoom, drag to scroll, and turn on Last Year to run a line
through the bars showing where you stood at the same point twelve months ago.

Budgeting — a plan per subcategory, built from what you actually spend rather
than a number you guessed. Open the chart on its own and drag a month up or
down to set it by hand.

Transactions — search, filter, and split a single purchase across categories.
Re-file a merchant once and every past and future transaction from it follows.

Calendar — the month as a grid, heaviest days darkest, with recurring charges
marked. Tilt the phone to see what each day cost.

Net Worth — accounts, assets and what they add up to.

The year ahead — what the next twelve months look like if nothing changes.

CATEGORIES THAT FIT YOU

Add your own subcategories, remove the ones you will never use, and file
anything anywhere. A subcategory with transactions in it cannot be deleted by
accident.

YOUR DATA

Bank connections are read-only and handled by Plaid. Credentials are never
seen by Bilancio. Nothing is sold, and nothing is shared with advertisers or
data brokers.

SUBSCRIPTION

Bilancio Money is free for one month, starting when you connect your first
account. After that it needs a subscription:

  Monthly — [PRICE] per month
  Yearly — [PRICE] per year

Payment is charged to your Apple Account at confirmation. It renews
automatically unless turned off at least 24 hours before the period ends, and
your account is charged for renewal within 24 hours of the end of the period.
Manage or cancel in Settings, under your Apple Account, then Subscriptions.

Terms of Use: https://bilanciomoney.com/terms
Privacy Policy: https://bilanciomoney.com/privacy
```

**Support URL** `https://bilanciomoney.com` — the footer carries a Contact
link to support@bilanciomoney.com, which is what this field is checked for.

**Marketing URL** `https://bilanciomoney.com` (optional; same page is fine).

**Copyright** `2026 Guardiano del Faro LLC`

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

## Subscriptions — guideline 3.1.2

The most common rejection for a subscription app, and all of it is about what
is **inside the binary**, not the listing. At the point of purchase the app has
to show the title, the length of the period and the price, and carry working
links to the Terms of Use and the Privacy Policy. `Views/SubscriptionView.swift`
does all four: title and price on each row, the period read from StoreKit
rather than from the product's name, and the two links in the footer. A
reviewer taps them, so they have to resolve — both are served as static pages
from this repo.

Two fields in App Store Connect have to agree with that:

- **App Privacy Policy URL** → `https://bilanciomoney.com/privacy`
- **License Agreement** → either Apple's standard EULA, or
  `https://bilanciomoney.com/terms` as a custom one. Whichever is chosen, it
  must be the same document the app links to.

Each subscription product also needs its own display name, description, and a
**review screenshot** before it can be submitted. A subscription that has never
shipped inside a binary cannot be reviewed, so the products have to be attached
to the build being submitted.

## The demo account's plan

Comp it before submitting: `plan = "free"`, which has no expiry.

A reviewer working through a `trial` account can run the clock out mid-review,
and everything after that point is read-only — they would be looking at a
different app than the one being submitted, and would be right to reject it.
`POST /api/admin/users/:id/plan` with `{"plan": "free", "note": "app review"}`
does it, from an admin session.

Do not comp it by giving it a long trial. `free` is the state that means "this
account does not expire"; a trial with a far-off date is the same thing said in
a way that eventually stops being true.

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

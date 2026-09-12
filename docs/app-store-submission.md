# What App Store Connect needs

Copy for the listing, and the answers to the questionnaires. The privacy
answers are not a matter of taste: they have to agree with
`ios/Bilancio/Bilancio/PrivacyInfo.xcprivacy`, which ships inside the binary,
and Apple compares the two.

## The listing

Prices are in: **$4.99 a month, $47.90 a year.** The annual figure ends in 90
rather than 88 because Apple sells only at its own price points and $47.88 is
not one of them. The website, the Terms and the web app were moved to $47.90
to match, so the two stores quote the same number.

**Name** `Bilancio Money`

**Subtitle** (30 characters) `Know where the money went`

**Promotional text** (170, editable without a new build)

```
Simple, intuitive, effective. See where your money actually goes, get a budget
built from your own spending, and hear about a category before it runs out.
```

154 of 170. The third clause is budget alerts, which shipped after the first
draft of this file and is the one thing here no competitor's listing says.

*Effective rather than powerful.* Powerful is the most overused word on the
App Store and it is a claim about the software; effective is a claim about the
outcome, which is what somebody buying a budgeting app is actually after. It
also pairs better — simple and intuitive are both about using the thing, so
the third word doing something different gives the trio somewhere to go.

*Not in the subtitle,* though it would fit at 28 characters. The subtitle is
the one line that tells a stranger what the app is, and it is indexed for
search: spending it on three adjectives that describe every app ever shipped
would cost the description and rank for nothing. Same reason none of the three
is in the keyword field.

**Keywords** (100 characters, commas, no spaces, no competitor names — Apple
rejects trademarked terms). Nothing here repeats the name or subtitle, which
are indexed separately and would be a wasted character each.

```
budget,spending,expenses,tracker,planner,finance,money,bank,transactions,networth,savings,bills
```

**Description**

```
Simple, intuitive, effective — take control of your money with insight you
can act on and a plan that keeps you on track.

Most people do not overspend because they are careless. They overspend
because nobody ever showed them where it was going.

Bilancio Money connects to your accounts and shows you exactly that: not a pie
chart of last month, but two years of it, down to the shop and the day. Then
it turns what it learns into a budget built from what you actually spend
rather than a number you guessed — so the plan is one you can keep, and
keeping it is what gets you where you are going.

It cannot move your money, spend it, or touch it. It reads.

A BUDGET THAT BUILDS ITSELF

Most budgets fail at the first screen, where you are asked what you intend to
spend on groceries. Bilancio already knows. It reads two years of your own
history, separates the bills that arrive every month from the spending that
moves, and proposes a figure for each subcategory.

Every figure shows its working — the merchants counted, what they charge, and
what was left out as a one-off. Change any of it and your number wins, with
the original kept so you can go back to it in one tap.

BEFORE YOU OVERSPEND, NOT AFTER

Choose the subcategories that matter to you and Bilancio tells you when one is
nearly spent, while there is still a month left to do something about it.
Nothing else notifies you, ever.

WHAT IT DOES

Overview — the month so far against your plan, and what is left.

Trend — spending by category over months or years. Touch any bar for the
figure. Pinch to zoom, drag to scroll, and turn on Last Year to run a line
through the bars showing where you stood at the same point twelve months ago.

Budgeting — a plan per subcategory, with the arithmetic behind every figure in
plain words. Watch each month against it as it happens, or drag a month up or
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
seen by Bilancio. There are no ads, no trackers and no analytics anywhere in
the app. Nothing is sold, and nothing is shared with advertisers or data
brokers.

Delete your account whenever you like, from inside the app. It removes your
data, your bank connections and your sign-in.

SUBSCRIPTION

Bilancio Money is free for one month, starting when you connect your first
account. After that it needs a subscription:

  Monthly — $4.99 per month
  Yearly — $47.90 per year

Payment is charged to your Apple Account at confirmation. It renews
automatically unless turned off at least 24 hours before the period ends, and
your account is charged for renewal within 24 hours of the end of the period.
Manage or cancel in Settings, under your Apple Account, then Subscriptions.

Bilancio Money shows you your own money. It is not financial, investment or
tax advice.

Terms of Use (EULA): https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
Privacy Policy: https://bilanciomoney.com/privacy
```

**Support URL** `https://bilanciomoney.com/support/` — contact addresses, how
to cancel on each platform, how to delete an account, and what to do when a
bank connection breaks. A homepage with a mailto in the footer passes review;
a page that answers the question a reviewer is checking for passes it without
them having to look.

**Marketing URL** `https://bilanciomoney.com` (optional; same page is fine).

**Copyright** `2026 Guardiano del Faro LLC` — no © symbol; Apple adds it.

**App Clip** none, and the field is left empty. A clip is a separate target,
capped at 15MB, launched from a link or a QR code without installing the app.
Every screen here needs a signed-in account with the reader's own bank behind
it, so there is nothing a clip could usefully show.

## App Review Information → Sign-In Required

Tick it, and give the demo account. Then, in **Notes**:

```
Access is by waitlist while we open the app to a first group, so signing up
creates a place in a queue rather than an account — please sign in with the
account above rather than registering. It signs in with the email address and
password given, and needs no emailed code.

Continue with Apple and Continue with Google are on the sign-in screen and
both work, but a fresh account signed in that way joins the waitlist rather
than reaching the app. The account above is the way in.

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
  More          Calendar, The year ahead, Net Worth, Categories,
                Subscription, Banks, and light/dark appearance

Budget alerts: More, then Budget alerts. Nothing alerts until a subcategory
is chosen there, and choosing one checks the current month straight away.

Deleting the account: More, then Banks, then Delete account at the bottom.
It removes the account itself and not only its data — the local record, every
bank connection, and the sign-in identity.
```

## Two guidelines to confirm rather than assume

**5.1.1(v), account deletion.** Built: More → Banks → Delete account, which
deletes the Clerk identity as well as the local rows. Rejections here are
usually not "it is missing" but "we could not find it", which is why the
review notes above name the path.

**4.8, Sign in with Apple.** Only required if the app offers a *third-party or
social* sign-in — Google, Facebook and so on. Email and password alone does
not trigger it. The sign-in screen is Clerk's own `AuthView`, so what it
offers is whatever is switched on in the Clerk dashboard, not something this
repo decides. Before submitting, look at Clerk → User & Authentication →
Social Connections: if anything is enabled there, Sign in with Apple has to be
enabled too. If the list is empty, there is nothing to do.

**3.1.1, anti-steering.** Nothing in the app links to the website's checkout
or mentions a price available elsewhere. Checked; keep it that way.

## App Privacy — what to answer

Three data types, and no others. Each is **linked to the user's identity** and
**not used for tracking**, with the purpose **App Functionality**.

| Apple's category | Type | Why |
|---|---|---|
| Contact Info | Email Address | The Clerk identity an account belongs to |
| Identifiers | User ID | The Clerk user id everything is stored against |
| Financial Info | Other Financial Info | Transactions and balances, which are the app |

Push notification tokens are not added as a data type. A token addresses one
install of the app for delivery, is deleted on sign-out, and identifies nobody
— which is a different thing from the Device ID category, which exists for
identifiers that follow a person across apps.

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
- **License Agreement** → **Apple's Standard EULA**, which is the default, so
  there is nothing to change. The app links to Apple's own copy of it at
  `https://www.apple.com/legal/internet-services/itunes/dev/stdeula/`, so the
  listing and the binary name the same document. A custom EULA would mean
  drafting one that carries Apple's minimum terms and keeping it in step with
  the link, for no gain.

`bilanciomoney.com/terms` is unaffected. It governs the service, and is linked
from the site and the web app; it is not the software licence, which is what
3.1.2 asks the app for.

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

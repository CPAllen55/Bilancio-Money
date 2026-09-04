# Setting up the Mac for the iOS app

For someone who has used Windows and not macOS. Written 2026-09-04.

Everything here assumes the repository is already cloned — if it is not, see
**Bootstrap** at the bottom, which is the short list that has to reach the Mac
some other way.

---

## Mac things that catch out a Windows user

- **Copy and paste is Command, not Control.** Command is the key beside the
  spacebar, marked ⌘. Control+C in Terminal still means "kill what is
  running", exactly as in PowerShell.
- **Command + Space** opens Spotlight, which is the fastest way to launch
  anything. Type the first few letters of an app name and press Return.
- **When Terminal asks for your password, nothing appears as you type.** No
  dots, no asterisks, no moving cursor. It looks broken and is not. Type it
  and press Return.
- **There is no "Run as administrator".** A single command that needs
  privileges is prefixed with `sudo`, which then asks for that invisible
  password.
- Terminal's prompt ends in `%`. That is the equivalent of `C:\...>`.

---

## 1. Xcode

From the Mac App Store — search "Xcode", press Install. It is around 15 GB
and can take a couple of hours, so start it before anything else.

When it finishes, **open it once** and let it install additional components.
It will not build anything until you have done this.

Then sign in with the developer account: **Xcode → Settings → Accounts → `+`
→ Apple ID**. Check that a Team appears under the account — that is the
enrolment showing up, and without it nothing can run on a real device or
reach TestFlight.

## 2. The project

**File → New → Project → iOS → App.**

| Field | Value |
|---|---|
| Product Name | `Bilancio` |
| Team | the one from step 1 |
| Organization Identifier | see below |
| Bundle Identifier | Xcode fills this in as organisation identifier + product name |
| Interface | SwiftUI |
| Language | Swift |
| Storage | None |

Save it **inside this repository**, in a folder called `ios`.

### Choosing the organisation identifier

It is reverse-DNS: a domain you control, written backwards, so that no two
developers can collide. The rule is that it should be a domain you actually
own — Apple does not verify it, which is exactly why claiming one you do not
hold is worth avoiding.

We own **bilanciomoney.com**, so `com.bilanciomoney` is the safe choice and
the bundle identifier becomes `com.bilanciomoney.Bilancio`. Namespacing by
the company instead would need guardianodelfaro.com to be ours.

**Write the resulting bundle identifier down.** It is registered with Plaid,
App Store Connect ties the app record to it, and provisioning profiles are
issued against it. Changing it after submission means a new app record.

### The Team

Guardiano del Faro LLC, not a personal team. The App Store lists the Team as
the seller, so this is what appears on the listing.

## 3. Packages

Both are added the same way: **File → Add Package Dependencies**, paste the
URL, press Add Package.

- **Clerk** — supplies the session token every API call needs.
- **Plaid Link** — the bank-connection flow.

Search for the current repository URLs rather than trusting a URL written
here months ago; both publish them on their iOS documentation.

## 4. Point it at the API

Base URL is `https://bilanciomoney.com`. Every call needs:

```
Authorization: Bearer <the Clerk session token>
```

The full contract — every endpoint, what it returns, and the four traps worth
knowing before you hit them — is in **`docs/ios-app-api.md`** beside this
file. Read that before writing any networking code.

## 5. The first screen, and why that one

Build **sign-in, then the Overview**, before anything else and before any
Plaid work.

The reason is that it proves the whole chain end to end — Clerk issues a
token, the app sends it, `requireUser` accepts it, a real figure comes back
and appears on screen. Every later screen is then a variation on something
already known to work. Starting with the bank-linking flow means debugging
Plaid and authentication at the same time, without knowing which is broken.

`GET /api/summary?range=this-month` returns `totals.net` — income minus
expenses, in cents. If that number renders, the hard part is done.

---

## Working across two machines

The web app and the Worker are developed on the Windows machine; this
directory is the only part the Mac touches. They do not overlap, so the only
rule is:

**Push before leaving a machine. Pull on arriving at one.**

The Claude session on the Mac starts with no memory of the Windows sessions —
that history does not sync. It can read this repository, though, which is why
anything worth carrying across is written into it rather than said in a chat.

---

## Bootstrap

The short list that has to reach the Mac before the repository exists on it.

1. Open Terminal: **Command + Space**, type `terminal`, press Return.
2. Install the command line tools — this gives you `git`:

   ```
   xcode-select --install
   ```

   A dialog appears; click Install, then Agree. "Already installed" is a
   success, not an error.

3. Install Homebrew. **Do not type this from a screenshot** — go to
   [brew.sh](https://brew.sh) on the Mac and use the copy button on the
   command there. It is long, and one wrong character is a confusing failure.

4. Install GitHub's CLI and sign in. GitHub no longer accepts passwords over
   HTTPS, so this is what makes cloning work:

   ```
   brew install gh
   gh auth login
   ```

   Choose GitHub.com, HTTPS, and authenticate in the browser.

5. Clone:

   ```
   git clone https://github.com/CPAllen55/Bilancio-Money.git
   ```

Node is **not** needed for the iOS app. Install it only if you also want to
run the Worker locally on the Mac.

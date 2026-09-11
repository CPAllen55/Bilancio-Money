/**
 * Fills an account with two years of invented transactions, so somebody can be
 * shown the product without linking a real bank.
 *
 *   npm run demo:seed       -- friend@example.com     the dev branch
 *   npm run demo:clear      -- friend@example.com
 *   npm run demo:seed:prod  -- friend@example.com     production
 *   npm run demo:clear:prod -- friend@example.com
 *
 * ── Production is a separate word, and a question ────────────────────────
 *
 * Dev is the default and needs no argument. Production has to be asked for by
 * name and then confirmed by typing the address again, because inventing
 * financial history and writing it where real people's data lives should not
 * be one mistyped flag away. --force skips the question, and exists so this
 * can be scripted; typing it is the deliberate act.
 *
 * What protects the data is not the prompt, though. It is that this only ever
 * touches an account that already exists, only ever adds one item it can
 * identify as its own, refuses outright if that person has a real bank
 * connected, and can take the whole thing away again.
 *
 * ── Why transactions and not fixtures ────────────────────────────────────
 *
 * The alternative was a demo mode that answers the API from canned JSON. It
 * would have been quicker and it would have been a lie: the budget engine, the
 * seasonal index, the outlier detection and every total on every tab are
 * server-side, so canned answers would demonstrate a drawing of the product
 * rather than the product. Seeding transactions means everything downstream is
 * the real code doing real work, and a tester's reaction is to the thing that
 * will ship.
 *
 * ── What it deliberately contains ────────────────────────────────────────
 *
 * Not just noise. The data is shaped to exercise the parts of the planner that
 * are hard to believe until they are seen:
 *
 *   · a family holiday every May, so the seasonal index has something real to
 *     find and May comes out heavy rather than the year being smeared flat;
 *   · a one-off veterinary bill and a one-off car repair, so outlier exclusion
 *     is visibly refusing to turn one bad month into a monthly pet budget;
 *   · a subscription that starts partway through, so the trend has a step;
 *   · a pay rise and a December bonus that repeats;
 *   · steady rent and salary, as a spine to read the rest against.
 *
 * ── The one thing it cannot fake ─────────────────────────────────────────
 *
 * The bank connection. There is no Plaid item behind this, so Refresh on the
 * Banks tab will fail for demo data. The institution is named so that is
 * obvious before anybody clicks it.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Client } from "pg";

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const mode = argv.includes("clear") ? "clear" : "seed";
const replace = argv.includes("--replace");
const force = argv.includes("--force");
/* Named, not positional, and dev unless production is spelled out. */
const target = argv.includes("prod") ? "prod" : "dev";
const email = argv.find((a) => a.includes("@"));

if (!email) {
  console.error(
    "Which account? Pass the email address the person signs in with.\n" +
    "  npm run demo:seed -- friend@example.com",
  );
  process.exit(1);
}

const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!url) {
  console.error(`No connection string for "${target}". Check .env.`);
  process.exit(1);
}

/** Production asks once, out loud, and takes the address as the answer. */
async function confirmProduction(what) {
  if (target !== "prod" || force) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log(`  ${what}`);
  console.log("  This is PRODUCTION — the database real people use.");
  console.log("");
  const typed = await rl.question(`  Type the address again to go ahead: `);
  rl.close();
  if (typed.trim().toLowerCase() !== email.toLowerCase()) {
    console.error("\nThat did not match. Nothing was changed.");
    process.exit(1);
  }
  console.log("");
}

/* ------------------------------------------------------------------ dice -- */

/* Seeded from the address, so one person's demo is the same every time it is
   rebuilt and two people's are not identical. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let seed = 0;
for (const ch of email.toLowerCase()) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
const rnd = mulberry32(seed);

const jitter = (base, pct) => Math.round(base * (1 + (rnd() * 2 - 1) * pct));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

/* --------------------------------------------------------------- calendar -- */

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const MONTHS = [];
for (let back = 23; back >= 0; back--) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
  MONTHS.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
}
const dayIn = (mo, day) => {
  const last = new Date(Date.UTC(mo.y, mo.m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(mo.y, mo.m, Math.min(day, last))));
};
/* Nothing in the future: the current month is only lived as far as today. */
const TODAY = iso(today);

/* ------------------------------------------------------------- the ledger -- */

/* Plaid's convention, which is what the column stores: POSITIVE is money
   LEAVING. Income is therefore negative, and getting this backwards would
   invert every figure in the product. */
const rows = [];
let n = 0;
function tx(acct, dateStr, cents, name, primary, detailed) {
  if (dateStr > TODAY) return;
  rows.push({
    account: acct,
    id: `demo-${seed >>> 0}-${++n}`,
    amount: cents,
    date: dateStr,
    name,
    primary,
    detailed,
  });
}

const CHECKING = "checking", SAVINGS = "savings", CARD = "card";

const GROCERS = ["Whole Foods Market", "Trader Joe's", "H-E-B", "Kroger"];
const CAFES   = ["Starbucks", "Blue Bottle Coffee", "Local Roasters"];
const DINERS  = ["Torchy's Tacos", "Olive Garden", "Thai Kitchen", "Shake Shack", "Sushi Ko"];
const FUEL    = ["Shell", "Chevron", "Buc-ee's"];
const SHOPS   = ["Amazon", "Target", "Costco"];

/* ── A household with children ──────────────────────────────────────────────
 *
 * Kids is where the new taxonomy earns its keep, and it is the part of the
 * ledger a parent recognises fastest: the same figure every month for care,
 * a lump in August, and a fortnight in July when everything stops.
 *
 * The shapes are the point, not the amounts. After-school care is the steady
 * one -- the same 520 on the same day for ten months and nothing at all in
 * June and July -- which is what the engine should find as a commitment and
 * what a reader should recognise without being told. School supplies and
 * clothing spike once in August and go quiet. Activities run in terms.
 * Babysitting is genuinely irregular. The doctor and the birthday presents
 * turn up a few times a year.
 *
 * Total is about 830 a month against 7,200 of income, on top of roughly 3,580
 * of everything else -- so the household still keeps something, which is the
 * figure the product is for. A demo where the money runs out teaches nothing.
 *
 * ── Why these need merchant rules ──────────────────────────────────────────
 *
 * Plaid has one code that reaches any of this: GENERAL_SERVICES_CHILDCARE,
 * which files to Daycare. There is no code for kid clothing as against
 * clothing, or a child's dance class as against an evening out. So each of
 * these merchants gets a rule, which is exactly what a parent would do on
 * their first month with the app -- file the dance studio once and never
 * think about it again.
 *
 * It also means the demo exercises the rule path rather than only the
 * classifier, which is worth having in the data somebody is shown. */
const KID_RULES = {
  "Bright Beginnings Academy": "daycare",
  "Sitters Now":               "babysitting",
  "Carter's":                  "kid-clothing",
  "The Children's Place":      "kid-clothing",
  "Lakeshore Learning":        "kid-supplies",
  "Pediatric Partners":        "kid-health",
  "Kumon Learning Center":     "kid-education",
  "Center Stage Dance":        "kid-activities",
  "Riverbend Soccer Club":     "kid-activities",
  "The Toy Chest":             "kid-gifts",
};

/* The pool a row was drawn from, recoverable afterwards from its Plaid
   category. Used to swap a merchant for a sibling without changing what kind
   of spending the row is — see the logo pass. */
const POOL_OF = {
  FOOD_AND_DRINK_GROCERIES: GROCERS,
  FOOD_AND_DRINK_COFFEE: CAFES,
  FOOD_AND_DRINK_RESTAURANT: DINERS,
  TRANSPORTATION_GAS: FUEL,
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: SHOPS,
};

for (const [idx, mo] of MONTHS.entries()) {
  const monthNo = mo.m + 1;

  /* Salary twice a month, with a rise partway through and a December bonus
     that repeats — two years running is what makes it a shape, not an event. */
  const pay = Math.round(360000 * (idx >= 15 ? 1.06 : 1));
  tx(CHECKING, dayIn(mo, 1),  -pay, "ACME CORP PAYROLL", "INCOME", "INCOME_WAGES");
  tx(CHECKING, dayIn(mo, 15), -pay, "ACME CORP PAYROLL", "INCOME", "INCOME_WAGES");
  if (monthNo === 12) {
    tx(CHECKING, dayIn(mo, 18), -jitter(240000, 0.15), "ACME CORP BONUS",
       "INCOME", "INCOME_WAGES");
  }

  /* The spine: rent and the bills that barely move. */
  tx(CHECKING, dayIn(mo, 1), 195000, "GREYSTONE PROPERTIES",
     "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT");
  tx(CHECKING, dayIn(mo, 4), jitter(14500, 0.28), "CITY POWER & LIGHT",
     "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY");
  tx(CHECKING, dayIn(mo, 6), 8900, "SPECTRUM INTERNET",
     "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE");
  /* The phone, so Bills & Utilities shows all three of its leaves. Same day,
     same figure, every month: the shape the engine should take as a
     commitment rather than estimate. */
  tx(CARD, dayIn(mo, 14), 8500, "T-MOBILE",
     "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_TELEPHONE");
  tx(CHECKING, dayIn(mo, 10), 18400, "STATE FARM INSURANCE",
     "GENERAL_SERVICES", "GENERAL_SERVICES_INSURANCE");
  tx(CARD, dayIn(mo, 12), 4900, "PLANET FITNESS",
     "PERSONAL_CARE", "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS");
  tx(CARD, dayIn(mo, 8), 1599, "NETFLIX", "ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES");
  /* Starts partway through, so the trend has a step in it. */
  if (idx >= 9) {
    tx(CARD, dayIn(mo, 9), 1099, "SPOTIFY", "ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO");
  }

  /* Groceries and eating out, heavier around the holidays. */
  const lift = monthNo === 11 || monthNo === 12 ? 1.25 : 1;
  for (let i = 0; i < 7 + Math.floor(rnd() * 3); i++) {
    tx(CARD, dayIn(mo, 2 + Math.floor(rnd() * 26)),
       Math.round(jitter(7800, 0.4) * lift), pick(GROCERS),
       "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES");
  }
  for (let i = 0; i < 8 + Math.floor(rnd() * 6); i++) {
    tx(CARD, dayIn(mo, 1 + Math.floor(rnd() * 27)), jitter(620, 0.35), pick(CAFES),
       "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE");
  }
  for (let i = 0; i < 4 + Math.floor(rnd() * 4); i++) {
    tx(CARD, dayIn(mo, 1 + Math.floor(rnd() * 27)), jitter(4600, 0.5), pick(DINERS),
       "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT");
  }

  /* Getting about. */
  for (let i = 0; i < 3 + Math.floor(rnd() * 2); i++) {
    tx(CARD, dayIn(mo, 3 + Math.floor(rnd() * 25)), jitter(5200, 0.3), pick(FUEL),
       "TRANSPORTATION", "TRANSPORTATION_GAS");
  }
  if (chance(0.6)) {
    tx(CARD, dayIn(mo, 5 + Math.floor(rnd() * 20)), jitter(2300, 0.5), "Uber",
       "TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES");
  }

  /* ── Children ─────────────────────────────────────────────────────────
     The school year runs August to May. Everything that follows the calendar
     stops for June and July, which is the shape a parent will look for. */
  const inSchool = monthNo >= 8 || monthNo <= 5;

  if (inSchool) {
    /* The steadiest line in the ledger after the rent. Same day, same
       amount, ten months of the year -- a commitment with two months off,
       which is a shape nothing else in this file has. */
    tx(CHECKING, dayIn(mo, 3), 52000, "Bright Beginnings Academy",
       "GENERAL_SERVICES", "GENERAL_SERVICES_CHILDCARE");
  }
  if (monthNo >= 9 || monthNo <= 5) {
    tx(CARD, dayIn(mo, 11), 16000, "Kumon Learning Center",
       "GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION");
    tx(CARD, dayIn(mo, 14), 7500, "Center Stage Dance",
       "ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS");
  }
  /* Registration, twice a year, in the month the season opens. */
  if (monthNo === 3 || monthNo === 8) {
    tx(CARD, dayIn(mo, 6), jitter(11500, 0.12), "Riverbend Soccer Club",
       "ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS");
  }

  /* Back to school: one August, visible from across the room. */
  if (monthNo === 8) {
    tx(CARD, dayIn(mo, 9),  jitter(18500, 0.15), "Lakeshore Learning",
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES");
    tx(CARD, dayIn(mo, 11), jitter(16500, 0.2), "Carter's",
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES");
  }
  if (monthNo === 1) {
    tx(CARD, dayIn(mo, 14), jitter(4500, 0.3), "Lakeshore Learning",
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES");
  }
  /* Children grow out of things at no particular time of year. */
  if (chance(0.45)) {
    tx(CARD, dayIn(mo, 4 + Math.floor(rnd() * 22)), jitter(6200, 0.4),
       chance(0.5) ? "Carter's" : "The Children's Place",
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES");
  }

  /* Irregular by nature: some months twice, some not at all. */
  for (let i = 0; i < Math.floor(rnd() * 3); i++) {
    tx(CHECKING, dayIn(mo, 5 + Math.floor(rnd() * 21)), jitter(7500, 0.25),
       "Sitters Now", "GENERAL_SERVICES", "GENERAL_SERVICES_CHILDCARE");
  }
  if (chance(0.3)) {
    tx(CARD, dayIn(mo, 8 + Math.floor(rnd() * 16)), jitter(4200, 0.5),
       "Pediatric Partners", "MEDICAL", "MEDICAL_PRIMARY_CARE");
  }
  /* A birthday in April, and December. */
  if (monthNo === 4 || monthNo === 12) {
    tx(CARD, dayIn(mo, 16), jitter(monthNo === 12 ? 19500 : 12000, 0.2),
       "The Toy Chest", "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES");
  }

  /* Odds and ends. */
  for (let i = 0; i < 2 + Math.floor(rnd() * 4); i++) {
    tx(CARD, dayIn(mo, 1 + Math.floor(rnd() * 27)), jitter(5400, 0.7), pick(SHOPS),
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES");
  }
  if (chance(0.35)) {
    tx(CARD, dayIn(mo, 6 + Math.floor(rnd() * 18)), jitter(3800, 0.5), "PetSmart",
       "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_PET_SUPPLIES");
  }

  /* The family holiday, every May — booked in April, spent in May. Two years
     of it is what turns it from a surprise into a shape the planner can find,
     which is the whole argument for seasonality made visible. */
  if (monthNo === 4) {
    tx(CARD, dayIn(mo, 20), jitter(128000, 0.12), "UNITED AIRLINES", "TRAVEL", "TRAVEL_FLIGHTS");
  }
  if (monthNo === 5) {
    tx(CARD, dayIn(mo, 12), jitter(96000, 0.15), "MARRIOTT HOTELS", "TRAVEL", "TRAVEL_LODGING");
    tx(CARD, dayIn(mo, 14), jitter(31000, 0.3), "HERTZ RENT A CAR",
       "TRAVEL", "TRAVEL_RENTAL_CARS");
    tx(CARD, dayIn(mo, 15), jitter(22000, 0.35), "Beachside Grill",
       "FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT");
  }

  /* Saving, and paying the card off. Both transfers, so neither is mistaken
     for income or for spending. */
  tx(CHECKING, dayIn(mo, 2), 50000, "TRANSFER TO SAVINGS",
     "TRANSFER_OUT", "TRANSFER_OUT_SAVINGS");
  tx(SAVINGS, dayIn(mo, 2), -50000, "TRANSFER FROM CHECKING",
     "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER");
  tx(SAVINGS, dayIn(mo, 28), -jitter(900, 0.4), "INTEREST PAID",
     "INCOME", "INCOME_INTEREST_EARNED");
  tx(CHECKING, dayIn(mo, 22), jitter(120000, 0.25), "CREDIT CARD PAYMENT",
     "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER");
}

/* ── The most recent day ────────────────────────────────────────────────────

 * Five named merchants on the newest date in the ledger, rather than whatever
 * the dice produced.
 *
 * The Transactions tab is newest-first, so this is the first screenful anybody
 * sees — a new user on their first sync, and the App Store listing, which is
 * screenshotted from this data. Left to chance the top of the list is as
 * likely to be Sushi Ko and Local Roasters as anything recognisable, and an
 * invented restaurant has no logo because no such restaurant exists.
 *
 * These five are the household names most likely to have a logo waiting in
 * Plaid's CDN, and one from each of the categories a person actually looks at:
 * a grocery shop, an online order, a warehouse run, fuel, a ride.
 *
 * Fixed amounts rather than jittered. Everything else in this file is random
 * within a shape, which is right for two years of history and wrong for the
 * one row somebody is going to photograph — a screenshot that changes every
 * time it is retaken cannot be checked against anything.
 *
 * Dated TODAY, not a hard-coded day, so this stays the top of the list however
 * long from now it is reseeded. */
const HEADLINE = [
  ["Whole Foods Market", 9240, "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"],
  ["Amazon", 4715, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"],
  ["Costco", 18630, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"],
  ["Shell", 5180, "TRANSPORTATION", "TRANSPORTATION_GAS"],
  ["Uber", 2340, "TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"],
];
for (const [name, cents, primary, detailed] of HEADLINE) {
  tx(CARD, TODAY, cents, name, primary, detailed);
}

/* The one-offs that must not become monthly budgets. Placed well inside the
   learning window and unmistakably singular — two of them, so a reader can see
   it is a rule rather than one lucky special case. */
tx(CARD, dayIn(MONTHS[MONTHS.length - 14], 17), 104500, "RIVER OAKS VETERINARY",
   "GENERAL_SERVICES", "GENERAL_SERVICES_VETERINARY_SERVICES");
tx(CHECKING, dayIn(MONTHS[MONTHS.length - 7], 9), 78000, "CENTRAL AUTO REPAIR",
   "TRANSPORTATION", "TRANSPORTATION_OTHER_TRANSPORTATION");

/* --------------------------------------------------------------- balances -- */

const net = (acct) => rows.filter(r => r.account === acct).reduce((s, r) => s + r.amount, 0);
/* Money leaving is positive, so a depository balance falls by the net while a
   card balance — what is owed — rises by it. */
const BAL = {
  [CHECKING]: 480000 - net(CHECKING),
  [SAVINGS]: 1250000 - net(SAVINGS),
  [CARD]: Math.max(35000, Math.round(net(CARD) * 0.06)),
};

/* ------------------------------------------------------------------ write -- */

const money = (c) =>
  (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const client = new Client({ connectionString: url });
await client.connect();
try {
  const { rows: found } = await client.query(
    `select id, email from users where lower(email) = lower($1) and deleted_at is null`,
    [email],
  );
  if (!found.length) {
    console.error(
      `No account for ${email} on ${target}.\n` +
      `They need to have signed in there at least once first — the row is created then.`,
    );
    process.exit(1);
  }
  const user = found[0];
  const itemPlaidId = `demo-item-${user.id}`;

  if (mode === "clear") {
    await confirmProduction(`Remove the demo bank from ${email}.`);
    /* The rules go too. Left behind, they would sit waiting to re-file a real
       bank's transactions into categories chosen for invented children. */
    const ruled = await client.query(
      `delete from merchant_rules where user_id = $1 and match_key = any($2::text[])`,
      [user.id, Object.keys(KID_RULES).map((n) => n.toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())],
    );
    if (ruled.rowCount) console.log(`Removed ${ruled.rowCount} demo merchant rule(s).`);
    const res = await client.query(
      `delete from items where user_id = $1 and plaid_item_id = $2`,
      [user.id, itemPlaidId],
    );
    console.log(res.rowCount
      ? `Removed the demo bank for ${email} on ${target}. Its accounts and transactions went with it.`
      : `${email} had no demo data on ${target}.`);
    process.exit(0);
  }

  const { rows: items } = await client.query(
    `select id, plaid_item_id from items where user_id = $1`, [user.id],
  );
  const already = items.find((i) => i.plaid_item_id === itemPlaidId);
  const real = items.filter((i) => i.plaid_item_id !== itemPlaidId);

  if (real.length && !replace) {
    console.error(
      `${email} already has ${real.length} real bank connection(s) on ${target}.\n` +
      `Demo data would sit alongside them and muddle every total.\n` +
      `Pass --replace if that is genuinely what you want.`,
    );
    process.exit(1);
  }

  /* Everything is checked before anything is asked, so the question is the
     last thing between a correct command and the writing, rather than a gate
     in front of a command that was going to fail anyway. */
  await confirmProduction(
    `Seed ${rows.length} invented transactions into ${email}` +
    (already ? ", replacing the demo data already there." : "."),
  );

  if (already) {
    await client.query(`delete from items where id = $1`, [already.id]);
    console.log("Replaced the previous demo data.");
  }

  const itemId = randomUUID();
  await client.query(
    `insert into items (id, user_id, plaid_item_id, institution_id, institution_name,
                        access_token_ciphertext, access_token_iv, status, last_synced_at)
     values ($1, $2, $3, 'demo', 'Demo Bank (sample data)', 'demo', 'demo', 'good', now())`,
    [itemId, user.id, itemPlaidId],
  );

  const accountIds = {};
  const specs = [
    [CHECKING, "Everyday Checking", "depository", "checking",    "4471", null],
    [SAVINGS,  "Savings",           "depository", "savings",     "8820", null],
    [CARD,     "Rewards Card",      "credit",     "credit card", "1043", 1500000],
  ];
  for (const [key, name, type, subtype, mask, limit] of specs) {
    const id = randomUUID();
    accountIds[key] = id;
    await client.query(
      `insert into accounts (id, item_id, plaid_account_id, name, type, subtype, mask,
                             current_balance, available_balance, limit_amount, balance_as_of)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [id, itemId, `demo-${user.id}-${key}`, name, type, subtype, mask,
       BAL[key], type === "credit" ? null : BAL[key], limit],
    );
  }

  /* ── Logos, borrowed from whatever Plaid has already sent ──────────────

     The demo merchants are real brands — Netflix, H-E-B, Costco — and the
     app draws a logo for a merchant when Plaid has supplied one. Seeded rows
     have no Plaid behind them, so they fall back to the coloured monogram,
     which is fine but is not what the product looks like in use.

     The filenames cannot be invented. Plaid's CDN serves walmart_1100.png
     and nothing else that resembles it: the suffix is an internal merchant
     id, not a pattern, so every guess is a 404. The only way to know what a
     logo is called is to find one that has already arrived on a real
     transaction — and this database has some.

     So the lookup is built from the ledger rather than hard-coded. Nothing
     personal crosses over: the result is a map from a brand name to the name
     of a public image file, which is a fact about Plaid's CDN rather than
     about anybody's spending. It also cannot go stale, because it is rebuilt
     from current data every time this runs.

     A demo merchant Plaid has never sent a logo for keeps its monogram, which
     is the same thing a real user sees for a corner shop. */
  const { rows: known } = await client.query(`
    select distinct on (1)
           coalesce(merchant_name, name) as merchant,
           raw->>'logo_url'              as logo_url
    from transactions
    where raw->>'logo_url' is not null
    order by 1, 2
  `);

  /* Matched on letters and digits alone, so "H-E-B" finds "H E B" and
     "NETFLIX" finds "Netflix". */
  const flatten = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const logos = new Map();
  for (const r of known) {
    const k = flatten(r.merchant);
    if (k && !logos.has(k)) logos.set(k, r.logo_url);
  }

  /* Exact first, then one contained in the other — "Whole Foods Market" and
     "Whole Foods" are the same shop, and a bank spells it whichever way it
     likes. Five characters minimum, so short names cannot swallow each
     other: "H E B" flattens to three and would otherwise match half the
     ledger. */
  const logoFor = (name) => {
    const k = flatten(name);
    if (!k) return null;
    if (logos.has(k)) return logos.get(k);
    if (k.length < 5) return null;
    for (const [other, url] of logos) {
      if (other.length >= 5 && (other.includes(k) || k.includes(other))) return url;
    }
    return null;
  };

  /* ── The top of the list gets logos wherever a sibling has one ──────────

     The Transactions tab is newest-first, so the most recent couple of dozen
     rows are the ones a person sees first and the ones that end up in an App
     Store screenshot. A screen of coloured letters is honest and dull; a
     screen of recognisable marks is what the product looks like once a real
     bank has been connected for a month.

     Only the merchant NAME changes, and only to another merchant from the
     same pool -- a grocery row becomes a different grocer, never a streaming
     service. Category, amount, date and account are untouched, so every
     total, budget and chart downstream is exactly what it was. Swapping
     across categories would have made a prettier screenshot of a dataset that
     no longer added up.

     Deterministic: the choice is derived from the row's own id, so reseeding
     produces the same ledger rather than a new one each time.

     Rows outside a pool -- rent, salary, the subscriptions -- are left alone.
     They are single named merchants with nothing to swap them for, and two of
     them (Netflix, Spotify) usually have logos of their own anyway. */
  const RECENT = 30;
  const recent = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, RECENT);
  /* The headline five are named on purpose and are not up for swapping. If
     Plaid has never sent a logo for one of them it shows a monogram, which is
     the honest answer -- quietly turning Costco into Target because Target had
     a picture would be answering a question nobody asked. */
  const pinned = new Set(HEADLINE.map(([name]) => name));
  let dressed = 0;
  for (const r of recent) {
    if (pinned.has(r.name)) continue;
    if (logoFor(r.name)) continue;
    const pool = POOL_OF[r.detailed];
    if (!pool) continue;
    const withLogo = pool.filter((n) => logoFor(n));
    if (!withLogo.length) continue;
    let h = 0;
    for (let i = 0; i < r.id.length; i++) h = (h * 31 + r.id.charCodeAt(i)) | 0;
    r.name = withLogo[Math.abs(h) % withLogo.length];
    dressed++;
  }

  const matched = new Set(rows.map((r) => r.name).filter((n) => logoFor(n)));
  const top = recent.filter((r) => logoFor(r.name)).length;
  const missing = HEADLINE.map(([n]) => n).filter((n) => !logoFor(n));
  if (missing.length) {
    console.log(`Note: no logo yet for ${missing.join(", ")} — ` +
                "they will show a monogram. `npm run logos` lists what is available.");
  }
  console.log(known.length
    ? `Logos: ${matched.size} of the demo's merchants matched one Plaid has already sent.\n` +
      `       ${top} of the newest ${recent.length} rows carry one` +
      (dressed ? ` (${dressed} swapped to a sibling that had one).` : ".")
    : "Logos: none in this database yet, so the demo uses monograms.");

  /* Batched, rather than a few thousand round trips. */
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [], params = [];
    slice.forEach((r, j) => {
      const b = j * 9;
      values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
      params.push(accountIds[r.account], r.id, String(r.amount), r.date, r.name,
                  r.name, r.primary, r.detailed,
                  JSON.stringify({
                    demo: true, name: r.name,
                    /* Only when there is one. An absent key and a null read
                       the same to the server, but writing null would make
                       every row claim to have been asked about. */
                    ...(logoFor(r.name) ? { logo_url: logoFor(r.name) } : {}),
                  }));
    });
    await client.query(
      `insert into transactions
         (account_id, plaid_transaction_id, amount, date, name, merchant_name,
          category_primary, category_detailed, raw)
       values ${values.join(",")}
       on conflict (plaid_transaction_id) do nothing`,
      params,
    );
  }

  /* ── The rules that put the children's spending where it belongs ────────

     Plaid has exactly one code that reaches any of this -- CHILDCARE, which
     files to Daycare. Without a rule, the dance class lands in Events, the
     school supplies in General Stores and the clothes in Clothing: all
     defensible readings of a bank feed, and none of them what a parent means.

     So the demo files them, the way a parent would in their first week. The
     key is normalised on the way in exactly as merchantKey would, so a rule
     written here matches by the same test that matches a real one.

     Category ids are looked up rather than assumed: these subcategories only
     exist after the taxonomy has been seeded, and a missing one should say so
     rather than write a rule pointing at nothing. */
  const flat = (s) => String(s || "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/(?:\s+\d{1,2})+\s*$/, " ")
    .replace(/\s+/g, " ").trim();

  const wanted = [...new Set(Object.values(KID_RULES))];
  const { rows: cats } = await client.query(
    `select id, slug from categories
      where user_id is null and archived_at is null and slug = any($1::text[])`,
    [wanted],
  );
  const idBySlug = new Map(cats.map((r) => [r.slug, r.id]));
  const absent = wanted.filter((s) => !idBySlug.has(s));

  if (absent.length) {
    console.log(
      `\nSkipped the children's merchant rules: ${absent.join(", ")} ` +
      "do not exist yet.\nRun `npm run db:migrate" +
      (target === "prod" ? ":prod" : "") + "` to seed the taxonomy, then seed again.",
    );
  } else {
    for (const [name, slug] of Object.entries(KID_RULES)) {
      await client.query(
        `insert into merchant_rules (user_id, match_key, display_name, category_id)
         values ($1, $2, $3, $4)
         on conflict (user_id, match_key)
         do update set category_id = excluded.category_id,
                       display_name = excluded.display_name`,
        [user.id, flat(name), name, idBySlug.get(slug)],
      );
    }
    console.log(`Filed ${Object.keys(KID_RULES).length} children's merchants ` +
                `into ${wanted.length} subcategories.`);
  }

  const months = new Set(rows.map((r) => r.date.slice(0, 7)));
  console.log(
    `Seeded ${rows.length} transactions across ${months.size} months for ${email} on ${target}.\n\n` +
    `  Everyday Checking   ${money(BAL[CHECKING])}\n` +
    `  Savings             ${money(BAL[SAVINGS])}\n` +
    `  Rewards Card        ${money(BAL[CARD])} owed\n\n` +
    `Includes a May holiday every year, a pay rise, a repeating December bonus\n` +
    `and two one-off bills, so the planner has something real to be seen doing.\n` +
    `Refresh on the Banks tab will not work — there is no bank behind this.`,
  );
} finally {
  await client.end();
}

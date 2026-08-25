/**
 * Fills an account on the DEV branch with two years of invented transactions,
 * so somebody can be shown the product without linking a real bank.
 *
 *   npm run demo:seed  -- friend@example.com
 *   npm run demo:clear -- friend@example.com
 *
 * ── Dev only, on purpose ─────────────────────────────────────────────────
 *
 * This reads DATABASE_URL_DEV and has no production path at all. Inventing
 * financial history and writing it into the database real people use is not a
 * thing that should be one mistyped flag away, and a demo is not worth that
 * risk. If it ever needs to run against production, that is a deliberate
 * change to this file made with eyes open, not an argument.
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
import { Client } from "pg";

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const mode = argv.includes("clear") ? "clear" : "seed";
const replace = argv.includes("--replace");
const email = argv.find((a) => a.includes("@"));

if (!email) {
  console.error(
    "Which account? Pass the email address the person signs in with.\n" +
    "  npm run demo:seed -- friend@example.com",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL_DEV;
if (!url) {
  console.error("No DATABASE_URL_DEV in .env. This script only ever touches dev.");
  process.exit(1);
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
      `No account for ${email} on dev.\n` +
      `They need to have signed in there at least once first — the row is created then.`,
    );
    process.exit(1);
  }
  const user = found[0];
  const itemPlaidId = `demo-item-${user.id}`;

  if (mode === "clear") {
    const res = await client.query(
      `delete from items where user_id = $1 and plaid_item_id = $2`,
      [user.id, itemPlaidId],
    );
    console.log(res.rowCount
      ? `Removed the demo bank for ${email}. Its accounts and transactions went with it.`
      : `${email} had no demo data on dev.`);
    process.exit(0);
  }

  const { rows: items } = await client.query(
    `select id, plaid_item_id from items where user_id = $1`, [user.id],
  );
  const already = items.find((i) => i.plaid_item_id === itemPlaidId);
  const real = items.filter((i) => i.plaid_item_id !== itemPlaidId);

  if (real.length && !replace) {
    console.error(
      `${email} already has ${real.length} real bank connection(s) on dev.\n` +
      `Demo data would sit alongside them and muddle every total.\n` +
      `Pass --replace if that is genuinely what you want.`,
    );
    process.exit(1);
  }
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

  /* Batched, rather than a few thousand round trips. */
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [], params = [];
    slice.forEach((r, j) => {
      const b = j * 9;
      values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
      params.push(accountIds[r.account], r.id, String(r.amount), r.date, r.name,
                  r.name, r.primary, r.detailed, JSON.stringify({ demo: true, name: r.name }));
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

  const months = new Set(rows.map((r) => r.date.slice(0, 7)));
  console.log(
    `Seeded ${rows.length} transactions across ${months.size} months for ${email} on dev.\n\n` +
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

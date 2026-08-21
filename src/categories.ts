/**
 * Categories: the buckets spending is sorted into, and how Plaid's guesses map
 * onto them.
 *
 * The list below is seeded into the database as system categories. Users can
 * add their own, and a user category behaves identically once it exists — the
 * only difference is who can edit it.
 *
 * A category is resolved in this order, most specific first:
 *   1. a per-transaction override  — "this one is different"
 *   2. a merchant rule             — "Starbucks is always Coffee"
 *   3. this mapping                — Plaid's guess
 * All three resolve at read time. Plaid owns the transaction rows and a resync
 * overwrites them, so nothing user-owned is ever written into one.
 */

export interface SystemCategory {
  slug: string;
  label: string;
  colour: string;
  sortOrder: number;
}

// Lives in JSON so the seed script — plain Node, no TypeScript — reads the same
// list the Worker does. Two copies would drift the first time one is edited.
// The `with` attribute is required by Node when importing JSON. The Worker
// bundler does not need it, but without it this module cannot be imported by a
// plain script — which is how the category mapping gets tested against real
// data outside the Worker.
import systemCategories from "./db/system-categories.json" with { type: "json" };

/** Deliberately closer to how people describe money than to Plaid's taxonomy. */
export const SYSTEM_CATEGORIES: SystemCategory[] = systemCategories;

export const SYSTEM_SLUGS = new Set(SYSTEM_CATEGORIES.map((c) => c.slug));

/**
 * How a row counts. Transfers matter most: moving your own money between your
 * own accounts is not spending, and counting it inflates both sides of the
 * ledger — a mortgage payment into a linked mortgage account would otherwise
 * read as thousands of pounds of spending every month.
 */
export type Kind = "spend" | "income" | "transfer";

/** Plaid's detailed categories worth splitting out of their primary. */
const BY_DETAILED: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: "groceries",
  FOOD_AND_DRINK_COFFEE: "coffee",
  // Fast food is split out because grabbing something is a different decision,
  // and different money, from sitting down. Restaurants are not: they stay in
  // Dining & Drinks, which is the category that exists to hold them.
  FOOD_AND_DRINK_FAST_FOOD: "fast-food",
  GENERAL_MERCHANDISE_PET_SUPPLIES: "pets",
  RENT_AND_UTILITIES_RENT: "housing",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: "utilities",
  GENERAL_SERVICES_INSURANCE: "insurance",
  GENERAL_SERVICES_EDUCATION: "education",
  GENERAL_SERVICES_CHILDCARE: "kids",
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: "business",
  // Interest you pay is an obligation, not a bank fee — and it is emphatically
  // not the same thing as interest you earn.
  BANK_FEES_INTEREST_CHARGE: "interest-paid",
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: "taxes",
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: "giving",

  // Shopping. Plaid separates where you bought it, which is the split most
  // people actually recognise: a marketplace order and a trip to a superstore
  // do not feel like the same purchase even when they cost the same.
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: "online-shopping",
  GENERAL_MERCHANDISE_SUPERSTORES: "general-stores",
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: "general-stores",
  GENERAL_MERCHANDISE_DISCOUNT_STORES: "general-stores",
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: "general-stores",

  // Entertainment. A subscription is a standing commitment and a night out is
  // a decision, so they are worth seeing apart.
  ENTERTAINMENT_TV_AND_MOVIES: "subscriptions",
  ENTERTAINMENT_MUSIC_AND_AUDIO: "subscriptions",
  ENTERTAINMENT_VIDEO_GAMES: "events",
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: "events",
  ENTERTAINMENT_CASINOS_AND_GAMBLING: "events",

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "gym",

  // Transportation. Plaid has one code for taxis and ride-hailing together, so
  // it goes to the commoner of the two and a genuine cab has to be re-filed —
  // which sets a merchant rule and fixes every later one.
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "rideshare",
  TRAVEL_FLIGHTS: "airlines",
  LOAN_PAYMENTS_CAR_PAYMENT: "car-payment",
};

/**
 * Warehouse clubs, which the taxonomy cannot see.
 *
 * There is no wholesale code in Plaid's list. Costco and Sam's Club arrive as
 * GENERAL_MERCHANDISE_SUPERSTORES, which Plaid documents as "Superstores such
 * as Target and Walmart" — the same code for the membership warehouse and the
 * supermarket. The only thing separating them is the name on the transaction.
 *
 * So this reads the name, but only where Plaid already decided the row was a
 * shop of some kind. Costco sells petrol too, and that arrives under
 * transportation; without the guard a tank of fuel would file itself as a
 * warehouse run. It also keeps BJ's Restaurants out, since a restaurant is
 * categorised as one before the name is ever consulted.
 *
 * "bj s" is the normalised form of "BJ'S" — merchantKey turns punctuation into
 * spaces before any of this is matched.
 */
const WHOLESALE_MERCHANT =
  /\bcostco\b|\bsams? club\b|\bsam s club\b|\bbjs\b|\bbj s\b|\bwholesale\b|\bwarehouse club\b/;

/** Only these guesses are open to being re-read as a warehouse club. */
const WHOLESALE_REFINES = new Set(["general-stores", "groceries", "online-shopping", "other"]);

const BY_PRIMARY: Record<string, string> = {
  FOOD_AND_DRINK: "dining",
  GENERAL_MERCHANDISE: "general-stores",
  ENTERTAINMENT: "events",
  PERSONAL_CARE: "personal",
  HOME_IMPROVEMENT: "housing",
  RENT_AND_UTILITIES: "utilities",
  TRANSPORTATION: "transport",
  TRAVEL: "travel",
  LOAN_PAYMENTS: "loans",
  BANK_FEES: "fees",
  MEDICAL: "health",
  GENERAL_SERVICES: "other",
  GOVERNMENT_AND_NON_PROFIT: "other",
};

const TRANSFER_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

/**
 * Transfers get categories too, but they are still not spending.
 *
 * Moving £2,000 from a current account into a CD is an outflow from that
 * account and no change at all to what you are worth. Counting it as spending
 * would report someone as having spent the money they just saved. Categorising
 * it means it is visible and re-filable rather than silently vanishing, which
 * is what "where did the other £20,000 go" feels like.
 */
/**
 * Whole primaries that are always a transfer, whatever the detail says.
 *
 * LOAN_DISBURSEMENTS is how Plaid labels a payment arriving at a credit card —
 * "Payment Thank You" shows up as a disbursement on the card, money in. Left
 * unmapped it defaulted to spending, and since the amount is negative it was
 * counted as INCOME, inflating both earnings and savings rate. Paying a card is
 * neither: money leaves the current account and lands on the card, and if both
 * are linked it is visible twice. It is a transfer from both directions.
 */
const TRANSFER_PRIMARY_ALWAYS = new Set(["LOAN_DISBURSEMENTS"]);

const TRANSFER_BY_DETAILED: Record<string, string> = {
  // Both halves of a card payment: leaving the current account, and arriving
  // at the card.
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: "card-payment",
  LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT: "card-payment",
  TRANSFER_OUT_SAVINGS: "to-savings",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: "to-investments",
  TRANSFER_OUT_WITHDRAWAL: "withdrawal",
  TRANSFER_OUT_ACCOUNT_TRANSFER: "transfer-other",
  TRANSFER_OUT_OTHER_TRANSFER_OUT: "transfer-other",
  TRANSFER_IN_SAVINGS: "transfer-in",
  TRANSFER_IN_DEPOSIT: "transfer-in",
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: "transfer-in",
  TRANSFER_IN_ACCOUNT_TRANSFER: "transfer-in",
  TRANSFER_IN_CASH_ADVANCES_AND_LOANS: "transfer-in",
  TRANSFER_IN_OTHER_TRANSFER_IN: "transfer-in",
};

/** Money coming in has its own tree — interest earned is not interest paid. */
const INCOME_BY_DETAILED: Record<string, string> = {
  INCOME_WAGES: "salary",
  INCOME_INTEREST_EARNED: "interest-earned",
  INCOME_DIVIDENDS: "dividends",
  INCOME_TAX_REFUND: "refunds",
  INCOME_RETIREMENT_PENSION: "other-income",
  INCOME_UNEMPLOYMENT: "other-income",
  INCOME_OTHER_INCOME: "other-income",
};

export interface Classified {
  kind: Kind;
  /** null only for transfers, which belong on neither side of the ledger. */
  slug: string | null;
}

export function classify(
  primary: string | null,
  detailed: string | null,
  /** The output of merchantKey, not the raw name. Optional: callers that only
   *  have Plaid's codes still get Plaid's answer. */
  merchant?: string,
): Classified {
  if (primary === "INCOME") {
    const slug = (detailed && INCOME_BY_DETAILED[detailed]) || "other-income";
    return { kind: "income", slug };
  }
  if (primary && (TRANSFER_PRIMARY.has(primary) || TRANSFER_PRIMARY_ALWAYS.has(primary))) {
    const slug = (detailed && TRANSFER_BY_DETAILED[detailed])
      || (primary === "TRANSFER_IN" ? "transfer-in"
        : primary === "LOAN_DISBURSEMENTS" ? "card-payment"
        : "transfer-other");
    return { kind: "transfer", slug };
  }

  // A credit card payment seen from the paying account, which Plaid files under
  // LOAN_PAYMENTS rather than as a transfer.
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") {
    return { kind: "transfer", slug: "card-payment" };
  }

  const fromDetailed = detailed ? BY_DETAILED[detailed] : undefined;
  const fromPrimary = primary ? BY_PRIMARY[primary] : undefined;
  // Unmapped, or Plaid told us nothing. "Other" is visible in the UI, so a
  // wrong guess gets noticed and re-filed rather than quietly vanishing.
  const slug = fromDetailed ?? fromPrimary ?? "other";

  if (merchant && WHOLESALE_REFINES.has(slug) && WHOLESALE_MERCHANT.test(merchant)) {
    return { kind: "spend", slug: "wholesale" };
  }
  return { kind: "spend", slug };
}

/**
 * The key a merchant rule matches on.
 *
 * Store numbers and punctuation vary between transactions at the same shop —
 * STARBUCKS #1234, Starbucks Store 9, SQ *STARBUCKS — so they are stripped.
 * Short digit runs are kept, or "7 Eleven" would become "Eleven".
 */
export function merchantKey(merchantName: string | null, name: string): string {
  return (merchantName || name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

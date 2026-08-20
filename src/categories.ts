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
  ENTERTAINMENT_TV_AND_MOVIES: "subscriptions",
  ENTERTAINMENT_MUSIC_AND_AUDIO: "subscriptions",
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "personal",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "transport",
};

const BY_PRIMARY: Record<string, string> = {
  FOOD_AND_DRINK: "dining",
  GENERAL_MERCHANDISE: "shopping",
  ENTERTAINMENT: "entertainment",
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

export function classify(primary: string | null, detailed: string | null): Classified {
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
  if (fromDetailed) return { kind: "spend", slug: fromDetailed };

  const fromPrimary = primary ? BY_PRIMARY[primary] : undefined;
  if (fromPrimary) return { kind: "spend", slug: fromPrimary };

  // Unmapped, or Plaid told us nothing. "Other" is visible in the UI, so a
  // wrong guess gets noticed and re-filed rather than quietly vanishing.
  return { kind: "spend", slug: "other" };
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

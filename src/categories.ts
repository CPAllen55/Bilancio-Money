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
import systemCategories from "./db/system-categories.json";

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
  if (primary && TRANSFER_PRIMARY.has(primary)) return { kind: "transfer", slug: null };

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

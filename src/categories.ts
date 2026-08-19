/**
 * Plaid's categories are not Bilancio's.
 *
 * Plaid returns a Personal Finance Category — a primary like RENT_AND_UTILITIES
 * and a detailed like RENT_AND_UTILITIES_RENT. The dashboard has seven buckets.
 * This is the translation, and it is a product decision rather than a technical
 * one: it decides what a user sees when they open the app.
 *
 * It is deliberately a plain table so it can be argued with. Anything it gets
 * wrong, a user can override per transaction — that is what transaction_overrides
 * is for, and overrides always win.
 */

export const CATEGORIES = [
  { id: "home", label: "Home" },
  { id: "groceries", label: "Groceries" },
  { id: "shopping", label: "Shopping" },
  { id: "dining", label: "Dining" },
  { id: "pets", label: "Pets" },
  { id: "transport", label: "Transport" },
  { id: "bills", label: "Bills" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS: string[] = CATEGORIES.map((c) => c.id);

/**
 * How a row counts. Transfers are the important one: moving your own money
 * between your own accounts is not spending, and counting it inflates both
 * sides of the ledger. A mortgage payment from checking to a linked mortgage
 * account would otherwise appear as $2,000 of "spending" every month.
 */
export type Kind = "spend" | "income" | "transfer";

/** Detailed categories worth splitting out of their primary. */
const BY_DETAILED: Record<string, CategoryId> = {
  FOOD_AND_DRINK_GROCERIES: "groceries",
  GENERAL_MERCHANDISE_PET_SUPPLIES: "pets",
  RENT_AND_UTILITIES_RENT: "home",
  // Everything else under RENT_AND_UTILITIES is gas, water, internet, phone.
};

const BY_PRIMARY: Record<string, CategoryId> = {
  FOOD_AND_DRINK: "dining",
  GENERAL_MERCHANDISE: "shopping",
  ENTERTAINMENT: "shopping",
  PERSONAL_CARE: "shopping",
  HOME_IMPROVEMENT: "home",
  RENT_AND_UTILITIES: "bills",
  TRANSPORTATION: "transport",
  TRAVEL: "transport",
  LOAN_PAYMENTS: "bills",
  BANK_FEES: "bills",
  MEDICAL: "bills",
  GENERAL_SERVICES: "bills",
  GOVERNMENT_AND_NON_PROFIT: "bills",
};

const INCOME_PRIMARY = new Set(["INCOME"]);
const TRANSFER_PRIMARY = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

export interface Classified {
  kind: Kind;
  /** null for income and transfers — they do not belong to a spending bucket. */
  category: CategoryId | null;
}

export function classify(primary: string | null, detailed: string | null): Classified {
  if (primary && INCOME_PRIMARY.has(primary)) return { kind: "income", category: null };
  if (primary && TRANSFER_PRIMARY.has(primary)) return { kind: "transfer", category: null };

  const fromDetailed = detailed ? BY_DETAILED[detailed] : undefined;
  if (fromDetailed) return { kind: "spend", category: fromDetailed };

  const fromPrimary = primary ? BY_PRIMARY[primary] : undefined;
  if (fromPrimary) return { kind: "spend", category: fromPrimary };

  // Unmapped, or Plaid returned nothing. "shopping" is the honest dumping
  // ground: visible in the UI, so a wrong guess gets noticed and corrected,
  // rather than silently vanishing from the totals.
  return { kind: "spend", category: "shopping" };
}

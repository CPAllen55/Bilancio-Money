/**
 * Plaid's personal finance categories -> the seven buckets the dashboard draws,
 * plus "other" for everything that genuinely doesn't fit.
 *
 * Matching is by SUBSTRING, not by exact enum value, on purpose: Plaid revises the
 * taxonomy, and a mapper that hard-codes today's exact strings silently files
 * everything under "other" the day they add a detail level. Substrings survive that.
 * Anything unmatched is logged by `unmappedCategories()` so you can tune the table
 * once you have seen real data.
 */
export const CATEGORIES = ['home', 'groceries', 'shopping', 'dining', 'pets', 'transport', 'bills', 'other'];

// Checked in order; first hit wins. Detailed rules sit above primary ones because
// GROCERIES lives inside FOOD_AND_DRINK and PET_SUPPLIES inside GENERAL_MERCHANDISE.
const RULES = [
  // Order is load-bearing. Specific strings first: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY"
  // contains both RENT and GAS, and would otherwise be filed as rent or as fuel.
  { match: 'RENT_AND_UTILITIES_RENT', category: 'home' },
  { match: 'MORTGAGE',                category: 'home' },

  { match: 'GAS_AND_ELECTRICITY',     category: 'bills' },
  { match: 'WATER',                   category: 'bills' },
  { match: 'SEWAGE',                  category: 'bills' },
  { match: 'INTERNET',                category: 'bills' },
  { match: 'TELEPHONE',               category: 'bills' },
  { match: 'TELECOM',                 category: 'bills' },
  { match: 'UTILITIES',               category: 'bills' },
  { match: 'INSURANCE',               category: 'bills' },
  { match: 'SUBSCRIPTION',            category: 'bills' },
  { match: 'LOAN_PAYMENTS',           category: 'bills' },
  { match: 'BANK_FEES',               category: 'bills' },

  // "_PET" rather than "PET" so CARPET_CLEANING does not become a pet expense.
  { match: '_PET',                    category: 'pets' },
  { match: 'PETS',                    category: 'pets' },
  { match: 'VETERINARY',              category: 'pets' },

  { match: 'GROCER',                  category: 'groceries' },
  { match: 'SUPERMARKET',             category: 'groceries' },

  { match: 'HOME_IMPROVEMENT',        category: 'home' },
  { match: 'FURNITURE',               category: 'home' },
  { match: 'HARDWARE',                category: 'home' },

  { match: 'FOOD_AND_DRINK',          category: 'dining' },
  { match: 'RESTAURANT',              category: 'dining' },
  { match: 'FAST_FOOD',               category: 'dining' },
  { match: 'COFFEE',                  category: 'dining' },

  { match: 'GENERAL_MERCHANDISE',     category: 'shopping' },
  { match: 'CLOTHING',                category: 'shopping' },
  { match: 'ELECTRONICS',             category: 'shopping' },

  { match: 'TRANSPORTATION',          category: 'transport' },
  { match: 'TRAVEL',                  category: 'transport' },
  { match: 'PARKING',                 category: 'transport' },
  { match: 'GAS',                     category: 'transport' },

  // Any other rent-shaped detail, checked last so utilities win the shared prefix.
  { match: 'RENT',                    category: 'home' }
];

const unmapped = new Map();

/** @returns {string} one of CATEGORIES */
export function categorize(personalFinanceCategory){
  if (!personalFinanceCategory) return 'other';
  const detailed = String(personalFinanceCategory.detailed || '').toUpperCase();
  const primary  = String(personalFinanceCategory.primary  || '').toUpperCase();
  for (const haystack of [detailed, primary]){
    if (!haystack) continue;
    const hit = RULES.find(r => haystack.includes(r.match));
    if (hit) return hit.category;
  }
  const key = detailed || primary;
  if (key) unmapped.set(key, (unmapped.get(key) || 0) + 1);
  return 'other';
}

/** Categories seen in real data that no rule covered, most frequent first. */
export function unmappedCategories(){
  return [...unmapped.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
}

/** Money in is not spending, whatever Plaid calls it. */
export function isIncomeCategory(personalFinanceCategory){
  const primary = String(personalFinanceCategory?.primary || '').toUpperCase();
  return primary === 'INCOME' || primary === 'TRANSFER_IN';
}

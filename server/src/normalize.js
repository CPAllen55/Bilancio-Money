import { categorize, isIncomeCategory } from './categories.js';

/**
 * Turn one Plaid transaction into a row this app can store.
 *
 * The sign flip is the part that bites people: Plaid reports money leaving the
 * account as POSITIVE. The dashboard (and every chart built on it) treats income as
 * positive and spending as negative, so the sign is inverted exactly once — here.
 */
export function normalizeTransaction(plaidTx){
  const pfc = plaidTx.personal_finance_category || null;
  const income = isIncomeCategory(pfc);
  return {
    plaidTransactionId: plaidTx.transaction_id,
    plaidAccountId: plaidTx.account_id,
    date: plaidTx.date,                                   // YYYY-MM-DD, already ISO
    name: plaidTx.name || '',
    merchant: plaidTx.merchant_name || plaidTx.name || '',
    amountCents: Math.round(-Number(plaidTx.amount) * 100),
    currency: plaidTx.iso_currency_code || plaidTx.unofficial_currency_code || 'USD',
    pending: plaidTx.pending ? 1 : 0,
    plaidCategory: pfc ? (pfc.detailed || pfc.primary || null) : null,
    // Income has no spending bucket; the dashboard renders it as "Income".
    category: income ? 'income' : categorize(pfc)
  };
}

export function normalizeAccount(plaidAccount){
  const balance = plaidAccount.balances || {};
  const current = balance.current ?? balance.available ?? null;
  return {
    plaidAccountId: plaidAccount.account_id,
    name: plaidAccount.name || '',
    officialName: plaidAccount.official_name || null,
    mask: plaidAccount.mask || null,
    type: plaidAccount.type || null,
    subtype: plaidAccount.subtype || null,
    balanceCents: current == null ? null : Math.round(Number(current) * 100),
    currency: balance.iso_currency_code || 'USD'
  };
}

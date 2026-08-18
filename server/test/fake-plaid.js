import crypto from 'node:crypto';

/**
 * A stand-in for Plaid's API, shaped like the real SDK's responses.
 *
 * It exists because plaid.com is unreachable from CI, but it earns its keep beyond
 * that: it can page, it can fail, and it reports money the way Plaid really does —
 * spending POSITIVE — so the sign-flip stays covered by tests.
 */
export function fakePlaid({ pages = null, accounts = null, failWith = null } = {}){
  const calls = [];
  const defaultAccounts = accounts || [{
    account_id: 'acc_checking', name: 'Plaid Checking', official_name: 'Plaid Gold Checking',
    mask: '0000', type: 'depository', subtype: 'checking',
    balances: { current: 1250.55, available: 1200, iso_currency_code: 'USD' }
  }];
  const defaultPages = pages || [{
    added: [
      tx({ id: 't1', date: '2026-08-02', name: 'Whole Foods Market', amount: 84.21, primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }),
      tx({ id: 't2', date: '2026-08-01', name: 'ACME PAYROLL', amount: -2600.00, primary: 'INCOME', detailed: 'INCOME_WAGES' })
    ],
    modified: [], removed: [], next_cursor: 'cursor-1', has_more: false
  }];
  let pageIndex = 0;

  return {
    calls,
    async linkTokenCreate(request){
      calls.push(['linkTokenCreate', request]);
      return { data: { link_token: 'link-sandbox-' + crypto.randomUUID(), expiration: '2026-08-18T00:00:00Z' } };
    },
    async itemPublicTokenExchange(request){
      calls.push(['itemPublicTokenExchange', request]);
      if (failWith === 'exchange') throw plaidFailure('INVALID_PUBLIC_TOKEN');
      return { data: { access_token: 'access-sandbox-' + crypto.randomUUID(), item_id: 'item-abc' } };
    },
    async accountsGet(request){
      calls.push(['accountsGet', request]);
      return { data: { accounts: defaultAccounts } };
    },
    async transactionsSync(request){
      calls.push(['transactionsSync', request]);
      if (failWith === 'sync') throw plaidFailure('ITEM_LOGIN_REQUIRED');
      const page = defaultPages[Math.min(pageIndex, defaultPages.length - 1)];
      pageIndex++;
      return { data: page };
    },
    async itemRemove(request){
      calls.push(['itemRemove', request]);
      return { data: { removed: true } };
    }
  };
}

/** Plaid's own convention: `amount` is positive when money LEAVES the account. */
export function tx({ id, date, name, amount, primary, detailed, pending = false, account = 'acc_checking', merchant }){
  return {
    transaction_id: id, account_id: account, date, name,
    merchant_name: merchant ?? name, amount, iso_currency_code: 'USD', pending,
    personal_finance_category: primary ? { primary, detailed: detailed || primary } : null
  };
}

function plaidFailure(code){
  return Object.assign(new Error('plaid error'), {
    response: { data: { error_type: 'ITEM_ERROR', error_code: code, error_message: code, request_id: 'req_1' } }
  });
}

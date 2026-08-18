import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

/**
 * The Plaid client. Swappable so tests can run a fake one — Plaid's API is not
 * reachable from CI, and hitting a real sandbox in unit tests would be slow and flaky.
 */
export function createPlaidClient(config){
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[config.plaid.env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': config.plaid.clientId,
        'PLAID-SECRET': config.plaid.secret
      }
    }
  }));
}

/** Plaid errors arrive wrapped in an axios response; this is the part worth logging. */
export function plaidError(err){
  const data = err?.response?.data;
  if (!data) return { error_code: 'NETWORK', error_message: err?.message || String(err) };
  return {
    error_type: data.error_type,
    error_code: data.error_code,
    error_message: data.error_message,
    request_id: data.request_id
  };
}

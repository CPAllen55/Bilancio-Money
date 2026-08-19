/**
 * A thin Plaid client.
 *
 * Plaid's Node SDK targets Node, not Workers, and we need four endpoints — so
 * this is plain fetch instead. Credentials go in the body, which is how Plaid's
 * API expects them; there is no Authorization header.
 */

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class PlaidError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly errorType?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

async function plaidPost<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const host = HOSTS[env.PLAID_ENV] ?? HOSTS.sandbox;

  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body,
    }),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlaidError(`Plaid returned non-JSON from ${path}`, res.status);
  }

  if (!res.ok) {
    // Plaid's error_message is written for developers and is worth keeping;
    // request_id is what their support asks for first.
    throw new PlaidError(
      json.error_message ?? `Plaid ${path} failed`,
      res.status,
      json.error_code,
      json.error_type,
      json.request_id,
    );
  }

  return json as T;
}

/**
 * Short-lived token the browser needs to open Link.
 *
 * redirect_uri is sent only when PLAID_REDIRECT_URI is configured. Plaid
 * rejects /link/token/create outright if the value is not already registered
 * under Developers -> API -> Allowed redirect URIs, so sending a plausible
 * guess breaks linking entirely. It is only needed for banks that use an OAuth
 * hand-off, which none of the sandbox institutions do.
 */
export function createLinkToken(env: Env, clerkUserId: string) {
  return plaidPost<{ link_token: string; expiration: string }>(env, "/link/token/create", {
    user: { client_user_id: clerkUserId },
    client_name: "Bilancio Money",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    ...(env.PLAID_REDIRECT_URI ? { redirect_uri: env.PLAID_REDIRECT_URI } : {}),
  });
}

/** Swaps the browser's short-lived public token for the long-lived access token. */
export function exchangePublicToken(env: Env, publicToken: string) {
  return plaidPost<{ access_token: string; item_id: string }>(
    env,
    "/item/public_token/exchange",
    { public_token: publicToken },
  );
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export function getAccounts(env: Env, accessToken: string) {
  return plaidPost<{ accounts: PlaidAccount[]; item: { institution_id: string | null } }>(
    env,
    "/accounts/get",
    { access_token: accessToken },
  );
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  merchant_entity_id: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  payment_channel: string | null;
  personal_finance_category: { primary: string; detailed: string } | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

/**
 * One page of /transactions/sync. The caller loops on has_more and stores
 * next_cursor, so a resync resumes rather than refetching everything.
 */
export function syncTransactions(env: Env, accessToken: string, cursor: string | null) {
  return plaidPost<SyncPage>(env, "/transactions/sync", {
    access_token: accessToken,
    ...(cursor ? { cursor } : {}),
    count: 500,
  });
}

export function getInstitution(env: Env, institutionId: string) {
  return plaidPost<{ institution: { name: string } }>(env, "/institutions/get_by_id", {
    institution_id: institutionId,
    country_codes: ["US"],
  });
}

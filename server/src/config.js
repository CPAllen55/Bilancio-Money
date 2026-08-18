import 'dotenv/config';

const REQUIRED = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'ENCRYPTION_KEY', 'SESSION_SECRET'];

function readKey(raw){
  // 32 bytes, given as 64 hex chars or base64. Anything else is a configuration error.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32){
    throw new Error('ENCRYPTION_KEY must decode to 32 bytes. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return buf;
}

export function loadConfig(env = process.env){
  const missing = REQUIRED.filter(k => !env[k]);
  if (missing.length){
    throw new Error(
      'Missing required environment variables: ' + missing.join(', ') +
      '\nCopy server/.env.example to server/.env and fill it in — see server/README.md.'
    );
  }
  const plaidEnv = env.PLAID_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(plaidEnv)){
    throw new Error('PLAID_ENV must be "sandbox" or "production" (Plaid retired the development environment).');
  }
  return {
    port: Number(env.PORT || 3000),
    appOrigin: env.APP_ORIGIN || 'http://localhost:3000',
    databaseFile: env.DATABASE_FILE || './data/bilancio.db',
    isProduction: env.NODE_ENV === 'production',
    session: { secret: env.SESSION_SECRET, ttlDays: Number(env.SESSION_TTL_DAYS || 30) },
    encryptionKey: readKey(env.ENCRYPTION_KEY),
    plaid: {
      env: plaidEnv,
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      // Optional. Plaid can only reach a public HTTPS URL, so this stays unset in local dev.
      webhookUrl: env.PLAID_WEBHOOK_URL || undefined,
      // Required only for OAuth banks (Chase, Wells Fargo…), which need a registered redirect.
      redirectUri: env.PLAID_REDIRECT_URI || undefined
    }
  };
}

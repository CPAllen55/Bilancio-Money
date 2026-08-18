import crypto from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

export const testConfig = () => ({
  port: 0,
  appOrigin: 'http://localhost',
  databaseFile: ':memory:',
  isProduction: false,
  session: { secret: 'test-secret', ttlDays: 1 },
  encryptionKey: crypto.randomBytes(32),
  plaid: { env: 'sandbox', clientId: 'test-id', secret: 'test-secret' }
});

/** Boots the real app on a random port against an in-memory db. */
export async function startTestServer(plaid){
  const config = testConfig();
  const db = openDatabase(':memory:');
  const app = createApp({ config, db, plaid });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { config, db, base, close: () => new Promise(r => server.close(r)) };
}

/** fetch that carries the session cookie, like a browser would. */
export function makeClient(base){
  let cookie = null;
  return async function call(method, path, body){
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  };
}

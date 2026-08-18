import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, makeClient } from './helpers.js';
import { fakePlaid, tx } from './fake-plaid.js';

async function signedIn(plaid){
  const server = await startTestServer(plaid);
  const call = makeClient(server.base);
  await call('POST', '/api/auth/signup', { email: 'chris@example.com', password: 'a-long-enough-password' });
  return { ...server, call };
}

test('a bank connection stores an encrypted token and syncs transactions', async (t) => {
  const plaid = fakePlaid();
  const { call, db, config, close } = await signedIn(plaid);
  t.after(close);

  const link = await call('POST', '/api/link/token');
  assert.equal(link.status, 200);
  assert.match(link.body.link_token, /^link-sandbox-/);

  const exchange = await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1', institution: { name: 'Chase' } });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.body.synced.added, 2);

  const row = db.prepare('SELECT access_token_encrypted FROM items').get();
  assert.ok(!row.access_token_encrypted.includes('access-sandbox'), 'the raw access token must never sit in the database');

  const list = await call('GET', '/api/transactions');
  assert.equal(list.body.transactions.length, 2);
  const groceries = list.body.transactions.find(x => x.merchant === 'Whole Foods Market');
  assert.equal(groceries.amount, -84.21, 'spending reaches the dashboard negative');
  assert.equal(groceries.category, 'groceries');
  const pay = list.body.transactions.find(x => x.merchant === 'ACME PAYROLL');
  assert.equal(pay.amount, 2600);
  assert.equal(pay.category, 'income');
});

test('the API is closed to anyone without a session', async (t) => {
  const { base, close } = await startTestServer(fakePlaid());
  t.after(close);
  const anon = makeClient(base);
  for (const [method, path] of [['GET','/api/transactions'], ['POST','/api/link/token'], ['GET','/api/items'], ['POST','/api/sync']]){
    const res = await anon(method, path, method === 'GET' ? undefined : {});
    assert.equal(res.status, 401, `${method} ${path} must require a session`);
  }
});

test('one user cannot see or edit another user\'s transactions', async (t) => {
  const plaid = fakePlaid();
  const { base, call, close } = await signedIn(plaid);
  t.after(close);
  await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });
  const mine = await call('GET', '/api/transactions');
  const victimId = mine.body.transactions[0].id;

  const attacker = makeClient(base);
  await attacker('POST', '/api/auth/signup', { email: 'someone@else.com', password: 'another-long-password' });
  assert.equal((await attacker('GET', '/api/transactions')).body.transactions.length, 0);
  const attempt = await attacker('POST', `/api/transactions/${victimId}/category`, { category: 'pets' });
  assert.equal(attempt.status, 404, 'a transaction belonging to someone else must not be editable');
});

test('a manual category sticks across the next sync', async (t) => {
  const plaid = fakePlaid();
  const { call, close } = await signedIn(plaid);
  t.after(close);
  await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });

  const before = await call('GET', '/api/transactions');
  const target = before.body.transactions.find(x => x.category === 'groceries');
  assert.equal((await call('POST', `/api/transactions/${target.id}/category`, { category: 'home' })).status, 200);

  await call('POST', '/api/sync');   // Plaid resends the same transaction with its own guess
  const after = await call('GET', '/api/transactions');
  const same = after.body.transactions.find(x => x.id === target.id);
  assert.equal(same.category, 'home', 'a sync must never overwrite what the user filed by hand');
  assert.equal(same.categorySource, 'user');
});

test('a merchant rule moves past charges as well as future ones', async (t) => {
  const plaid = fakePlaid({ pages: [{
    added: [
      tx({ id: 'c1', date: '2026-08-01', name: 'Chewy', amount: 40, primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' }),
      tx({ id: 'c2', date: '2026-07-01', name: 'Chewy', amount: 55, primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' })
    ], modified: [], removed: [], next_cursor: 'c', has_more: false
  }]});
  const { call, close } = await signedIn(plaid);
  t.after(close);
  await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });

  const before = await call('GET', '/api/transactions');
  assert.ok(before.body.transactions.every(x => x.category === 'shopping'));

  const rule = await call('POST', '/api/rules', { merchant: 'Chewy', category: 'pets' });
  assert.equal(rule.body.updated, 2, 'both existing Chewy charges should move');
  const after = await call('GET', '/api/transactions');
  assert.ok(after.body.transactions.every(x => x.category === 'pets'));
});

test('sync pages until Plaid says it is done, and removals delete', async (t) => {
  const plaid = fakePlaid({ pages: [
    { added: [tx({ id: 'p1', date: '2026-08-01', name: 'One', amount: 10 })], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    { added: [tx({ id: 'p2', date: '2026-08-02', name: 'Two', amount: 20 })], modified: [], removed: [], next_cursor: 'c2', has_more: true },
    { added: [], modified: [], removed: [{ transaction_id: 'p1' }], next_cursor: 'c3', has_more: false }
  ]});
  const { call, db, close } = await signedIn(plaid);
  t.after(close);
  const exchange = await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });
  assert.equal(exchange.body.synced.pages, 3);
  assert.equal(exchange.body.synced.added, 2);
  assert.equal(exchange.body.synced.removed, 1);

  const remaining = (await call('GET', '/api/transactions')).body.transactions;
  assert.deepEqual(remaining.map(r => r.merchant), ['Two']);
  assert.equal(db.prepare('SELECT cursor FROM items').get().cursor, 'c3', 'the cursor advances only after the last page is written');
});

test('a failing sync marks the connection instead of losing the cursor', async (t) => {
  const plaid = fakePlaid({ failWith: 'sync' });
  const { call, db, close } = await signedIn(plaid);
  t.after(close);
  await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });

  const item = db.prepare('SELECT status, error, cursor FROM items').get();
  assert.equal(item.status, 'error');
  assert.match(item.error, /ITEM_LOGIN_REQUIRED/);
  assert.equal(item.cursor, null);

  const items = (await call('GET', '/api/items')).body.items;
  assert.equal(items[0].error.error_code, 'ITEM_LOGIN_REQUIRED', 'the UI needs to know the bank wants a re-login');
});

test('disconnecting a bank removes it at Plaid and deletes its data', async (t) => {
  const plaid = fakePlaid();
  const { call, db, close } = await signedIn(plaid);
  t.after(close);
  await call('POST', '/api/link/exchange', { public_token: 'public-sandbox-1' });
  const itemId = (await call('GET', '/api/items')).body.items[0].id;

  assert.equal((await call('DELETE', `/api/items/${itemId}`)).status, 200);
  assert.ok(plaid.calls.some(([name]) => name === 'itemRemove'), 'Plaid keeps billing for items you forget to remove');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
});

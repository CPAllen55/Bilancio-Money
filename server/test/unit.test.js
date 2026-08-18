import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encrypt, decrypt } from '../src/crypto.js';
import { categorize, isIncomeCategory, CATEGORIES } from '../src/categories.js';
import { normalizeTransaction, normalizeAccount } from '../src/normalize.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { tx } from './fake-plaid.js';

test('access tokens survive a round trip and refuse to decrypt when tampered with', () => {
  const key = crypto.randomBytes(32);
  const token = 'access-sandbox-1a2b3c';
  const sealed = encrypt(token, key);
  assert.notEqual(sealed, token);
  assert.equal(decrypt(sealed, key), token);
  assert.throws(() => decrypt(sealed, crypto.randomBytes(32)), /unable to authenticate|bad decrypt|unsupported/i);
});

test('categories map Plaid detail before primary, and unknowns land in other', () => {
  assert.equal(categorize({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }), 'groceries');
  assert.equal(categorize({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' }), 'dining');
  assert.equal(categorize({ primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_PET_SUPPLIES' }), 'pets');
  assert.equal(categorize({ primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_CLOTHING' }), 'shopping');
  assert.equal(categorize({ primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_RENT' }), 'home');
  assert.equal(categorize({ primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY' }), 'bills');
  assert.equal(categorize({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES' }), 'transport');
  assert.equal(categorize({ primary: 'MEDICAL', detailed: 'MEDICAL_DENTAL_CARE' }), 'other');
  assert.equal(categorize(null), 'other');
  for (const c of ['home','groceries','shopping','dining','pets','transport','bills','other']){
    assert.ok(CATEGORIES.includes(c));
  }
});

test('a taxonomy Plaid has not invented yet still maps by its primary', () => {
  // The point of substring matching: a new detail level must not break the mapper.
  assert.equal(categorize({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_FAST_FOOD_BREAKFAST_V2' }), 'dining');
  assert.equal(categorize({ primary: 'TRANSPORTATION', detailed: 'SOMETHING_ENTIRELY_NEW' }), 'transport');
});

test('income is not a spending bucket', () => {
  assert.ok(isIncomeCategory({ primary: 'INCOME', detailed: 'INCOME_WAGES' }));
  assert.ok(isIncomeCategory({ primary: 'TRANSFER_IN' }));
  assert.ok(!isIncomeCategory({ primary: 'FOOD_AND_DRINK' }));
});

test('Plaid signs spending positive; we store it negative', () => {
  const spend = normalizeTransaction(tx({ id: 't1', date: '2026-08-02', name: 'Chewy', amount: 42.10,
    primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_PET_SUPPLIES' }));
  assert.equal(spend.amountCents, -4210, 'money out must be negative for the charts');
  assert.equal(spend.category, 'pets');

  const paycheck = normalizeTransaction(tx({ id: 't2', date: '2026-08-01', name: 'ACME PAYROLL', amount: -2600,
    primary: 'INCOME', detailed: 'INCOME_WAGES' }));
  assert.equal(paycheck.amountCents, 260000, 'money in must be positive');
  assert.equal(paycheck.category, 'income');
});

test('amounts stay exact in cents where floats would drift', () => {
  assert.equal(normalizeTransaction(tx({ id: 'a', date: '2026-08-01', name: 'x', amount: 0.1 })).amountCents, -10);
  assert.equal(normalizeTransaction(tx({ id: 'b', date: '2026-08-01', name: 'x', amount: 1234.56 })).amountCents, -123456);
  assert.equal(normalizeTransaction(tx({ id: 'c', date: '2026-08-01', name: 'x', amount: 19.99 })).amountCents, -1999);
});

test('accounts normalize balances and tolerate missing ones', () => {
  const full = normalizeAccount({ account_id: 'a1', name: 'Checking', mask: '1847', type: 'depository',
    subtype: 'checking', balances: { current: 1250.55, iso_currency_code: 'USD' } });
  assert.equal(full.balanceCents, 125055);
  const empty = normalizeAccount({ account_id: 'a2', name: 'Card', balances: {} });
  assert.equal(empty.balanceCents, null);
});

test('passwords hash with a per-user salt and verify in constant time', () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.notEqual(a, b, 'same password must not produce the same hash');
  assert.ok(verifyPassword('correct horse battery', a));
  assert.ok(!verifyPassword('wrong horse battery', a));
});

test('config refuses to start on a bad encryption key or missing vars', () => {
  assert.throws(() => loadConfig({}), /Missing required environment variables/);
  const base = { PLAID_CLIENT_ID: 'x', PLAID_SECRET: 'y', SESSION_SECRET: 'z' };
  assert.throws(() => loadConfig({ ...base, ENCRYPTION_KEY: 'too-short' }), /32 bytes/);
  assert.throws(() => loadConfig({ ...base, ENCRYPTION_KEY: 'a'.repeat(64), PLAID_ENV: 'development' }), /sandbox.*production/);
  const ok = loadConfig({ ...base, ENCRYPTION_KEY: 'a'.repeat(64) });
  assert.equal(ok.plaid.env, 'sandbox');
  assert.equal(ok.encryptionKey.length, 32);
});

test('overlapping Plaid strings do not steal each other\'s bucket', () => {
  // Both of these contain a substring that an earlier rule would otherwise claim.
  assert.equal(categorize({ primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY' }), 'bills');
  assert.equal(categorize({ primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_RENT' }), 'home');
  assert.equal(categorize({ primary: 'HOME_IMPROVEMENT', detailed: 'HOME_IMPROVEMENT_CARPET_CLEANING' }), 'home');
  assert.equal(categorize({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' }), 'transport');
});

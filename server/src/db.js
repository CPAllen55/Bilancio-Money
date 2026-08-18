import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite keeps local development to `npm install && npm start` — no database to run.
 * The schema is deliberately plain SQL so it ports to Postgres when you outgrow one file.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS items (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id          TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  institution_id         TEXT,
  institution_name       TEXT,
  cursor                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'good',
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL UNIQUE,
  name             TEXT,
  official_name    TEXT,
  mask             TEXT,
  type             TEXT,
  subtype          TEXT,
  balance_cents    INTEGER,
  currency         TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(item_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id              TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  plaid_account_id     TEXT NOT NULL,
  plaid_transaction_id TEXT NOT NULL UNIQUE,
  date                 TEXT NOT NULL,
  name                 TEXT,
  merchant             TEXT,
  -- Money is stored in integer cents. Never floats: 0.1 + 0.2 is not 0.3.
  -- Sign follows the dashboard's convention: income positive, spending negative
  -- (Plaid sends the opposite; normalizeTransaction flips it).
  amount_cents         INTEGER NOT NULL,
  currency             TEXT,
  pending              INTEGER NOT NULL DEFAULT 0,
  plaid_category       TEXT,
  category             TEXT NOT NULL,
  category_source      TEXT NOT NULL DEFAULT 'plaid',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);

-- "Always file Chewy under Pets" — the rule the dashboard's toast offers.
CREATE TABLE IF NOT EXISTS category_rules (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant   TEXT NOT NULL,
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, merchant)
);
`;

export function openDatabase(file){
  if (file !== ':memory:'){
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

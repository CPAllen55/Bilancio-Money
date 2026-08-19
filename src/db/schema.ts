import {
  pgTable, uuid, text, timestamp, boolean, bigint, date,
  jsonb, index, pgEnum,
} from "drizzle-orm/pg-core";

export const itemStatus = pgEnum("item_status", [
  "good", "login_required", "pending_expiration", "pending_disconnect", "revoked",
]);

// 1. Users - local mirror of Clerk identity. Everything else hangs off this.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// 1b. Waitlist - people who left an email on the landing page, before any
// account exists. Deliberately not tied to `users`: most rows will never
// become one, and the row must survive the account being deleted.
//
// `userId` is stamped if and when they convert, so "how many of the waitlist
// actually signed up" stays answerable.
export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stored lower-cased so Foo@bar.com and foo@bar.com cannot both take a place.
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Where the address came from, so a second capture point stays distinguishable.
  source: text("source").notNull().default("landing"),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
});

// 2. Items - one row per bank connection. Holds the encrypted Plaid access token.
export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  plaidItemId: text("plaid_item_id").notNull().unique(),
  institutionId: text("institution_id"),
  institutionName: text("institution_name"),

  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  keyVersion: text("key_version").notNull().default("v1"),

  transactionsCursor: text("transactions_cursor"),
  status: itemStatus("status").notNull().default("good"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  consentExpirationTime: timestamp("consent_expiration_time", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("items_user_idx").on(t.userId),
]);

// 3. Accounts - checking, savings, credit cards under an Item.
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  plaidAccountId: text("plaid_account_id").notNull().unique(),
  name: text("name").notNull(),
  officialName: text("official_name"),
  mask: text("mask"),
  type: text("type").notNull(),
  subtype: text("subtype"),

  currentBalance: bigint("current_balance", { mode: "bigint" }),
  availableBalance: bigint("available_balance", { mode: "bigint" }),
  limitAmount: bigint("limit_amount", { mode: "bigint" }),
  isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
  balanceAsOf: timestamp("balance_as_of", { withTimezone: true }),
}, (t) => [
  index("accounts_item_idx").on(t.itemId),
]);

// 4. Transactions - Plaid-owned. Resync overwrites these, so never store user edits here.
export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  plaidTransactionId: text("plaid_transaction_id").notNull().unique(),

  amount: bigint("amount", { mode: "bigint" }).notNull(),
  isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
  date: date("date").notNull(),
  authorizedDate: date("authorized_date"),

  name: text("name").notNull(),
  merchantName: text("merchant_name"),
  merchantEntityId: text("merchant_entity_id"),

  pending: boolean("pending").notNull().default(false),
  pendingTransactionId: text("pending_transaction_id"),
  paymentChannel: text("payment_channel"),

  categoryPrimary: text("category_primary"),
  categoryDetailed: text("category_detailed"),

  raw: jsonb("raw").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tx_account_date_idx").on(t.accountId, t.date),
  index("tx_pending_idx").on(t.pendingTransactionId),
]);

// 5. Overrides - user-owned. Kept separate so a resync cannot erase user edits.
export const transactionOverrides = pgTable("transaction_overrides", {
  transactionId: uuid("transaction_id").primaryKey()
    .references(() => transactions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id"),
  notes: text("notes"),
  tags: text("tags").array(),
  isHidden: boolean("is_hidden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

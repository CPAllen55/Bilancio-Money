import {
  pgTable, uuid, text, timestamp, boolean, bigint, date,
  jsonb, index, uniqueIndex, integer, pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const itemStatus = pgEnum("item_status", [
  "good", "login_required", "pending_expiration", "pending_disconnect", "revoked",
]);

/**
 * What a person is entitled to, and why.
 *
 * Written before there is any billing to enforce it, on purpose. The states
 * are promises made at the moment of invitation — "you get a free month",
 * "you are comped" — and a promise that lives only in the inviter's memory is
 * one nobody can honour eighty users later. Recording it costs a column;
 * reconstructing it from invite dates does not work at all.
 *
 *   trial   the free month. planUntil is when it ends.
 *   active  paying. planUntil is the end of the paid period.
 *   free    comped, permanently. planUntil is null and stays null.
 *   lapsed  was paying or trialling, is not now. Read-only.
 *
 * Nothing sets "lapsed" yet. There is no billing, so nothing can observe a
 * payment failing — it exists so the read-only path can be written and tested
 * before it is ever reachable, rather than added under pressure later.
 */
export const userPlan = pgEnum("user_plan", ["trial", "active", "free", "lapsed"]);

// 1. Users - local mirror of Clerk identity. Everything else hangs off this.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),

  plan: userPlan("plan").notNull().default("trial"),
  /* When the current state runs out. NULL means it does not — which is what a
     comped account looks like, and also what a trial looks like before it has
     started.

     The trial clock starts on the first bank connection, not at sign-up. That
     is the moment the product begins working for somebody; starting it at
     sign-up would spend their free month while they waited for an invitation,
     or while we were still fixing things. See plaid-routes. */
  planUntil: timestamp("plan_until", { withTimezone: true }),
  /* Why this person is on this plan, in a word: "waitlist", "founder",
     "friend". Free-form because the reasons are a business matter and will
     change faster than a migration can keep up. */
  planNote: text("plan_note"),
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
  // The webhook URL Plaid currently has for this item, so registration
  // happens once rather than on every sync, and re-registers if it changes.
  webhookUrl: text("webhook_url"),
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

// 5. Categories - the buckets spending is sorted into.
//
// user_id NULL means a system category, shared by everyone and not editable.
// A row with a user_id is that person's own. Keeping both in one table means a
// category reference is a category reference, wherever it came from.
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  colour: text("colour").notNull().default("#7E90A2"),
  sortOrder: integer("sort_order").notNull().default(500),
  isSystem: boolean("is_system").notNull().default(false),
  // Which side of the ledger. Money coming in belongs in its own tree —
  // "Interest Earned" and "Interest Paid" are different things, and filing one
  // under the other's parent would make every total wrong.
  kind: text("kind").notNull().default("spend"),
  // Two levels, never more: a parent groups leaves, and a leaf is what a
  // transaction is filed under. Deeper trees make every rollup ambiguous —
  // "is this total the node, or the node plus everything under it?"
  parentId: uuid("parent_id").references((): any => categories.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Two partial indexes rather than one on (user_id, slug): Postgres treats
  // NULLs as distinct, so a plain composite index would happily allow twenty
  // system categories all called "coffee".
  uniqueIndex("categories_system_slug_idx").on(t.slug).where(sql`${t.userId} is null`),
  uniqueIndex("categories_user_slug_idx").on(t.userId, t.slug).where(sql`${t.userId} is not null`),
]);

// 6. Merchant rules - "Starbucks is always Coffee".
//
// Applied when reading, never by rewriting transactions: Plaid owns those rows
// and a resync overwrites them. Storing the intent instead means one rule keeps
// working for every future Starbucks without a backfill.
export const merchantRules = pgTable("merchant_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Normalised merchant name - lower-cased, stripped of store numbers and
  // punctuation - so STARBUCKS #1234 and Starbucks Store 9 land on one rule.
  matchKey: text("match_key").notNull(),
  // What the user saw when they made the rule, for showing it back to them.
  displayName: text("display_name").notNull(),
  categoryId: uuid("category_id").notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_rules_user_key_idx").on(t.userId, t.matchKey),
]);

// 7. Overrides - user-owned, and the last word. Kept separate so a resync
// cannot erase user edits, and beats a merchant rule for that one transaction.
export const transactionOverrides = pgTable("transaction_overrides", {
  transactionId: uuid("transaction_id").primaryKey()
    .references(() => transactions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  notes: text("notes"),
  tags: text("tags").array(),
  isHidden: boolean("is_hidden").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 9. Budget plans - how each category's budget is arrived at.
//
// One row per category the user has expressed an opinion about. No row means
// "inherit": from the parent if it has one, otherwise from the default. So the
// table stays small - a handful of rows, not one per category - and adding a
// category later does not need backfilling.
//
// `method` is resolved per category at read time, exactly like categories
// themselves. `manualAmount` is cents per month and only read when the method
// is "manual"; it is kept when switching away so flipping back does not lose
// the number that was typed.
export const budgetPlans = pgTable("budget_plans", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  method: text("method").notNull().default("average"),
  manualAmount: bigint("manual_amount", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("budget_plans_user_category_idx").on(t.userId, t.categoryId),
]);

// 12b. Budget plans, second attempt — deliberately a separate table.
//
// Budgeting v2 is being worked out in the open while the original stays in
// service, so the two cannot share storage: anything configured here must not
// reach the Tracker, the Overview tiles or the Trend budget until the shape is
// settled and adopted. A separate table is the only silo that cannot leak by
// accident. Nothing outside budget-v2-routes reads it, and dropping it drops
// the experiment whole.
//
// manualByMonth is the one thing v1 has no room for: a manual budget per month
// rather than one figure repeated. Keyed "YYYY-MM" to cents. manualAmount stays
// as the fallback for months not named in it, so switching to manual gives a
// sensible starting figure everywhere rather than a grid of zeroes.
export const budgetPlansV2 = pgTable("budget_plans_v2", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  method: text("method").notNull().default("average"),
  manualAmount: bigint("manual_amount", { mode: "number" }).notNull().default(0),
  manualByMonth: jsonb("manual_by_month").$type<Record<string, number>>()
    .notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("budget_plans_v2_user_category_idx").on(t.userId, t.categoryId),
]);

/* ------------------------------------------------------------- 12. metals -- */

/**
 * Precious metals held outside any bank.
 *
 * Plaid cannot see a safe, so this is the one balance the app has to be told.
 * One row per user per metal — an upsert on that pair rather than an append,
 * because "how much gold do you own" has one answer at a time.
 *
 * Ounces are stored as an integer of ten-thousandths. A tenth of an ounce is a
 * real holding and 0.1 is not representable in binary floating point; the rest
 * of this schema already counts money in whole cents for the same reason, and a
 * balance sheet that drifts by a hundredth of an ounce a year is worse than one
 * that cannot express a gram.
 */
export const metalHoldings = pgTable("metal_holdings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // gold | silver | platinum | palladium
  metal: text("metal").notNull(),
  ouncesE4: bigint("ounces_e4", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("metal_holdings_user_metal_idx").on(t.userId, t.metal),
]);

/**
 * The daily close per troy ounce, in cents.
 *
 * Not per user: a price is a fact about the world, so one fetch serves
 * everybody and the table is a cache rather than user data. Two years of daily
 * closes arrive in a single request per metal, which is the same window the
 * transactions reach — so a holding can be valued at what it was actually worth
 * each month rather than carried flat at today's price.
 */
export const metalPrices = pgTable("metal_prices", {
  metal: text("metal").notNull(),
  date: date("date").notNull(),
  usdPerOunce: bigint("usd_per_ounce", { mode: "bigint" }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("metal_prices_metal_date_idx").on(t.metal, t.date),
]);

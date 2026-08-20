/**
 * Lists linked banks, and removes one.
 *
 *   npm run unlink              # list production
 *   npm run unlink:dev          # list dev
 *   node scripts/unlink.mjs prod <item-id>    # remove that item
 *
 * Deliberately requires an explicit item id. There is no "remove everything"
 * switch: this deletes real financial history, and the safe version of that is
 * one where you have to name what you mean.
 *
 * Accounts and transactions go with the item via ON DELETE CASCADE, and any
 * overrides on those transactions go with them. Categories and merchant rules
 * survive — they are yours, not the bank's.
 *
 * This does NOT tell Plaid to forget the item. Removing it here stops Bilancio
 * holding the data; /item/remove would revoke the token at Plaid too, and
 * belongs in the disconnect button this script stands in for.
 */
import "dotenv/config";
import { Client } from "pg";

const target = (process.argv[2] ?? "prod").toLowerCase();
const itemId = process.argv[3];
const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;

if (!url) {
  console.error(`No connection string for target "${target}". Check .env.`);
  process.exit(1);
}

const c = new Client({ connectionString: url });
await c.connect();

try {
  const { rows: items } = await c.query(`
    select i.id, i.institution_name, i.status, i.created_at, i.last_synced_at,
           (select count(*)::int from accounts a where a.item_id = i.id) accounts,
           (select count(*)::int from transactions t
              join accounts a on a.id = t.account_id where a.item_id = i.id) transactions
    from items i
    order by i.created_at
  `);

  if (!items.length) {
    console.log(`No linked banks on ${target}.`);
    process.exit(0);
  }

  if (!itemId) {
    console.log(`Linked banks on ${target}:\n`);
    for (const i of items) {
      console.log(`  ${i.id}`);
      console.log(`    ${i.institution_name ?? "(unnamed)"}  status=${i.status}`);
      console.log(`    ${i.accounts} accounts, ${i.transactions} transactions`);
      console.log(`    linked ${i.created_at.toISOString().slice(0, 16).replace("T", " ")}, ` +
                  `last synced ${i.last_synced_at ? i.last_synced_at.toISOString().slice(0, 16).replace("T", " ") : "never"}\n`);
    }
    console.log(`To remove one:\n  node scripts/unlink.mjs ${target} <item-id>`);
    process.exit(0);
  }

  const found = items.find((i) => i.id === itemId);
  if (!found) {
    console.error(`No item ${itemId} on ${target}. Run without an id to list them.`);
    process.exit(1);
  }

  console.log(`Removing from ${target}:`);
  console.log(`  ${found.institution_name ?? "(unnamed)"} — ${found.accounts} accounts, ${found.transactions} transactions`);

  const { rowCount } = await c.query("delete from items where id = $1", [itemId]);
  console.log(`\nDeleted ${rowCount} item and everything under it.`);

  const left = (await c.query("select count(*)::int n from transactions")).rows[0].n;
  const items2 = (await c.query("select count(*)::int n from items")).rows[0].n;
  console.log(`${target} now holds ${items2} item(s) and ${left} transactions.`);
} finally {
  await c.end();
}

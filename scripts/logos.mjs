/**
 * Which merchants in the ledger carry a Plaid logo, and what it is called.
 *
 *   npm run logos        the dev branch
 *   npm run logos:prod   production
 *
 * Written because the filenames cannot be guessed. Plaid's CDN serves
 * walmart_1100.png and nothing else that looks like it — the suffix is an
 * internal merchant id, not a pattern — so the only way to know what a logo is
 * called is to find one that has already arrived on a real transaction.
 *
 * Prints brand names and image filenames. Nothing about amounts, dates or
 * accounts, so the output is safe to paste into an issue or a chat.
 */
import "dotenv/config";
import { Client } from "pg";

const target = (process.argv[2] ?? "dev").toLowerCase();
const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!url) {
  console.error(`No connection string for target "${target}". Check .env.`);
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

try {
  const { rows } = await client.query(`
    select distinct
           coalesce(merchant_name, name) as merchant,
           replace(raw->>'logo_url',
                   'https://plaid-merchant-logos.plaid.com/', '') as logo_file
    from transactions
    where raw->>'logo_url' is not null
    order by 1
  `);

  if (!rows.length) {
    console.log(`\nNo transactions on ${target} carry a logo_url.`);
    console.log("Either no bank has been linked there, or Plaid returned none.\n");
    process.exit(0);
  }

  console.log(`\n${rows.length} merchant(s) with a logo on ${target}:\n`);
  const width = Math.max(...rows.map((r) => String(r.merchant).length));
  for (const r of rows) {
    console.log("  " + String(r.merchant).padEnd(width + 2) + r.logo_file);
  }
  console.log("");
} finally {
  await client.end();
}

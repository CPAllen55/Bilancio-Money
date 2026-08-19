/**
 * Lists the waitlist for a Neon branch (dev | prod).
 * Defaults to prod, because that is the one with real people on it.
 *
 *   npm run waitlist          # production
 *   npm run waitlist:dev      # dev branch
 */
import "dotenv/config";
import { Client } from "pg";

// Argument first, env second. `TARGET=x cmd` does not work in PowerShell, so
// the npm scripts pass the branch as an argument instead.
const target = (process.argv[2] ?? process.env.TARGET ?? "prod").toLowerCase();
const url = target === "prod" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!url) {
  console.error(`No connection string for target "${target}". Check .env.`);
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(`
    select w.email, w.source, w.created_at, w.invited_at, u.email as account_email
    from waitlist w
    left join users u on u.id = w.user_id
    order by w.created_at
  `);

  if (rows.length === 0) {
    console.log(`No one on the ${target} waitlist yet.`);
  } else {
    console.log(`${rows.length} on the ${target} waitlist:\n`);
    for (const [i, r] of rows.entries()) {
      const when = r.created_at.toISOString().replace("T", " ").slice(0, 16);
      const state = r.account_email ? "signed up" : r.invited_at ? "invited" : "waiting";
      console.log(`  ${String(i + 1).padStart(3)}. ${r.email.padEnd(38)} ${when}  ${state}`);
    }
    const waiting = rows.filter((r) => !r.invited_at && !r.account_email).length;
    console.log(`\n  ${waiting} not yet invited.`);
  }
} finally {
  await client.end();
}

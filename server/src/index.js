import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createPlaidClient } from './plaid.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.databaseFile);
const plaid = createPlaidClient(config);
const app = createApp({ config, db, plaid });

app.listen(config.port, () => {
  console.log(`Bilancio API on http://localhost:${config.port}  (Plaid ${config.plaid.env})`);
  if (!config.plaid.webhookUrl){
    console.log('No PLAID_WEBHOOK_URL set — new transactions arrive on POST /api/sync, not automatically.');
  }
});

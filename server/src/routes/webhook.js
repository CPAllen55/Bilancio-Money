import express from 'express';
import { syncItem } from '../sync.js';

/**
 * Plaid calls this when an item has new transactions.
 *
 * Security note, deliberately conservative: nothing in the request body is trusted or
 * stored. The body is used only to look up which of OUR items to re-sync, and the sync
 * itself runs against our own encrypted access token. So the worst a forged webhook can
 * do is make us call Plaid again.
 *
 * Before production, add Plaid's JWT verification (/webhook_verification_key/get) so
 * forged calls are rejected outright rather than merely made harmless.
 */
export function webhookRoutes(config, plaid){
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { webhook_type: type, webhook_code: code, item_id: plaidItemId } = req.body || {};
    // Answer immediately — Plaid retries on slow responses, and syncing can take a while.
    res.json({ received: true });

    if (type !== 'TRANSACTIONS' || !plaidItemId) return;
    const item = req.db.prepare('SELECT * FROM items WHERE plaid_item_id = ?').get(plaidItemId);
    if (!item) return;

    try {
      const result = await syncItem({ db: req.db, plaid, config, item });
      console.log('webhook sync', { code, item: item.id, ...result });
    } catch (err){
      console.error('webhook sync failed', { code, item: item.id, error: err.detail || err.message });
    }
  });

  return router;
}

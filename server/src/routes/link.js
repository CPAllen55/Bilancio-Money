import express from 'express';
import { newId, encrypt } from '../crypto.js';
import { nowIso } from '../db.js';
import { requireUser } from '../auth.js';
import { plaidError } from '../plaid.js';
import { syncItem, syncAccounts } from '../sync.js';

/**
 * The two halves of connecting a bank.
 *
 * 1. /token  — the server mints a short-lived link_token. Plaid Link (in the browser)
 *              needs one to open. The client id and secret never leave the server.
 * 2. /exchange — Link hands the browser a public_token, good for one swap. The server
 *              trades it for the long-lived access_token, which is encrypted and stored.
 *              The access token must never be sent to the browser.
 */
export function linkRoutes(config, plaid){
  const router = express.Router();

  router.post('/token', requireUser, async (req, res) => {
    try {
      const request = {
        user: { client_user_id: req.user.id },
        client_name: 'Bilancio Money',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en'
      };
      if (config.plaid.webhookUrl) request.webhook = config.plaid.webhookUrl;
      if (config.plaid.redirectUri) request.redirect_uri = config.plaid.redirectUri;
      const response = await plaid.linkTokenCreate(request);
      res.json({ link_token: response.data.link_token, expiration: response.data.expiration });
    } catch (err){
      const detail = plaidError(err);
      console.error('linkTokenCreate failed', detail);
      res.status(502).json({ error: 'Could not start a bank connection.', detail });
    }
  });

  router.post('/exchange', requireUser, async (req, res) => {
    const publicToken = req.body?.public_token;
    if (!publicToken) return res.status(400).json({ error: 'public_token is required.' });
    try {
      const exchanged = await plaid.itemPublicTokenExchange({ public_token: publicToken });
      const accessToken = exchanged.data.access_token;
      const plaidItemId = exchanged.data.item_id;

      const institution = req.body?.institution || {};
      const item = {
        id: newId('itm'),
        user_id: req.user.id,
        plaid_item_id: plaidItemId,
        access_token_encrypted: encrypt(accessToken, config.encryptionKey),
        institution_id: institution.institution_id || null,
        institution_name: institution.name || null,
        cursor: null,
        status: 'good',
        error: null,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      req.db.prepare(`INSERT INTO items (id, user_id, plaid_item_id, access_token_encrypted, institution_id,
          institution_name, cursor, status, error, created_at, updated_at)
        VALUES (@id, @user_id, @plaid_item_id, @access_token_encrypted, @institution_id,
          @institution_name, @cursor, @status, @error, @created_at, @updated_at)`).run(item);

      // First sync inline so the dashboard has data the moment Link closes. A real
      // account's first sync can take a while; move this to a job queue when it hurts.
      let synced = null;
      try {
        await syncAccounts({ db: req.db, plaid, config, item });
        synced = await syncItem({ db: req.db, plaid, config, item });
      } catch (err){
        console.error('initial sync failed', err.detail || err.message);
      }
      res.json({ item_id: item.id, institution: item.institution_name, synced });
    } catch (err){
      const detail = plaidError(err);
      console.error('itemPublicTokenExchange failed', detail);
      res.status(502).json({ error: 'Could not finish connecting that bank.', detail });
    }
  });

  return router;
}

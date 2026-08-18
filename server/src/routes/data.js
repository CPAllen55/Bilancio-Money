import express from 'express';
import { newId, decrypt } from '../crypto.js';
import { nowIso } from '../db.js';
import { requireUser } from '../auth.js';
import { CATEGORIES } from '../categories.js';
import { syncItem, syncAccounts } from '../sync.js';
import { plaidError } from '../plaid.js';

export function dataRoutes(config, plaid){
  const router = express.Router();
  router.use(requireUser);

  /** Connected banks, with the account list the filter row needs. */
  router.get('/items', (req, res) => {
    const items = req.db.prepare(
      'SELECT id, institution_name, status, error, updated_at FROM items WHERE user_id = ? ORDER BY created_at'
    ).all(req.user.id);
    for (const item of items){
      item.accounts = req.db.prepare(
        'SELECT plaid_account_id AS id, name, mask, type, subtype, balance_cents FROM accounts WHERE item_id = ?'
      ).all(item.id);
      if (item.error) item.error = JSON.parse(item.error);
    }
    res.json({ items });
  });

  /** Disconnect a bank: tell Plaid to stop billing for it, then drop the local data. */
  router.delete('/items/:id', async (req, res) => {
    const item = req.db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!item) return res.status(404).json({ error: 'No such connection.' });
    try {
      await plaid.itemRemove({ access_token: decrypt(item.access_token_encrypted, config.encryptionKey) });
    } catch (err){
      // Removing it at Plaid can fail (already gone, network); the user still asked us
      // to forget it, so local deletion proceeds either way.
      console.error('itemRemove failed', plaidError(err));
    }
    req.db.prepare('DELETE FROM items WHERE id = ?').run(item.id);   // cascades to accounts + transactions
    res.json({ ok: true });
  });

  /** Pull anything new for every connected bank. */
  router.post('/sync', async (req, res) => {
    const items = req.db.prepare('SELECT * FROM items WHERE user_id = ?').all(req.user.id);
    const results = [];
    for (const item of items){
      try {
        await syncAccounts({ db: req.db, plaid, config, item });
        results.push({ item: item.id, ...(await syncItem({ db: req.db, plaid, config, item })) });
      } catch (err){
        results.push({ item: item.id, error: err.detail || err.message });
      }
    }
    res.json({ results });
  });

  /**
   * The dashboard's feed. Shape matches what the charts already expect:
   * amount as a signed number (income positive), one effective category per row.
   */
  router.get('/transactions', (req, res) => {
    const { start, end } = req.query;
    const clauses = ['t.user_id = ?'], params = [req.user.id];
    if (start){ clauses.push('t.date >= ?'); params.push(String(start)); }
    if (end){ clauses.push('t.date <= ?'); params.push(String(end)); }

    const rows = req.db.prepare(
      `SELECT t.id, t.date, t.merchant, t.name, t.amount_cents, t.currency, t.pending,
              t.category, t.category_source, t.plaid_account_id,
              a.name AS account_name, a.mask AS account_mask
         FROM transactions t
         LEFT JOIN accounts a ON a.plaid_account_id = t.plaid_account_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY t.date DESC, t.id DESC`
    ).all(...params);

    res.json({
      transactions: rows.map(r => ({
        id: r.id,
        date: r.date,
        merchant: r.merchant || r.name,
        amount: r.amount_cents / 100,
        currency: r.currency,
        pending: Boolean(r.pending),
        category: r.category,
        categorySource: r.category_source,
        account: r.plaid_account_id,
        accountLabel: r.account_name ? r.account_name + (r.account_mask ? ' ••' + r.account_mask : '') : 'Account'
      }))
    });
  });

  /** Re-file one charge. This is what the dashboard's category menu calls. */
  router.post('/transactions/:id/category', (req, res) => {
    const category = String(req.body?.category || '');
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category.' });
    const result = req.db.prepare(
      `UPDATE transactions SET category = ?, category_source = 'user', updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(category, nowIso(), req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'No such transaction.' });
    res.json({ ok: true });
  });

  /** "Always file Chewy under Pets" — applies to what is already stored and to future syncs. */
  router.post('/rules', (req, res) => {
    const merchant = String(req.body?.merchant || '').trim();
    const category = String(req.body?.category || '');
    if (!merchant) return res.status(400).json({ error: 'merchant is required.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category.' });

    const apply = req.db.transaction(() => {
      req.db.prepare(
        `INSERT INTO category_rules (id, user_id, merchant, category, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category`
      ).run(newId('rul'), req.user.id, merchant, category, nowIso());
      // Past charges move too — a rule the user reads as "always" should not mean "from now on".
      return req.db.prepare(
        `UPDATE transactions SET category = ?, category_source = 'rule', updated_at = ?
          WHERE user_id = ? AND merchant = ? AND category != 'income'`
      ).run(category, nowIso(), req.user.id, merchant).changes;
    });
    res.json({ ok: true, updated: apply() });
  });

  router.get('/rules', (req, res) => {
    res.json({ rules: req.db.prepare('SELECT merchant, category FROM category_rules WHERE user_id = ?').all(req.user.id) });
  });

  router.delete('/rules/:merchant', (req, res) => {
    req.db.prepare('DELETE FROM category_rules WHERE user_id = ? AND merchant = ?').run(req.user.id, req.params.merchant);
    res.json({ ok: true });
  });

  return router;
}

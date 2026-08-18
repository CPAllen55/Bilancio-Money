import { newId, decrypt } from './crypto.js';
import { nowIso } from './db.js';
import { normalizeTransaction, normalizeAccount } from './normalize.js';
import { plaidError } from './plaid.js';

/**
 * Pull everything new for one item using Plaid's /transactions/sync cursor.
 *
 * Cursor semantics that matter:
 *  - The cursor is saved ONLY after the whole page set is written. If we crash
 *    mid-run, the next run replays from the last good cursor: duplicate work,
 *    never lost transactions. (The reverse ordering would lose them silently.)
 *  - `has_more` pages until false; a first sync of a real account is many pages.
 *  - `removed` means the bank retracted a transaction — usually a pending one that
 *    settled into a different id. Deleting it is correct.
 */
export async function syncItem({ db, plaid, config, item }){
  const accessToken = decrypt(item.access_token_encrypted, config.encryptionKey);
  let cursor = item.cursor || undefined;
  let added = 0, modified = 0, removed = 0, pages = 0;

  try {
    for (;;){
      const res = await plaid.transactionsSync({ access_token: accessToken, cursor });
      const data = res.data;
      pages++;

      const write = db.transaction(() => {
        for (const tx of data.added || []){ upsertTransaction(db, item, tx); added++; }
        for (const tx of data.modified || []){ upsertTransaction(db, item, tx); modified++; }
        for (const gone of data.removed || []){
          db.prepare('DELETE FROM transactions WHERE plaid_transaction_id = ?').run(gone.transaction_id);
          removed++;
        }
      });
      write();

      cursor = data.next_cursor;
      if (!data.has_more) break;
      if (pages > 500) throw new Error('transactions/sync did not stop paging — aborting to avoid a runaway loop');
    }

    db.prepare('UPDATE items SET cursor = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?')
      .run(cursor, 'good', nowIso(), item.id);

    return { added, modified, removed, pages };
  } catch (err){
    const detail = plaidError(err);
    db.prepare('UPDATE items SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('error', JSON.stringify(detail), nowIso(), item.id);
    throw Object.assign(new Error('Plaid sync failed: ' + (detail.error_code || detail.error_message)), { detail });
  }
}

function upsertTransaction(db, item, plaidTx){
  const t = normalizeTransaction(plaidTx);
  const rule = db.prepare('SELECT category FROM category_rules WHERE user_id = ? AND merchant = ?')
    .get(item.user_id, t.merchant);
  const existing = db.prepare('SELECT id, category, category_source FROM transactions WHERE plaid_transaction_id = ?')
    .get(t.plaidTransactionId);

  // Precedence: a category the user set by hand wins over a merchant rule,
  // which wins over whatever Plaid guessed. Re-syncing must never undo an edit.
  let category = t.category, source = 'plaid';
  if (rule && t.category !== 'income'){ category = rule.category; source = 'rule'; }
  if (existing?.category_source === 'user'){ category = existing.category; source = 'user'; }

  if (existing){
    db.prepare(`UPDATE transactions SET date=@date, name=@name, merchant=@merchant, amount_cents=@amountCents,
      currency=@currency, pending=@pending, plaid_category=@plaidCategory, category=@category,
      category_source=@source, updated_at=@updatedAt WHERE id=@id`)
      .run({ ...t, category, source, updatedAt: nowIso(), id: existing.id });
    return;
  }
  db.prepare(`INSERT INTO transactions
      (id, user_id, item_id, plaid_account_id, plaid_transaction_id, date, name, merchant, amount_cents,
       currency, pending, plaid_category, category, category_source, created_at, updated_at)
    VALUES (@id, @userId, @itemId, @plaidAccountId, @plaidTransactionId, @date, @name, @merchant, @amountCents,
       @currency, @pending, @plaidCategory, @category, @source, @createdAt, @createdAt)`)
    .run({ ...t, id: newId('txn'), userId: item.user_id, itemId: item.id, category, source, createdAt: nowIso() });
}

/** Account names and balances, refreshed alongside a sync. */
export async function syncAccounts({ db, plaid, config, item }){
  const accessToken = decrypt(item.access_token_encrypted, config.encryptionKey);
  const res = await plaid.accountsGet({ access_token: accessToken });
  const write = db.transaction(() => {
    for (const raw of res.data.accounts || []){
      const a = normalizeAccount(raw);
      const existing = db.prepare('SELECT id FROM accounts WHERE plaid_account_id = ?').get(a.plaidAccountId);
      if (existing){
        db.prepare(`UPDATE accounts SET name=@name, official_name=@officialName, mask=@mask, type=@type,
          subtype=@subtype, balance_cents=@balanceCents, currency=@currency, updated_at=@updatedAt WHERE id=@id`)
          .run({ ...a, updatedAt: nowIso(), id: existing.id });
      } else {
        db.prepare(`INSERT INTO accounts (id, item_id, plaid_account_id, name, official_name, mask, type, subtype,
          balance_cents, currency, updated_at)
          VALUES (@id, @itemId, @plaidAccountId, @name, @officialName, @mask, @type, @subtype,
          @balanceCents, @currency, @updatedAt)`)
          .run({ ...a, id: newId('acc'), itemId: item.id, updatedAt: nowIso() });
      }
    }
  });
  write();
  return (res.data.accounts || []).length;
}

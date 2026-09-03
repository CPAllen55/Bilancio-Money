/**
 * Dividing one transaction between categories.
 *
 * ── What a split is ─────────────────────────────────────────────────────────
 *
 * A merchant rule says where Central Market goes: Groceries, every time. That
 * is right for the merchant and wrong for the visit where a third of the
 * trolley was a birthday present. A split carves that third off without
 * arguing with the rule — the rule still governs the merchant, and this one
 * visit is divided.
 *
 * ── Only the carved-off parts are stored ────────────────────────────────────
 *
 * The remainder is computed here, never written. A $388.01 shop with a $50
 * split to Gifts is one stored row, and the $338.01 left over stays wherever
 * the merchant rule put it. Storing both halves would mean two numbers that
 * have to agree, and two numbers that have to agree eventually do not.
 *
 * Reclassifying the whole transaction is the same mechanism with the full
 * amount: the remainder becomes zero and the original category simply drops
 * out. There is no second concept for "move all of it".
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * The parts always sum to the transaction. Not approximately — exactly, in
 * cents, with no rounding anywhere. That is the one property that makes splits
 * safe to feed into totals: whatever else changes, the sum of what a
 * transaction contributes to every category is the transaction.
 *
 * Everything works in Plaid's convention, the same as transactions.amount:
 * POSITIVE means money leaving. The same as the column being carved from, so
 * nothing here flips a sign.
 */

/** One stored part: some of a transaction, filed under another category. */
export interface Split {
  categoryId: string;
  cents: number;
}

/** What a transaction contributes to one category. */
export interface Part {
  /** null means the remainder, which keeps whatever the row itself resolved to. */
  categoryId: string | null;
  cents: number;
}

/**
 * Split the transaction into the parts that should be counted.
 *
 * The remainder comes first and is omitted when it is zero — a transaction
 * moved wholesale should contribute nothing to the category it came from, not
 * a zero that still makes it appear in a list.
 *
 * A split larger than the transaction is not rejected here. This function
 * reports what is stored; refusing bad input is the write path's job, and a
 * reader that throws would take out a whole dashboard because one row is odd.
 * The remainder simply goes negative, the sum still holds, and the figure
 * looks wrong in a way somebody can see and fix.
 */
export function partsOf(amountCents: number, splits: Split[]): Part[] {
  const parts: Part[] = [];
  let carved = 0;
  for (const s of splits) {
    if (!s.cents) continue;          // a zero split is not a fact about anything
    carved += s.cents;
    parts.push({ categoryId: s.categoryId, cents: s.cents });
  }
  const remainder = amountCents - carved;
  if (remainder !== 0) parts.unshift({ categoryId: null, cents: remainder });
  return parts;
}

/** What is left to allocate. Zero means the transaction is fully divided. */
export function remainderOf(amountCents: number, splits: Split[]): number {
  return amountCents - splits.reduce((n, s) => n + s.cents, 0);
}

/**
 * Whether a proposed set of splits may be saved.
 *
 * Two rules, both of them about the invariant above:
 *
 *   - No part may exceed the transaction, in either direction. Splitting $388
 *     into $500 is not a distribution, it is a typo, and storing it would put
 *     a number in the totals that never left anybody's account.
 *   - Every part carries the transaction's own sign. Carving an inbound $50
 *     out of an outbound $388 would make the parts sum to $438 of spending
 *     against a $388 charge — the arithmetic holds and the meaning does not.
 *
 * Zero-value splits are allowed through and dropped on the way in: an empty
 * input box is somebody clearing a row, not an error to argue about.
 */
export function checkSplits(
  amountCents: number,
  splits: Split[],
): { ok: true } | { ok: false; reason: string } {
  if (!amountCents) return { ok: false, reason: "a zero transaction cannot be split" };

  const sign = Math.sign(amountCents);
  let carved = 0;

  for (const s of splits) {
    if (!s.cents) continue;
    if (Math.sign(s.cents) !== sign) {
      return { ok: false, reason: "every part must be the same direction as the transaction" };
    }
    carved += s.cents;
  }

  if (Math.abs(carved) > Math.abs(amountCents)) {
    return { ok: false, reason: "the parts add up to more than the transaction" };
  }
  return { ok: true };
}

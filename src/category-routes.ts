/**
 * /api/categories, re-filing a transaction, and dividing one between
 * categories.
 *
 * Two things happen when someone re-files a transaction:
 *   - an override is written for that transaction, and
 *   - optionally a merchant rule, so every future Starbucks lands in Coffee.
 *
 * Both are stored beside the Plaid data, never inside it. A resync rewrites
 * transaction rows wholesale, so anything user-owned that lived there would be
 * silently destroyed the next time the bank was polled.
 */

import { Hono } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  categories, merchantRules, transactionOverrides, transactionSplits, transactions,
  accounts, items,
} from "./db/schema";
import { requireUser } from "./auth";
import { loadCategories } from "./summary-routes";
import { merchantKey } from "./categories";
import { checkSplits, remainderOf, type Split } from "./splits";

const cats = new Hono<{ Bindings: Env }>();

/** Slugs are for code and URLs; the label is what a person typed. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/* -------------------------------------------------------------- list/create -- */

cats.get("/categories", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const ctx = await loadCategories(db, auth.user.id);
    return c.json({ ok: true, categories: ctx.list });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

cats.post("/categories", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    let label: unknown, colour: unknown, parent: unknown;
    try {
      ({ label, colour, parent } = await c.req.json());
    } catch {
      return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
    }

    if (typeof label !== "string" || !label.trim()) {
      return c.json({ error: "bad_request", reason: "a name is required" }, 400);
    }
    const clean = label.trim().slice(0, 40);
    const slug = slugify(clean);
    if (!slug) return c.json({ error: "bad_request", reason: "that name has no letters or numbers in it" }, 400);

    // Colour is cosmetic, so a bad one is corrected rather than refused.
    const given = typeof colour === "string" && /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : null;
    let hex = given ?? "#7E90A2";

    /* Under a parent, when one was named.
     *
     * The parent has to be one this person can actually see — a standard one or
     * their own — and has to be top level itself. The tree is two deep on
     * purpose: a leaf is what a transaction is filed under, a parent is what
     * leaves roll up into, and a third level makes every total ambiguous about
     * whether it already contains what sits beneath it.
     */
    let parentRow: { id: string; kind: string; colour: string } | null = null;
    if (typeof parent === "string" && parent.trim()) {
      const [found] = await db
        .select({
          id: categories.id, kind: categories.kind,
          colour: categories.colour, parentId: categories.parentId,
        })
        .from(categories)
        .where(
          and(
            eq(categories.slug, parent.trim()),
            isNull(categories.archivedAt),
            or(isNull(categories.userId), eq(categories.userId, auth.user.id)),
          ),
        );
      if (!found) return c.json({ error: "bad_request", reason: "no such parent category" }, 400);
      if (found.parentId) {
        return c.json({
          error: "bad_request",
          reason: "categories go two deep — pick a top-level one to sit under",
        }, 400);
      }
      parentRow = { id: found.id, kind: found.kind, colour: found.colour };
      // An unstated colour follows the family, so a new leaf looks like the
      // place it lives rather than like the one grey thing on the chart.
      if (!given) hex = found.colour;
    } else if (parent !== undefined && parent !== null && parent !== "") {
      return c.json({ error: "bad_request", reason: "that parent is not a category" }, 400);
    }

    // A system category with this slug already covers it — reusing it is better
    // than creating a private duplicate that splits the same spending in two.
    const existing = await db
      .select({ id: categories.id, slug: categories.slug, isSystem: categories.isSystem })
      .from(categories)
      .where(
        and(
          eq(categories.slug, slug),
          or(isNull(categories.userId), eq(categories.userId, auth.user.id)),
        ),
      );

    if (existing.length) {
      return c.json({
        ok: true,
        created: false,
        category: existing[0],
        reason: existing[0].isSystem ? "already a standard category" : "you already have that one",
      });
    }

    const [created] = await db
      .insert(categories)
      .values({
        userId: auth.user.id, slug, label: clean, colour: hex, sortOrder: 500, isSystem: false,
        parentId: parentRow?.id ?? null,
        // A leaf sits on the same side of the ledger as the parent it hangs
        // from, or the rollup would add money in to money out.
        kind: parentRow?.kind ?? "spend",
      })
      .returning();

    return c.json({ ok: true, created: true, category: created });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ----------------------------------------------------------------- re-file -- */

cats.post("/transactions/:id/category", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const txId = c.req.param("id");
    let categoryId: unknown, applyToMerchant: unknown;
    try {
      ({ categoryId, applyToMerchant } = await c.req.json());
    } catch {
      return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
    }
    if (typeof categoryId !== "string" || !categoryId) {
      return c.json({ error: "bad_request", reason: "categoryId is required" }, 400);
    }

    // The transaction must belong to this user. Joining through accounts and
    // items is what proves it — the id in the URL proves nothing on its own.
    const owned = await db
      .select({
        id: transactions.id,
        name: transactions.name,
        merchantName: transactions.merchantName,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .innerJoin(items, eq(accounts.itemId, items.id))
      .where(and(eq(transactions.id, txId), eq(items.userId, auth.user.id)));

    if (!owned.length) return c.json({ error: "not_found" }, 404);
    const tx = owned[0];

    // Likewise the category: a system one, or one of theirs. Nobody else's.
    const allowed = await db
      .select({ id: categories.id, slug: categories.slug, label: categories.label })
      .from(categories)
      .where(
        and(
          eq(categories.id, categoryId),
          or(isNull(categories.userId), eq(categories.userId, auth.user.id)),
        ),
      );
    if (!allowed.length) return c.json({ error: "bad_request", reason: "unknown category" }, 400);

    await db
      .insert(transactionOverrides)
      .values({ transactionId: tx.id, userId: auth.user.id, categoryId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: transactionOverrides.transactionId,
        set: { categoryId, updatedAt: new Date() },
      });

    let rule = null;
    if (applyToMerchant) {
      const key = merchantKey(tx.merchantName, tx.name);
      if (key) {
        const [saved] = await db
          .insert(merchantRules)
          .values({
            userId: auth.user.id,
            matchKey: key,
            displayName: tx.merchantName ?? tx.name,
            categoryId,
          })
          // Re-filing the same merchant somewhere else replaces the rule rather
          // than leaving two rules quietly fighting over it.
          .onConflictDoUpdate({
            target: [merchantRules.userId, merchantRules.matchKey],
            set: { categoryId, displayName: tx.merchantName ?? tx.name },
          })
          .returning();
        // id included so the front end can offer "just this one" and undo it.
        rule = { id: saved.id, matchKey: saved.matchKey, displayName: saved.displayName };
      }
    }

    return c.json({ ok: true, category: allowed[0], rule });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------- rules -- */

cats.get("/rules", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const rows = await db
      .select({
        id: merchantRules.id,
        displayName: merchantRules.displayName,
        matchKey: merchantRules.matchKey,
        categoryId: merchantRules.categoryId,
        slug: categories.slug,
        label: categories.label,
        colour: categories.colour,
      })
      .from(merchantRules)
      .innerJoin(categories, eq(merchantRules.categoryId, categories.id))
      .where(eq(merchantRules.userId, auth.user.id))
      .orderBy(merchantRules.displayName);

    return c.json({ ok: true, rules: rows });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

cats.delete("/rules/:id", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const gone = await db
      .delete(merchantRules)
      .where(and(eq(merchantRules.id, c.req.param("id")), eq(merchantRules.userId, auth.user.id)))
      .returning({ id: merchantRules.id });

    return gone.length ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/* ------------------------------------------------------------------ split -- */

/**
 * Divide one transaction between categories.
 *
 * A PUT replacing the whole set rather than endpoints for adding and removing
 * one part at a time. The editor shows every part at once and the rule being
 * enforced is about the set — that the parts do not add up to more than the
 * transaction — so a request that can only be judged alongside parts it did
 * not send is a request that cannot be checked. Sending the whole set means
 * every save is validated against exactly what will be stored.
 *
 * Amounts arrive the way the transactions list sends them: positive is money
 * IN, so an expense and the parts carved out of it are both negative. The
 * column keeps Plaid's opposite convention, and the two are converted here, at
 * the boundary, so nothing above this line has to know which way round Plaid
 * counts.
 */
cats.put("/transactions/:id/splits", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const txId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", reason: "body must be JSON" }, 400);
    }
    const sent = (body as { splits?: unknown })?.splits;
    if (!Array.isArray(sent)) {
      return c.json({ error: "bad_request", reason: "splits must be an array" }, 400);
    }

    /* Merged rather than rejected. Two rows pointing at the same category is
       not two facts about the transaction, it is one number entered over two
       lines, and the table holds one row per category per transaction. */
    const merged = new Map<string, number>();
    for (const raw of sent) {
      const categoryId = (raw as { categoryId?: unknown })?.categoryId;
      const amount = (raw as { amount?: unknown })?.amount;
      if (typeof categoryId !== "string" || !categoryId) {
        return c.json({ error: "bad_request", reason: "every part needs a categoryId" }, 400);
      }
      if (typeof amount !== "number" || !Number.isInteger(amount)) {
        return c.json(
          { error: "bad_request", reason: "every amount must be a whole number of cents" },
          400,
        );
      }
      merged.set(categoryId, (merged.get(categoryId) ?? 0) + amount);
    }

    // The transaction must belong to this user. Joining through accounts and
    // items is what proves it — the id in the URL proves nothing on its own.
    const owned = await db
      .select({ id: transactions.id, amount: transactions.amount })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .innerJoin(items, eq(accounts.itemId, items.id))
      .where(and(eq(transactions.id, txId), eq(items.userId, auth.user.id)));

    if (!owned.length) return c.json({ error: "not_found" }, 404);
    const amountCents = Number(owned[0].amount);   // Plaid: positive is money out

    // Likewise every category: a system one, or one of theirs. Nobody else's.
    const wanted = [...merged.keys()];
    if (wanted.length) {
      const allowed = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            inArray(categories.id, wanted),
            or(isNull(categories.userId), eq(categories.userId, auth.user.id)),
          ),
        );
      if (allowed.length !== wanted.length) {
        return c.json({ error: "bad_request", reason: "unknown category" }, 400);
      }
    }

    /* Flipped into the column's convention before checking, so the rules are
       applied to the numbers that will actually be stored. */
    const splits: Split[] = [...merged].map(([categoryId, amount]) => ({
      categoryId,
      cents: -amount,
    }));

    const verdict = checkSplits(amountCents, splits);
    if (!verdict.ok) return c.json({ error: "bad_request", reason: verdict.reason }, 400);

    const keep = splits.filter((s) => s.cents !== 0);

    /* Replaced wholesale: clearing the editor and saving has to leave nothing
       behind, and a part moved from one category to another must not linger
       under both. There is no transaction wrapping these — this database is
       reached over HTTP and the driver has none — so the delete is ordered
       first and the failure it leaves behind is an unsplit transaction rather
       than a doubled one. */
    await db
      .delete(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, txId),
          eq(transactionSplits.userId, auth.user.id),
        ),
      );

    if (keep.length) {
      await db.insert(transactionSplits).values(
        keep.map((s) => ({
          transactionId: txId,
          userId: auth.user.id,
          categoryId: s.categoryId,
          cents: BigInt(s.cents),
        })),
      );
    }

    return c.json({
      ok: true,
      // Back in the reader's convention, the way they were sent.
      splits: keep.map((s) => ({ categoryId: s.categoryId, amount: -s.cents })),
      remainder: -remainderOf(amountCents, keep),
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

export default cats;

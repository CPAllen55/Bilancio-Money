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
  budgetPlansV2,
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

/* ------------------------------------------------------------------ delete -- */

/**
 * DELETE /api/categories/:id — remove a subcategory nothing is using.
 *
 * ── Why it refuses rather than reassigns ────────────────────────────────────
 *
 * Deleting a category that has spending filed under it has to put that
 * spending somewhere, and every answer is a guess about what somebody meant.
 * Moving it to the parent quietly changes what every total says. Moving it to
 * Unsorted hides real spending in the one bucket nobody reads. Deleting the
 * rows is unthinkable. So the answer is no, with the reason — and the reader
 * re-files what is in there and comes back, which is the only version of this
 * where they decided where the money went.
 *
 * ── What counts as in use ───────────────────────────────────────────────────
 *
 * Not just transactions. A merchant rule pointing here would start failing to
 * resolve; a split would lose the part it names; a budget line would be
 * planning for something that no longer exists; and a parent with children
 * cannot go while they are still hanging from it. Each is reported by name,
 * because "in use" without saying where is a dead end.
 *
 * System categories are never deletable. They are shared by every account and
 * the classifier maps Plaid's taxonomy onto their slugs, so removing one for
 * one person would break the mapping for that person and nobody else — which
 * is the hardest kind of fault to find.
 */
cats.delete("/categories/:id", async (c) => {
  const { db, ready, close } = getDb(c.env);
  try {
    await ready;
    const auth = await requireUser(c, db);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const id = c.req.param("id");

    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id));
    if (!category) return c.json({ error: "not_found" }, 404);

    // Theirs, or nobody's business. A system category matches the first test
    // and is refused by the second, which is the honest order to say it in.
    if (category.userId !== auth.user.id) {
      return c.json({
        error: "bad_request",
        reason: category.isSystem || category.userId === null
          ? "that is a standard category and cannot be removed"
          : "that is not your category",
      }, 400);
    }

    const [children, overrides, splits, rules, plans] = await Promise.all([
      db.select({ id: categories.id }).from(categories)
        .where(and(eq(categories.parentId, id), isNull(categories.archivedAt))).limit(1),
      db.select({ id: transactionOverrides.transactionId }).from(transactionOverrides)
        .where(eq(transactionOverrides.categoryId, id)).limit(1),
      db.select({ id: transactionSplits.id }).from(transactionSplits)
        .where(eq(transactionSplits.categoryId, id)).limit(1),
      db.select({ id: merchantRules.id }).from(merchantRules)
        .where(eq(merchantRules.categoryId, id)).limit(1),
      db.select({ id: budgetPlansV2.id }).from(budgetPlansV2)
        .where(eq(budgetPlansV2.categoryId, id)).limit(1),
    ]);

    const blocking =
      children.length ? "it still has subcategories under it"
      : overrides.length ? "transactions are filed under it"
      : splits.length ? "part of a split transaction is filed under it"
      : rules.length ? "a merchant is filed under it"
      : plans.length ? "it has a budget"
      : null;

    if (blocking) {
      return c.json({ error: "in_use", reason: blocking }, 409);
    }

    await db.delete(categories).where(
      and(eq(categories.id, id), eq(categories.userId, auth.user.id)),
    );
    return c.json({ ok: true, deleted: id });
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

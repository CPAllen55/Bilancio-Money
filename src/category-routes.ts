/**
 * /api/categories and re-filing a transaction.
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
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "./db/client";
import { categories, merchantRules, transactionOverrides, transactions, accounts, items } from "./db/schema";
import { requireUser } from "./auth";
import { loadCategories } from "./summary-routes";
import { merchantKey } from "./categories";

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

    let label: unknown, colour: unknown;
    try {
      ({ label, colour } = await c.req.json());
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
    const hex = typeof colour === "string" && /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : "#7E90A2";

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
      .values({ userId: auth.user.id, slug, label: clean, colour: hex, sortOrder: 500, isSystem: false })
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

export default cats;

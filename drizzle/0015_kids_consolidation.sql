-- Kids goes from eight subcategories to five.
--
--   Daycare + Babysitting                        -> Childcare
--   Kid Clothing + School Supplies + Kid Gifts   -> Kid Essentials
--
-- Two of the five survivors are RENAMES IN PLACE, which is the whole point of
-- doing this in SQL rather than in the JSON alone. `daycare` becomes
-- `childcare` and `kid-clothing` becomes `kid-essentials` on the same row, so
-- every merchant rule, override, split, budget and alert already pointing at
-- them keeps working and nobody's filing is disturbed. Only the other three
-- have to be moved, and this moves them rather than stranding them: without
-- it, the seed would archive `babysitting`, `kid-supplies` and `kid-gifts`
-- and anything filed there would point at a category the app no longer shows.
--
-- Every move has to survive the case where the same person has data in BOTH
-- the source and the destination, because each of these tables is unique on
-- the category. So each one folds first and moves second: amounts are added
-- together where a collision exists, the loser is deleted, and only then is
-- the remainder re-pointed.
--
-- Nothing here is schema. The tables are unchanged; this is data, and it runs
-- before the category seed in scripts/migrate.mjs, which is what makes the
-- rename visible to the seed as an update rather than an insert.

UPDATE categories SET slug = 'childcare', label = 'Childcare'
 WHERE user_id IS NULL AND slug = 'daycare';
--> statement-breakpoint
UPDATE categories SET slug = 'kid-essentials', label = 'Kid Essentials'
 WHERE user_id IS NULL AND slug = 'kid-clothing';
--> statement-breakpoint
DO $$
DECLARE
  pair record;
  src uuid;
  dst uuid;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('babysitting',  'childcare'),
      ('kid-supplies', 'kid-essentials'),
      ('kid-gifts',    'kid-essentials')
    ) AS p(src_slug, dst_slug)
  LOOP
    SELECT id INTO src FROM categories WHERE user_id IS NULL AND slug = pair.src_slug;
    SELECT id INTO dst FROM categories WHERE user_id IS NULL AND slug = pair.dst_slug;
    -- A database that has never been seeded has neither, and nothing to move.
    CONTINUE WHEN src IS NULL OR dst IS NULL;

    -- Unique on something other than the category, so a plain move is safe.
    UPDATE merchant_rules         SET category_id = dst WHERE category_id = src;
    UPDATE transaction_overrides  SET category_id = dst WHERE category_id = src;

    -- One split row per (transaction, category): fold, then move.
    UPDATE transaction_splits t
       SET cents = t.cents + s.cents
      FROM transaction_splits s
     WHERE s.category_id = src AND t.category_id = dst
       AND t.transaction_id = s.transaction_id;
    DELETE FROM transaction_splits s
     WHERE s.category_id = src
       AND EXISTS (SELECT 1 FROM transaction_splits t
                    WHERE t.transaction_id = s.transaction_id AND t.category_id = dst);
    UPDATE transaction_splits SET category_id = dst WHERE category_id = src;

    -- One plan row per (user, category). Two budgets becoming one category
    -- means one budget worth both of them.
    UPDATE budget_plans t
       SET manual_amount = t.manual_amount + s.manual_amount
      FROM budget_plans s
     WHERE s.category_id = src AND t.category_id = dst AND t.user_id = s.user_id;
    DELETE FROM budget_plans s
     WHERE s.category_id = src
       AND EXISTS (SELECT 1 FROM budget_plans t
                    WHERE t.user_id = s.user_id AND t.category_id = dst);
    UPDATE budget_plans SET category_id = dst WHERE category_id = src;

    -- The same for v2, which also carries a figure per month. Those are added
    -- month by month rather than one overwriting the other.
    UPDATE budget_plans_v2 t
       SET manual_amount = t.manual_amount + s.manual_amount,
           manual_by_month = COALESCE((
             SELECT jsonb_object_agg(k, v)
               FROM (SELECT key AS k, SUM(value::numeric)::bigint AS v
                       FROM (SELECT * FROM jsonb_each_text(t.manual_by_month)
                             UNION ALL
                             SELECT * FROM jsonb_each_text(s.manual_by_month)) AS pairs(key, value)
                      GROUP BY key) AS summed
           ), '{}'::jsonb)
      FROM budget_plans_v2 s
     WHERE s.category_id = src AND t.category_id = dst AND t.user_id = s.user_id;
    DELETE FROM budget_plans_v2 s
     WHERE s.category_id = src
       AND EXISTS (SELECT 1 FROM budget_plans_v2 t
                    WHERE t.user_id = s.user_id AND t.category_id = dst);
    UPDATE budget_plans_v2 SET category_id = dst WHERE category_id = src;

    -- Watching two categories that become one is watching one.
    DELETE FROM budget_alert_subscriptions s
     WHERE s.category_id = src
       AND EXISTS (SELECT 1 FROM budget_alert_subscriptions t
                    WHERE t.user_id = s.user_id AND t.category_id = dst);
    UPDATE budget_alert_subscriptions SET category_id = dst WHERE category_id = src;

    -- What has already been said this month, per category. A dropped row costs
    -- at most one repeated alert; a duplicate key costs the migration.
    DELETE FROM budget_alert_states s
     WHERE s.category_id = src
       AND EXISTS (SELECT 1 FROM budget_alert_states t
                    WHERE t.user_id = s.user_id AND t.category_id = dst AND t.month = s.month);
    UPDATE budget_alert_states SET category_id = dst WHERE category_id = src;
  END LOOP;
END $$;

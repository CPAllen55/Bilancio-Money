-- A bank connection closed at Plaid because access ended, kept rather than deleted.
--
-- Nullable and without a default, so adding it is instant and every row already
-- here reads as open. Safe to apply before the code that uses it is deployed:
-- the old code selects columns by name and never sees this one.
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;

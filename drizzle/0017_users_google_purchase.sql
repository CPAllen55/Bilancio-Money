-- The Google Play purchase token behind a subscription bought in the Android app.
--
-- Nullable and without a default, so adding it is instant and every row reads
-- as "not a Google subscriber". Unique where set: one Play subscription belongs
-- to one account, and the notifications endpoint finds the account by it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_purchase_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_purchase_token_idx" ON "users" ("google_purchase_token") WHERE "google_purchase_token" is not null;

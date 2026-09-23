-- When the operator was told about this sign-up.
--
-- NULL means "not yet announced". The first run of the job marks every account
-- older than a day without mailing, so switching it on does not send the whole
-- user table in one message.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signup_notified_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_signup_unannounced_idx" ON "users" ("created_at") WHERE "signup_notified_at" is null;

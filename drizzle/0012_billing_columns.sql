ALTER TABLE "users" ADD COLUMN "billing_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_original_transaction_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_stripe_customer_idx" ON "users" USING btree ("stripe_customer_id") WHERE "users"."stripe_customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_apple_original_txn_idx" ON "users" USING btree ("apple_original_transaction_id") WHERE "users"."apple_original_transaction_id" is not null;
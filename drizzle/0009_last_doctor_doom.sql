CREATE TABLE "metal_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"metal" text NOT NULL,
	"ounces_e4" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metal_prices" (
	"metal" text NOT NULL,
	"date" date NOT NULL,
	"usd_per_ounce" bigint NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metal_holdings" ADD CONSTRAINT "metal_holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metal_holdings_user_metal_idx" ON "metal_holdings" USING btree ("user_id","metal");--> statement-breakpoint
CREATE UNIQUE INDEX "metal_prices_metal_date_idx" ON "metal_prices" USING btree ("metal","date");
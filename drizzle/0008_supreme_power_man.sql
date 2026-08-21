CREATE TABLE "budget_plans_v2" (
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"method" text DEFAULT 'average' NOT NULL,
	"manual_amount" bigint DEFAULT 0 NOT NULL,
	"manual_by_month" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_plans_v2" ADD CONSTRAINT "budget_plans_v2_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_plans_v2" ADD CONSTRAINT "budget_plans_v2_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_plans_v2_user_category_idx" ON "budget_plans_v2" USING btree ("user_id","category_id");
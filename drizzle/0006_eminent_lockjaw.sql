CREATE TABLE "budget_plans" (
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"method" text DEFAULT 'auto' NOT NULL,
	"manual_amount" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_plans" ADD CONSTRAINT "budget_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_plans" ADD CONSTRAINT "budget_plans_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_plans_user_category_idx" ON "budget_plans" USING btree ("user_id","category_id");
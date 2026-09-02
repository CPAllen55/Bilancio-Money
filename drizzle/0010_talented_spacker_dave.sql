CREATE TYPE "public"."user_plan" AS ENUM('trial', 'active', 'free', 'lapsed');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" "user_plan" DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_note" text;
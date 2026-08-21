ALTER TABLE "budget_plans" ALTER COLUMN "method" SET DEFAULT 'average';--> statement-breakpoint
-- Rows written while "Automatic" was on the menu. It chose seasonal or average
-- per category rather than being a method in its own right; average is the
-- closest single answer and is now the default, so they move there instead of
-- being left pointing at something that no longer exists.
UPDATE "budget_plans" SET "method" = 'average' WHERE "method" = 'auto';

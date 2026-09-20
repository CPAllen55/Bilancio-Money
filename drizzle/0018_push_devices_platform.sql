-- Which store's phone a push token belongs to, so it is sent the right way.
--
-- Defaulted to 'ios' because every row that exists is an iPhone: the column is
-- added before the first Android device can register, and a default keeps the
-- old code, which never writes it, correct.
ALTER TABLE "push_devices" ADD COLUMN IF NOT EXISTS "platform" text NOT NULL DEFAULT 'ios';

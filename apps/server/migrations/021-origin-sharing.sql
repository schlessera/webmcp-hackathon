-- Opt-in live position sharing. This column was first appended to 018 after
-- that migration had already run on deployed databases (the runner keys on
-- the file name and skips it), so it is repeated here idempotently.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS origin_shared boolean NOT NULL DEFAULT false;

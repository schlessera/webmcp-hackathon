-- A need can be set aside without being withdrawn: an inactive requirement
-- stops classifying candidates but keeps its row, its id and its history, so
-- the brief can still show it (greyed) and say what turning it back on costs.
-- Withdrawal remains the destructive act; this is reversible by its owner.

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

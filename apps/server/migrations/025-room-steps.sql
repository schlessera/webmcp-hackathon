-- A room's plan: the sequence of places a goal decomposes into.
--
-- Additive and defaulted, so every room that predates plans reads back as
-- "no plan" and behaves exactly as it did: rooms.steps '[]', no active step,
-- candidates.step_id NULL. room_demo is one of those and stays one.
--
-- candidates.step_id is what makes the pool belong to a step. A row with a
-- NULL step_id belongs to the room itself (the pre-plan shape); a row with a
-- step belongs to that step and is only live while that step is active. The
-- rule is written once, in apps/server/src/steps.ts (LIVE_POOL), and every
-- query that enumerates a room's pool carries it.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active_step_id text;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS step_id text;
CREATE INDEX IF NOT EXISTS candidates_room_step ON candidates (room_id, step_id);

-- Needs belong to the step they were stated for, so a step that has been
-- settled can stop applying without losing what it asked for. NULL means the
-- need belongs to the room, which is every need in every room until now.
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS step_id text;

-- Presence, the durable half: when a participant first opened the room on any
-- surface (page or agent). Set on the first sync, never cleared. The live
-- half ("looking now") is an open socket and lives in server memory only.

ALTER TABLE participants ADD COLUMN IF NOT EXISTS arrived_at timestamptz;

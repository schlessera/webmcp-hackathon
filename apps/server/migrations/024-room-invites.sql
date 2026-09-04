-- Invite links: how someone joins a room that already exists.
--
-- `invite_secrets` (001-init) binds a secret to a participant who was named
-- before the room opened. That path is untouched: room_demo and every room
-- created with a roster still use it.
--
-- A room invite is the other shape. It is minted by someone already in the
-- room, carries no participant, and only becomes one when a person claims it
-- with a name. It is single-use: the first claim binds it to the device that
-- made it, and that device — and only that device — can come back through it.
-- An unclaimed link expires; a claimed one does not, because it is now that
-- person's way back in.
--
-- The device hash is not an identity. It rebinds a link to the browser that
-- took it and is never shown, logged, or returned.

CREATE TABLE IF NOT EXISTS room_invites (
  id              text PRIMARY KEY,
  room_id         text NOT NULL REFERENCES rooms(id),
  secret_hash     text NOT NULL UNIQUE,
  created_by      text NOT NULL REFERENCES participants(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  claimed_at      timestamptz,
  participant_id  text REFERENCES participants(id),
  device_hash     text,
  CONSTRAINT claimed_has_a_participant
    CHECK ((claimed_at IS NULL) = (participant_id IS NULL)),
  CONSTRAINT claimed_has_a_device
    CHECK ((claimed_at IS NULL) = (device_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS room_invites_room ON room_invites (room_id, created_at DESC);

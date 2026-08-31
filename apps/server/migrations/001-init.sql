-- One authoritative room, one event log, per-participant projections.
-- Invariant 5 (NEGOTIATION-PROTOCOL.md): agent-private requirement payloads
-- never appear in any server store: requirements.payload stays NULL for them
-- and a CHECK enforces it.

CREATE TABLE IF NOT EXISTS rooms (
  id            text PRIMARY KEY,
  goal          text NOT NULL,
  phase         text NOT NULL DEFAULT 'gathering',
  domain        text NOT NULL,
  revision      integer NOT NULL DEFAULT 0,
  policy        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  id                    text PRIMARY KEY,
  room_id               text NOT NULL REFERENCES rooms(id),
  display_name          text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('organizer', 'member')),
  ready_state           text NOT NULL DEFAULT 'contributing',
  last_synced_revision  integer NOT NULL DEFAULT 0
);

-- Invite secrets are stored hashed (public-tunnel caution in the spike doc).
CREATE TABLE IF NOT EXISTS invite_secrets (
  secret_hash     text PRIMARY KEY,
  participant_id  text NOT NULL REFERENCES participants(id),
  room_id         text NOT NULL REFERENCES rooms(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participant_tokens (
  token_hash      text PRIMARY KEY,
  participant_id  text NOT NULL REFERENCES participants(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  room_id     text NOT NULL REFERENCES rooms(id),
  revision    integer NOT NULL,
  type        text NOT NULL,
  actor_id    text,
  visibility  text NOT NULL DEFAULT 'shared',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, revision)
);

CREATE TABLE IF NOT EXISTS requirements (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms(id),
  owner_id    text NOT NULL REFERENCES participants(id),
  visibility  text NOT NULL CHECK (visibility IN ('shared', 'application-private', 'agent-private')),
  hardness    text NOT NULL CHECK (hardness IN ('hard', 'soft')),
  delegation  jsonb NOT NULL,
  payload     jsonb,
  scope_hint  jsonb,
  note        text,
  withdrawn   boolean NOT NULL DEFAULT false,
  CONSTRAINT agent_private_has_no_payload
    CHECK (visibility <> 'agent-private' OR payload IS NULL)
);

CREATE TABLE IF NOT EXISTS verdicts (
  room_id               text NOT NULL REFERENCES rooms(id),
  owner_id              text NOT NULL REFERENCES participants(id),
  candidate_id          text NOT NULL,
  verdict               text NOT NULL CHECK (verdict IN ('acceptable', 'unacceptable', 'needs_info')),
  info_needed           text,
  recorded_at_revision  integer NOT NULL,
  PRIMARY KEY (room_id, owner_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS candidates (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id),
  name          text NOT NULL,
  category      text NOT NULL,
  price_level   integer NOT NULL,
  walk_min      integer NOT NULL,
  location      jsonb NOT NULL,
  attributes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  map_revision  integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS proposals (
  id                   text PRIMARY KEY,
  room_id              text NOT NULL REFERENCES rooms(id),
  candidate_id         text NOT NULL,
  created_by           text NOT NULL,
  created_at_revision  integer NOT NULL,
  status               text NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS stances (
  room_id         text NOT NULL REFERENCES rooms(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  proposal_id     text NOT NULL REFERENCES proposals(id),
  disposition     text NOT NULL,
  visibility      text NOT NULL,
  reason          jsonb,
  at_revision     integer NOT NULL,
  PRIMARY KEY (room_id, participant_id, proposal_id)
);

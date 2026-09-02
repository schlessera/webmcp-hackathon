-- What a participant (through their agent, or by hand) found out about a
-- place that the map data did not know. One row per (room, place, fact,
-- participant); re-attesting replaces. Merged into the dossier at read time
-- (apps/server/src/attestations.ts) with OpenStreetMap's verified facts taking
-- precedence; never written into candidates.attributes, so the source data
-- stays what the extract said.

CREATE TABLE IF NOT EXISTS attestations (
  room_id         text NOT NULL REFERENCES rooms(id),
  candidate_id    text NOT NULL,
  key             text NOT NULL,
  participant_id  text NOT NULL REFERENCES participants(id),
  status          text NOT NULL CHECK (status IN ('verified_true', 'verified_false')),
  confidence      real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  note            text NOT NULL,
  source_url      text,
  at_revision     integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, candidate_id, key, participant_id)
);

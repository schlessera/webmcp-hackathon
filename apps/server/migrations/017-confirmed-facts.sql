-- A person-verified fact about an OpenStreetMap place. Unlike room-scoped
-- attestations, these rows have no expiry and merge into every room that
-- holds the same osm_ref. Private questions store only their q:<sha1> key.
CREATE TABLE IF NOT EXISTS confirmed_facts (
  osm_ref                  text,
  criterion_id             text,
  lean                     boolean NOT NULL,
  note                     text,
  source_url               text,
  confirmed_by_name        text,
  confirmed_by_participant text,
  room_id                  text,
  confirmed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (osm_ref, criterion_id)
);

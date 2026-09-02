-- Enrichment (docs/ENRICHMENT-SOURCES.md): what the server looked up about a
-- place beyond the map data, keyed by its OpenStreetMap ref so every room
-- that holds the same place shares one lookup. Never written into
-- candidates.attributes; merged at read time like attestations, below any
-- verified record fact.

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS osm_ref text;
-- Links, description and lookup ids the map data itself carried.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS extras jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS candidates_osm_ref ON candidates (osm_ref);

CREATE TABLE IF NOT EXISTS enrichments (
  osm_ref     text PRIMARY KEY,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Parsed facts from the place's own website (schema.org JSON-LD, menu link).
  website     jsonb,
  -- Parsed facts from Wikidata (CC0) when the place carries a wikidata tag.
  wikidata    jsonb,
  -- Last failure, for the drawer; null when the fetch succeeded.
  error       text
);

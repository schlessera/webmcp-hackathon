ALTER TABLE listing_batches ADD COLUMN results jsonb NOT NULL DEFAULT '[]';
ALTER TABLE listing_batches ADD COLUMN returned_items integer NOT NULL DEFAULT 0;
ALTER TABLE listing_batches ADD COLUMN requests integer NOT NULL DEFAULT 0;

-- Regional reference data; bounded imports replace one release/region atomically.
CREATE TABLE overture_places (
  region text NOT NULL,
  id text NOT NULL,
  release text NOT NULL,
  name text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  facts jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(region, id)
);
CREATE INDEX overture_places_location ON overture_places(lat, lng);
CREATE TABLE source_tiles (
  cache_key text PRIMARY KEY,
  records jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE enrichments ADD COLUMN discoveries jsonb NOT NULL DEFAULT '{}';

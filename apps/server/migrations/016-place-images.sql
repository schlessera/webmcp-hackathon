-- Server-owned place photos. Participants only ever receive the local route;
-- no browser request reaches the place, Commons, or another image host.
CREATE TABLE IF NOT EXISTS place_images (
  osm_ref    text NOT NULL,
  idx        integer NOT NULL CHECK (idx >= 0 AND idx < 3),
  mime       text NOT NULL CHECK (mime = 'image/webp'),
  width      integer NOT NULL CHECK (width > 0 AND width <= 960),
  height     integer NOT NULL CHECK (height > 0),
  bytes      bytea NOT NULL,
  source     text NOT NULL,
  source_url text NOT NULL,
  page_url   text NOT NULL,
  license    text,
  credit     text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (osm_ref, idx)
);

CREATE INDEX IF NOT EXISTS place_images_expiry ON place_images (expires_at);

-- A negative result also needs a TTL, otherwise a place with no candidates
-- would repeat the same provider work on every dossier read.
ALTER TABLE enrichments
  ADD COLUMN IF NOT EXISTS image_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS image_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS image_error text;

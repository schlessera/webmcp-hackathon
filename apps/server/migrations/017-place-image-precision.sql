-- Site-image vision verdicts are shared by URL across places/rooms. The URL
-- itself is deliberately not retained here: only its SHA-256 lookup key and
-- the bounded classifier result. Callers ignore rows older than 30 days.
CREATE TABLE IF NOT EXISTS place_image_verdicts (
  url_hash   text PRIMARY KEY CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  kind       text NOT NULL CHECK (kind IN (
    'venue_exterior', 'venue_interior', 'food_or_drink', 'people',
    'logo', 'flag_or_icon', 'map_or_screenshot', 'text_or_graphic', 'other'
  )),
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model      text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS place_image_verdicts_decided_at
  ON place_image_verdicts (decided_at);

-- Every site image predating this migration bypassed the classifier. Remove
-- those bytes and make only the affected places due for a clean harvest.
WITH purged AS (
  DELETE FROM place_images
   WHERE source LIKE 'web:%'
  RETURNING osm_ref
)
UPDATE enrichments
   SET image_fetched_at = NULL,
       image_expires_at = NULL,
       image_error = NULL
 WHERE osm_ref IN (SELECT DISTINCT osm_ref FROM purged);

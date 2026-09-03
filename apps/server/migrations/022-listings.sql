-- Structured Google business-profile evidence through DataForSEO. The
-- normalized claims still live in enrichments.inferred so every provider
-- follows the one monotonic merge rule; this column retains only listing
-- fields needed for hours, rating and website discovery.
ALTER TABLE enrichments
  ADD COLUMN IF NOT EXISTS listing jsonb;

-- One durable budget row per room prevents concurrent server processes from
-- fetching the same pool twice. A changed scope_id is allowed immediately;
-- an unchanged scope waits 24 hours.
CREATE TABLE IF NOT EXISTS room_listing_fetches (
  room_id    text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  scope_id   text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  status     text NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
  item_count integer NOT NULL DEFAULT 0,
  cost_usd   double precision NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS room_listing_fetches_fetched_at
  ON room_listing_fetches (fetched_at);

-- Parallel output is retained only beneath a room-scoped query hash. The
-- primary key needs no new column because the room id is part of that hash.
ALTER TABLE search_cache DROP CONSTRAINT IF EXISTS search_cache_provider_check;
ALTER TABLE search_cache
  ADD CONSTRAINT search_cache_provider_check
  CHECK (provider IN ('tavily', 'openai', 'parallel'));

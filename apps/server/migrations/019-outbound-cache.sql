-- U9: durable, cross-room caches for expensive outbound evidence. Extracted
-- page text is server-private evaluator input; it is never projected to a
-- participant or copied into an enrichment dossier.
CREATE TABLE IF NOT EXISTS page_cache (
  url_hash         text PRIMARY KEY,
  url              text NOT NULL,
  host             text NOT NULL,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  etag             text,
  last_modified    text,
  status           integer NOT NULL,
  text             text CHECK (char_length(text) <= 6000),
  image_candidates jsonb,
  robots           text
);

CREATE INDEX IF NOT EXISTS page_cache_expiry ON page_cache (expires_at);
CREATE INDEX IF NOT EXISTS page_cache_host ON page_cache (host);

-- Raw response bodies are restricted to the freely reusable Wikidata/Commons
-- metadata legs. Venue HTML belongs in page_cache only after extraction.
CREATE TABLE IF NOT EXISTS outbound_metadata_cache (
  url_hash      text PRIMARY KEY,
  url           text NOT NULL,
  host          text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('wikidata', 'wikimedia', 'commons')),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  etag          text,
  last_modified text,
  status        integer NOT NULL,
  content_type  text,
  body           bytea NOT NULL
);

CREATE INDEX IF NOT EXISTS outbound_metadata_cache_expiry
  ON outbound_metadata_cache (expires_at);

-- Tavily permits Output inside a Customer Application, so snippets may occupy
-- snippets. OpenAI search rows deliberately leave snippets NULL and retain
-- only the application's validated, derived claims.
CREATE TABLE IF NOT EXISTS search_cache (
  osm_ref        text NOT NULL,
  query_hash     text NOT NULL,
  provider       text NOT NULL CHECK (provider IN ('tavily', 'openai')),
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  snippets       jsonb,
  claims         jsonb,
  answered_ids   jsonb,
  PRIMARY KEY (osm_ref, query_hash, provider)
);

CREATE INDEX IF NOT EXISTS search_cache_expiry ON search_cache (expires_at);

-- No expiry is intentional: an identical evidence hash means the exact model
-- question has already been answered. A changed source or criterion selects a
-- different key instead of making stale material look current.
CREATE TABLE IF NOT EXISTS matrix_cache (
  osm_ref       text NOT NULL,
  criterion_id text NOT NULL,
  evidence_hash text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  claim         jsonb,
  answered      boolean NOT NULL,
  PRIMARY KEY (osm_ref, criterion_id, evidence_hash)
);

CREATE INDEX IF NOT EXISTS matrix_cache_evaluated_at ON matrix_cache (evaluated_at);

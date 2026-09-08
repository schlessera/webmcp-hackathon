-- Operational state is separate from evidence: a failed attempt is never an omission.
CREATE TABLE resource_usage (
  resource text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds IN (3600, 86400)),
  workload text NOT NULL CHECK (workload IN ('interactive', 'background', 'prepopulate')),
  used integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (resource, window_start, window_seconds, workload)
);
CREATE TABLE prepopulation_runs (
  id text PRIMARY KEY,
  options jsonb NOT NULL,
  selection_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'deferred', 'failed', 'complete', 'interrupted')),
  max_requests integer CHECK (max_requests > 0),
  max_cost_usd numeric CHECK (max_cost_usd > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retry_at timestamptz,
  owner text,
  lease_expires_at timestamptz
);
CREATE TABLE resource_reservations (
  id text PRIMARY KEY,
  resource text NOT NULL,
  workload text NOT NULL CHECK (workload IN ('interactive', 'background', 'prepopulate')),
  remaining integer NOT NULL CHECK (remaining >= 0),
  expires_at timestamptz NOT NULL,
  run_id text REFERENCES prepopulation_runs(id),
  unit_cost_usd numeric NOT NULL DEFAULT 0 CHECK (unit_cost_usd >= 0)
);
CREATE INDEX resource_reservations_active ON resource_reservations(resource, expires_at);
CREATE TABLE provider_attempts (
  id text PRIMARY KEY,
  run_id text REFERENCES prepopulation_runs(id),
  provider text NOT NULL,
  workload text NOT NULL,
  estimated_cost_usd numeric NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  actual_cost_usd numeric CHECK (actual_cost_usd >= 0),
  http_status integer,
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'ok', 'empty', 'failed')),
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX provider_attempts_run ON provider_attempts(run_id, started_at);
CREATE TABLE prepopulation_stages (
  run_id text NOT NULL REFERENCES prepopulation_runs(id),
  osm_ref text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'ok', 'empty', 'deferred', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  failure jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, osm_ref, stage)
);
-- Only matched facts are persisted by the caller. No unmatched provider inventory.
CREATE TABLE listing_batches (
  scope_hash text NOT NULL,
  batch_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'ok', 'deferred', 'failed')),
  owner text,
  expires_at timestamptz NOT NULL,
  next_offset integer NOT NULL DEFAULT 0,
  matched integer NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  failure jsonb,
  PRIMARY KEY (scope_hash, batch_key)
);
CREATE TABLE fetch_leases (
  cache_key text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL
);

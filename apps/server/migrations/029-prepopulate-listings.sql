-- Regional listing admission survives reruns, including scopes with no matches.
-- This stores no provider output; matched facts live in enrichments as usual.
CREATE TABLE prepopulate_listing_fetches (
  scope_hash text PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  expires_at timestamptz NOT NULL
);

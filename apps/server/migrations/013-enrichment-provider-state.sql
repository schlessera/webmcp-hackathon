-- R11: website and Wikidata refresh independently. A failure on one provider
-- must retain that provider's last good payload and must not extend its retry
-- window merely because the other provider succeeded.

ALTER TABLE enrichments
  ADD COLUMN IF NOT EXISTS website_status text NOT NULL DEFAULT 'never',
  ADD COLUMN IF NOT EXISTS website_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS website_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS website_error text,
  ADD COLUMN IF NOT EXISTS wikidata_status text NOT NULL DEFAULT 'never',
  ADD COLUMN IF NOT EXISTS wikidata_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS wikidata_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS wikidata_error text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE enrichments
   SET website_status = CASE
         WHEN website IS NOT NULL THEN 'ok'
         WHEN error IS NOT NULL THEN 'error'
         ELSE 'never'
       END,
       website_fetched_at = CASE WHEN website IS NOT NULL OR error IS NOT NULL THEN fetched_at END,
       website_expires_at = CASE WHEN website IS NOT NULL THEN expires_at ELSE now() END,
       website_error = CASE WHEN website IS NULL THEN error END,
       wikidata_status = CASE
         WHEN wikidata IS NOT NULL THEN 'ok'
         WHEN error IS NOT NULL THEN 'error'
         ELSE 'never'
       END,
       wikidata_fetched_at = CASE WHEN wikidata IS NOT NULL OR error IS NOT NULL THEN fetched_at END,
       wikidata_expires_at = CASE WHEN wikidata IS NOT NULL THEN expires_at ELSE now() END,
       wikidata_error = CASE WHEN wikidata IS NULL THEN error END;

ALTER TABLE enrichments
  ADD CONSTRAINT enrichments_website_status
    CHECK (website_status IN ('never', 'ok', 'error')),
  ADD CONSTRAINT enrichments_wikidata_status
    CHECK (wikidata_status IN ('never', 'ok', 'error'));

CREATE INDEX IF NOT EXISTS enrichments_lease_expiry ON enrichments (lease_expires_at);

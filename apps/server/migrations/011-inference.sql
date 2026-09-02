-- Model-inferred, evidence-backed likely facts. Kept separate from website
-- and Wikidata facts so inference can never be mistaken for verification.
ALTER TABLE enrichments
  ADD COLUMN IF NOT EXISTS inferred jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS inferred_at timestamptz;

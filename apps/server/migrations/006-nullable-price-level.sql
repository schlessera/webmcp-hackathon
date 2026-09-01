-- A place with no price on record must be able to say so. The column was NOT
-- NULL, so the seeder had to invent a band (2) for an unknown price, which the
-- budget predicate then compared against as if it were evidence — the exact
-- "unknown treated as verified" the eligibility rules exist to prevent.
-- CandidateRow.price_level was already typed number | null; the storage now
-- agrees, and null classifies as uncertain and counts as unknown in the price
-- facet.

ALTER TABLE candidates ALTER COLUMN price_level DROP NOT NULL;

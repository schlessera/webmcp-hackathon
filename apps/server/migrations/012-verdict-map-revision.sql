-- R3: screening verdicts are valid only for the exact candidate fact revision
-- the private agent saw. Existing verdicts are preserved against the current
-- revision; every later candidates.map_revision bump invalidates them without
-- requiring each fact-producing path to remember to delete rows.

ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS screened_map_revision integer;

UPDATE verdicts v
   SET screened_map_revision = c.map_revision
  FROM candidates c
 WHERE c.room_id = v.room_id
   AND c.id = v.candidate_id
   AND v.screened_map_revision IS NULL;

-- Orphaned verdicts cannot classify a candidate and should not prevent the
-- new invariant from being enforced.
DELETE FROM verdicts WHERE screened_map_revision IS NULL;

ALTER TABLE verdicts ALTER COLUMN screened_map_revision SET NOT NULL;

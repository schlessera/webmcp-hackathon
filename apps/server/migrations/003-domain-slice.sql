-- Domain slice: shared search scope, impasse adjustments, arrival plans,
-- proposal lifecycle statuses, and requirement ordering for the deterministic
-- minimal-conflict-set computation.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scope jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scope_seq integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS impasse_active boolean NOT NULL DEFAULT false;

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS created_at_revision integer NOT NULL DEFAULT 0;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS hours jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS committed_at_revision integer;

-- Council-computed counterfactuals. target/change reference the addressee's
-- own requirement or the shared scope — they are private to the addressee
-- until resolved (peers see aggregate resolution text only), so the wire
-- privacy tests assert these rows never serialize into peer payloads.
CREATE TABLE IF NOT EXISTS adjustments (
  id                      text PRIMARY KEY,
  room_id                 text NOT NULL REFERENCES rooms(id),
  kind                    text NOT NULL CHECK (kind IN ('scope_change', 'requirement_relaxation')),
  target                  jsonb NOT NULL,
  change                  jsonb NOT NULL,
  projected_gain          jsonb NOT NULL,
  requires_consent_of     text NOT NULL REFERENCES participants(id),
  within_delegated_bound  boolean NOT NULL DEFAULT false,
  status                  text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'staged_grant', 'granted', 'denied', 'expired')),
  created_at_revision     integer NOT NULL
);

CREATE TABLE IF NOT EXISTS arrival_plans (
  room_id         text NOT NULL REFERENCES rooms(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  mode            text NOT NULL CHECK (mode IN ('walk', 'bike', 'car')),
  pickup_note     text,
  at_revision     integer NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);

-- Proposal lifecycle (NEGOTIATION-PROTOCOL.md §7.3) as a closed set.
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_closed;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_closed
  CHECK (status IN ('open', 'withdrawn', 'vetoed', 'staged', 'committed'));

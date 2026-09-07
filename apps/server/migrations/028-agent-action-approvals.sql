-- Only the participant's page receives the opaque approval identifier.
-- The model can propose a command but cannot approve or change its arguments.
CREATE TABLE nl_pending_actions (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  command text NOT NULL,
  input jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX nl_pending_actions_owner ON nl_pending_actions(participant_id);

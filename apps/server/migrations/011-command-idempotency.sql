-- R6: a mutation response can be lost after commit. Persist the completed
-- response with the participant-scoped transport key so the retry is a read,
-- not a second command/event sequence.
CREATE TABLE IF NOT EXISTS command_idempotency (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS command_idempotency_expiry_idx
  ON command_idempotency (expires_at);

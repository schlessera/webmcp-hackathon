-- R7: an agent turn may commit one step before a later model/read failure.
-- Persist each mutation outcome as it happens so the participant's action
-- record survives the rest of the turn failing.

CREATE TABLE IF NOT EXISTS nl_agent_actions (
  id              bigserial PRIMARY KEY,
  turn_id         text NOT NULL,
  step            integer NOT NULL,
  room_id         text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id  text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  tool            text NOT NULL,
  ok              boolean NOT NULL,
  effect          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, step)
);

CREATE INDEX IF NOT EXISTS nl_agent_actions_participant
  ON nl_agent_actions (participant_id, created_at DESC);

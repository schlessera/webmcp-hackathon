-- Invariant 5 hardening: agent-private declarations are content-free — the
-- free-text note must stay out of server storage exactly like the payload.
ALTER TABLE requirements DROP CONSTRAINT IF EXISTS agent_private_has_no_payload;
ALTER TABLE requirements ADD CONSTRAINT agent_private_is_content_free
  CHECK (visibility <> 'agent-private' OR (payload IS NULL AND note IS NULL));

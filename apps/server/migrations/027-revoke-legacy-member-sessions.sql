-- Old creators knew these member credentials. Existing tokens cannot prove
-- which human exchanged them; rotate them and have members use join claims.
DELETE FROM participant_tokens t
USING participants p
WHERE t.participant_id = p.id AND p.role = 'member'
  AND EXISTS (SELECT 1 FROM invite_secrets s WHERE s.participant_id = p.id);

-- Session phase machine (NEGOTIATION-PROTOCOL.md §7.1) as a closed set, the
-- same discipline proposals.status already carries. `setup` and `closed` are
-- defined but unreachable in v1; `agreed` is entered at commit and `arrival`
-- once someone records how they are getting there.

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_phase_closed;
ALTER TABLE rooms ADD CONSTRAINT rooms_phase_closed
  CHECK (phase IN ('setup', 'gathering', 'deliberation', 'agreed', 'arrival', 'closed'));

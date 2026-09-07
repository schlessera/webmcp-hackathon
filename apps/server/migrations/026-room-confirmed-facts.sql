-- Guest confirmations belong only to the room that made them. Preserve
-- historical rows in their originating room; unowned legacy rows remain
-- quarantined (no room can read them), rather than being promoted as truth.
ALTER TABLE confirmed_facts DROP CONSTRAINT confirmed_facts_pkey;
ALTER TABLE confirmed_facts ADD CONSTRAINT confirmed_facts_room_key
  UNIQUE (room_id, osm_ref, criterion_id);

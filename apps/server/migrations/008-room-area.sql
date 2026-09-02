-- Which area a room negotiates over, and where its places came from. Both
-- nullable: rooms created before this migration (and bare test fixtures)
-- carry neither, and the spatial context simply omits the provenance line.
--
-- data_source is the honest provenance the UI shows:
--   { kind: 'osm-snapshot' | 'curated', areaId, label, source, extractTimestamp,
--     poolSize, focusVenues }

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area_id text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS data_source jsonb;

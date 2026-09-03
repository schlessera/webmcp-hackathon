-- A participant's private starting position. The JSON shape is
-- { lat, lng, label, source: "fixture" | "device" | "stated", updatedAt }.
-- Projection code must expose it only on that participant's own roster row.

ALTER TABLE participants ADD COLUMN IF NOT EXISTS origin jsonb;

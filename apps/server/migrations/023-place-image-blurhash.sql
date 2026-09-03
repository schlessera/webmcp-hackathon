-- Cheap same-origin image placeholders for summary and dossier readers.
-- Existing rows remain usable while the bounded backfill fills this column.
ALTER TABLE place_images
  ADD COLUMN IF NOT EXISTS blurhash text;

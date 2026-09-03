-- Re-harvest every site image under the page-image classifier policy and
-- every nearby Commons image under the short-name corroboration rule. Keep
-- URL-hash vision verdicts: their visual classification remains valid and
-- makes the site re-harvest cheap.
WITH purged AS (
  DELETE FROM place_images
   WHERE source LIKE 'web:%'
      OR source = 'commons:geosearch'
  RETURNING osm_ref
)
UPDATE enrichments
   SET image_fetched_at = NULL,
       image_expires_at = NULL,
       image_error = NULL
 WHERE osm_ref IN (SELECT DISTINCT osm_ref FROM purged);

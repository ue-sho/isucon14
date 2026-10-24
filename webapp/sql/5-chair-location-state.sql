-- Run after loading the reference data, with application writes stopped.
-- DELETE and INSERT share a transaction so a failed rebuild preserves old state.
START TRANSACTION;

DELETE FROM chair_location_state;

INSERT INTO chair_location_state
  (chair_id, latitude, longitude, recorded_at, total_distance)
WITH steps AS (
  SELECT chair_id, latitude, longitude, created_at,
         ABS(latitude - LAG(latitude) OVER location_order) +
         ABS(longitude - LAG(longitude) OVER location_order) AS distance,
         ROW_NUMBER() OVER (
           PARTITION BY chair_id ORDER BY created_at DESC, id DESC
         ) AS latest_rank
  FROM chair_locations
  WINDOW location_order AS (PARTITION BY chair_id ORDER BY created_at, id)
), totals AS (
  SELECT chair_id, latitude, longitude, created_at, latest_rank,
         SUM(COALESCE(distance, 0)) OVER (PARTITION BY chair_id) AS total_distance
  FROM steps
)
SELECT c.id, t.latitude, t.longitude, t.created_at,
       COALESCE(t.total_distance, 0)
FROM chairs c
LEFT JOIN totals t ON t.chair_id = c.id AND t.latest_rank = 1;

COMMIT;

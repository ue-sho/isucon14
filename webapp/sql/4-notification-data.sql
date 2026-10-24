-- Rebuild notification order after the reference initial data has been loaded.
INSERT INTO notification_events
  (recipient_type, recipient_id, seq, ride_id, ride_status_id, status, created_at)
SELECT recipient_type, recipient_id,
  ROW_NUMBER() OVER (PARTITION BY recipient_type, recipient_id
    ORDER BY ride_created_at, ride_id, created_at,
      FIELD(status, 'MATCHING', 'ENROUTE', 'PICKUP', 'CARRYING', 'ARRIVED', 'COMPLETED'), ride_status_id),
  ride_id, ride_status_id, status, created_at
FROM (
  SELECT 'app' AS recipient_type, r.user_id AS recipient_id, r.created_at AS ride_created_at,
    r.id AS ride_id, rs.id AS ride_status_id, rs.status, rs.created_at
  FROM rides r JOIN ride_statuses rs ON rs.ride_id = r.id
  UNION ALL
  SELECT 'chair', r.chair_id, r.created_at, r.id, rs.id, rs.status, rs.created_at
  FROM rides r JOIN ride_statuses rs ON rs.ride_id = r.id WHERE r.chair_id IS NOT NULL
) AS history;

INSERT INTO notification_streams (recipient_type, recipient_id, last_seq, written_seq)
SELECT e.recipient_type, e.recipient_id, MAX(e.seq),
  COALESCE(MIN(CASE WHEN
    (e.recipient_type = 'app' AND rs.app_sent_at IS NULL) OR
    (e.recipient_type = 'chair' AND rs.chair_sent_at IS NULL)
    THEN e.seq END) - 1, MAX(e.seq))
FROM notification_events e JOIN ride_statuses rs ON rs.id = e.ride_status_id
GROUP BY e.recipient_type, e.recipient_id;

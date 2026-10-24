import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import type { Coordinate } from "./types/models.js";

// The caller owns the transaction and locks the ride before updating this row.
export async function recordChairLocation(
  conn: PoolConnection,
  chairId: string,
  locationId: string,
  coordinate: Coordinate,
): Promise<Date> {
  // UPDATE locks the chair's row and evaluates the delta against its latest
  // committed coordinates. Add distance before overwriting those coordinates.
  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE chair_location_state
     SET total_distance = total_distance + CASE WHEN recorded_at IS NULL THEN 0
           ELSE ABS(latitude - ?) + ABS(longitude - ?) END,
         latitude = ?, longitude = ?,
         recorded_at = GREATEST(CURRENT_TIMESTAMP(6),
           COALESCE(recorded_at + INTERVAL 1 MICROSECOND, CURRENT_TIMESTAMP(6)))
     WHERE chair_id = ?`,
    [
      coordinate.latitude,
      coordinate.longitude,
      coordinate.latitude,
      coordinate.longitude,
      chairId,
    ],
  );
  if (result.affectedRows !== 1)
    throw new Error("chair location state missing");

  // Copy the exact DB timestamp, including microseconds, into the history.
  await conn.query(
    `INSERT INTO chair_locations (id, chair_id, latitude, longitude, created_at)
     SELECT ?, chair_id, latitude, longitude, recorded_at
     FROM chair_location_state WHERE chair_id = ?`,
    [locationId, chairId],
  );
  const [[location]] = await conn.query<
    Array<RowDataPacket & { recorded_at: Date }>
  >("SELECT recorded_at FROM chair_location_state WHERE chair_id = ?", [
    chairId,
  ]);
  return location.recorded_at;
}

import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { pool } from "./db.js";
import type { Ride } from "./types/models.js";

export type RecipientType = "app" | "chair";
export type NotificationEvent = RowDataPacket & {
  seq: number;
  ride_id: string;
  ride_status_id: string;
  status: string;
  pending: number;
};

const touched = new WeakMap<PoolConnection, Set<string>>();
export function takeNotificationTargets(conn: PoolConnection) {
  const keys = [...(touched.get(conn) ?? [])];
  touched.delete(conn);
  return keys;
}

async function appendEvent(
  conn: PoolConnection,
  type: RecipientType,
  recipientId: string,
  rideId: string,
  statusId: string,
  status: string,
) {
  const keys = touched.get(conn) ?? new Set<string>();
  keys.add(`${type}:${recipientId}`);
  touched.set(conn, keys);
  await conn.query(
    `INSERT INTO notification_streams (recipient_type, recipient_id, last_seq)
    VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_seq = last_seq + 1`,
    [type, recipientId],
  );
  await conn.query(
    `INSERT INTO notification_events
    (recipient_type, recipient_id, seq, ride_id, ride_status_id, status)
    SELECT recipient_type, recipient_id, last_seq, ?, ?, ? FROM notification_streams
    WHERE recipient_type = ? AND recipient_id = ?`,
    [rideId, statusId, status, type, recipientId],
  );
}

// The caller owns the transaction. Serialize status creation and assignment on the ride.
export async function insertRideStatus(
  conn: PoolConnection,
  rideId: string,
  status: string,
) {
  const [[ride]] = await conn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE id = ? FOR UPDATE",
    [rideId],
  );
  if (!ride) throw new Error("ride not found");
  const statusId = ulid();
  await conn.query(
    "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
    [statusId, rideId, status],
  );
  await appendEvent(conn, "app", ride.user_id, rideId, statusId, status);
  if (ride.chair_id)
    await appendEvent(conn, "chair", ride.chair_id, rideId, statusId, status);
}

export async function enqueueChairHistory(
  conn: PoolConnection,
  rideId: string,
  chairId: string,
) {
  const [statuses] = await conn.query<
    Array<RowDataPacket & { id: string; status: string }>
  >(
    "SELECT id, status FROM ride_statuses WHERE ride_id = ? ORDER BY created_at, FIELD(status, 'MATCHING', 'ENROUTE', 'PICKUP', 'CARRYING', 'ARRIVED', 'COMPLETED'), id",
    [rideId],
  );
  for (const status of statuses)
    await appendEvent(conn, "chair", chairId, rideId, status.id, status.status);
}

export async function recordWritten(
  conn: PoolConnection,
  type: RecipientType,
  id: string,
  event: NotificationEvent,
) {
  await conn.beginTransaction();
  try {
    const [result] = await conn.query<import("mysql2").ResultSetHeader>(
      "UPDATE notification_streams SET written_seq = ? WHERE recipient_type = ? AND recipient_id = ? AND written_seq = ?",
      [event.seq, type, id, event.seq - 1],
    );
    if (result.affectedRows !== 1)
      throw new Error("notification cursor changed");
    // Column name is selected from a closed enum, never client input.
    const column = type === "app" ? "app_sent_at" : "chair_sent_at";
    await conn.query(
      `UPDATE ride_statuses SET ${column} = COALESCE(${column}, CURRENT_TIMESTAMP(6)) WHERE id = ?`,
      [event.ride_status_id],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

// Read replay/current state and pending transitions in one snapshot. A separate
// latest-state query could overtake a newly committed pending transition.
export async function readEvents(
  type: RecipientType,
  id: string,
  includeLatest: boolean,
  limit = 64,
) {
  const [events] = await pool.query<NotificationEvent[]>(
    `SELECT e.seq, e.ride_id, e.ride_status_id, e.status, e.seq > s.written_seq AS pending
     FROM notification_events e JOIN notification_streams s USING (recipient_type, recipient_id)
     WHERE e.recipient_type = ? AND e.recipient_id = ?
       AND (e.seq > s.written_seq OR (? AND e.seq = s.last_seq))
     ORDER BY e.seq LIMIT ?`,
    [type, id, includeLatest, limit],
  );
  return events;
}

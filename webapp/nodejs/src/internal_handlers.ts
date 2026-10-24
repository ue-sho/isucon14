import type { Context } from "hono";
import type { RowDataPacket } from "mysql2";
import { enqueueChairHistory } from "./notification_repository.js";
import type { Environment } from "./types/hono.js";
import type { Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  // Keep oldest-request-first scheduling; minimize pickup travel time for it.
  const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at LIMIT 1",
  );
  if (!ride) {
    return ctx.body(null, 204);
  }
  // Include the fixed chair_id in the order so MySQL walks the existing
  // (chair_id, created_at) index backwards and stops at the first location.
  const [[matched]] = await ctx.var.dbConn.query<
    Array<RowDataPacket & { id: string }>
  >(
    `SELECT c.id
     FROM chairs c
     LEFT JOIN chair_models m ON m.name = c.model
     LEFT JOIN LATERAL (
       SELECT id, latitude, longitude FROM chair_locations WHERE chair_id = c.id
       ORDER BY chair_id DESC, created_at DESC LIMIT 1
     ) cl ON TRUE
     WHERE c.is_active = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM rides r WHERE r.chair_id = c.id
           AND (SELECT COUNT(rs.chair_sent_at) FROM ride_statuses rs
                WHERE rs.ride_id = r.id) <> 6
       )
     ORDER BY cl.id IS NULL,
       (ABS(cl.latitude - ?) + ABS(cl.longitude - ?)) /
         GREATEST(COALESCE(m.speed, 1), 1),
       c.id
     LIMIT 1`,
    [ride.pickup_latitude, ride.pickup_longitude],
  );
  // Prefer chairs with a known position, but retain the reference behavior of
  // allowing new chairs with no location or unknown model when necessary.
  if (!matched) {
    return ctx.body(null, 204);
  }
  await ctx.var.dbConn.beginTransaction();
  try {
    // Lock the chosen ride before assigning it; another matcher may have won.
    const [[current]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ? FOR UPDATE",
      [ride.id],
    );
    if (!current || current.chair_id) {
      await ctx.var.dbConn.rollback();
      return ctx.body(null, 204);
    }
    // Also serialize assignments to this chair and recheck availability.
    const [[chair]] = await ctx.var.dbConn.query<
      Array<RowDataPacket & { is_active: number }>
    >("SELECT is_active FROM chairs WHERE id = ? FOR UPDATE", [matched.id]);
    if (!chair?.is_active) {
      await ctx.var.dbConn.rollback();
      return ctx.body(null, 204);
    }
    const [[busy]] = await ctx.var.dbConn.query<
      Array<RowDataPacket & { n: number }>
    >(
      `SELECT EXISTS (
         SELECT 1 FROM rides r WHERE r.chair_id = ? AND
           (SELECT COUNT(rs.chair_sent_at) FROM ride_statuses rs WHERE rs.ride_id = r.id) <> 6
       ) AS n`,
      [matched.id],
    );
    if (busy.n > 0) {
      await ctx.var.dbConn.rollback();
      return ctx.body(null, 204);
    }
    await ctx.var.dbConn.query("UPDATE rides SET chair_id = ? WHERE id = ?", [
      matched.id,
      ride.id,
    ]);
    await enqueueChairHistory(ctx.var.dbConn, ride.id, matched.id);
    await ctx.var.dbConn.commit();
    return ctx.body(null, 204);
  } catch (error) {
    await ctx.var.dbConn.rollback();
    throw error;
  }
};

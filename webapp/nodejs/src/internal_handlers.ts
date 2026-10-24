import type { Context } from "hono";
import type { RowDataPacket } from "mysql2";
import { enqueueChairHistory } from "./notification_repository.js";
import type { Environment } from "./types/hono.js";
import type { Chair, Ride } from "./types/models.js";

// このAPIをインスタンス内から一定間隔で叩かせることで、椅子とライドをマッチングさせる
export const internalGetMatching = async (ctx: Context<Environment>) => {
  // MEMO: 一旦最も待たせているリクエストに適当な空いている椅子マッチさせる実装とする。おそらくもっといい方法があるはず…
  const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id IS NULL ORDER BY created_at LIMIT 1",
  );
  if (!ride) {
    return ctx.body(null, 204);
  }
  let matched!: Chair & RowDataPacket;
  let empty = false;
  for (let i = 0; i < 10; i++) {
    [[matched]] = await ctx.var.dbConn.query<Array<Chair & RowDataPacket>>(
      "SELECT * FROM chairs INNER JOIN (SELECT id FROM chairs WHERE is_active = TRUE ORDER BY RAND() LIMIT 1) AS tmp ON chairs.id = tmp.id LIMIT 1",
    );
    if (!matched) {
      return ctx.body(null, 204);
    }
    const [[result]] = await ctx.var.dbConn.query<
      Array<{ "COUNT(*) = 0": number } & RowDataPacket>
    >(
      "SELECT COUNT(*) = 0 FROM (SELECT COUNT(chair_sent_at) = 6 AS completed FROM ride_statuses WHERE ride_id IN (SELECT id FROM rides WHERE chair_id = ?) GROUP BY ride_id) is_completed WHERE completed = FALSE",
      [matched.id],
    );
    empty = !!result["COUNT(*) = 0"];
    if (empty) {
      break;
    }
  }
  if (!empty) {
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
    await ctx.var.dbConn.query(
      "SELECT id FROM chairs WHERE id = ? FOR UPDATE",
      [matched.id],
    );
    const [[busy]] = await ctx.var.dbConn.query<
      Array<RowDataPacket & { n: number }>
    >(
      `SELECT COUNT(*) AS n FROM rides r WHERE r.chair_id = ? AND
       (SELECT COUNT(rs.chair_sent_at) FROM ride_statuses rs WHERE rs.ride_id = r.id) <> 6`,
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

import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { RowDataPacket } from "mysql2";
import { ulid } from "ulid";
import { getLatestRideStatus } from "./common.js";
import type { Environment } from "./types/hono.js";
import type {
  Coordinate,
  Owner,
  Ride,
  RideStatus,
  User,
} from "./types/models.js";
import { secureRandomStr } from "./utils/random.js";

export const chairPostChairs = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{
    name: string;
    model: string;
    chair_register_token: string;
  }>();
  const { name, model, chair_register_token } = reqJson;
  if (!name || !model || !chair_register_token) {
    return ctx.text(
      "some of required fields(name, model, chair_register_token) are empty",
      400,
    );
  }
  const [[owner]] = await ctx.var.dbConn.query<Array<Owner & RowDataPacket>>(
    "SELECT * FROM owners WHERE chair_register_token = ?",
    [chair_register_token],
  );
  if (!owner) {
    return ctx.text("invalid chair_register_token", 401);
  }
  const chairID = ulid();
  const accessToken = secureRandomStr(32);
  await ctx.var.dbConn.query(
    "INSERT INTO chairs (id, owner_id, name, model, is_active, access_token) VALUES (?, ?, ?, ?, ?, ?)",
    [chairID, owner.id, name, model, false, accessToken],
  );

  setCookie(ctx, "chair_session", accessToken, { path: "/" });

  return ctx.json({ id: chairID, owner_id: owner.id }, 201);
};

export const chairPostActivity = async (ctx: Context<Environment>) => {
  const chair = ctx.var.chair;
  const reqJson = await ctx.req.json<{ is_active: boolean }>();
  try {
    await ctx.var.dbConn.query("UPDATE chairs SET is_active = ? WHERE id = ?", [
      reqJson.is_active,
      chair.id,
    ]);
  } catch (e) {
    return ctx.text(`${e}`, 500);
  }
  return ctx.body(null, 204);
};

type ChairCoordinateState = {
  recorded_at: Date;
  ride_id: string | null;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  latest_status: string | null;
};

export const chairPostCoordinate = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<Coordinate>();
  const chair = ctx.var.chair;
  const chairLocationID = ulid();
  await ctx.var.dbConn.beginTransaction();
  try {
    await ctx.var.dbConn.query(
      "INSERT INTO chair_locations (id, chair_id, latitude, longitude) VALUES (?, ?, ?, ?)",
      [chairLocationID, chair.id, reqJson.latitude, reqJson.longitude],
    );
    const [[state]] = await ctx.var.dbConn.query<
      Array<ChairCoordinateState & RowDataPacket>
    >(
      `SELECT cl.created_at AS recorded_at,
              r.id AS ride_id,
              r.pickup_latitude,
              r.pickup_longitude,
              r.destination_latitude,
              r.destination_longitude,
              (SELECT rs.status
               FROM ride_statuses rs
               WHERE rs.ride_id = r.id
               ORDER BY rs.created_at DESC
               LIMIT 1) AS latest_status
       FROM chair_locations cl
       LEFT JOIN rides r ON r.id = (
         SELECT newest.id
         FROM rides newest
         WHERE newest.chair_id = cl.chair_id
         ORDER BY newest.updated_at DESC
         LIMIT 1
       )
       WHERE cl.id = ?`,
      [chairLocationID],
    );
    if (state.ride_id !== null) {
      if (state.latest_status === null) {
        throw new Error("ride status not found");
      }
      if (
        reqJson.latitude === state.pickup_latitude &&
        reqJson.longitude === state.pickup_longitude &&
        state.latest_status === "ENROUTE"
      ) {
        await ctx.var.dbConn.query(
          "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
          [ulid(), state.ride_id, "PICKUP"],
        );
      }
      if (
        reqJson.latitude === state.destination_latitude &&
        reqJson.longitude === state.destination_longitude &&
        state.latest_status === "CARRYING"
      ) {
        await ctx.var.dbConn.query(
          "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
          [ulid(), state.ride_id, "ARRIVED"],
        );
      }
    }
    await ctx.var.dbConn.commit();
    return ctx.json({ recorded_at: state.recorded_at.getTime() }, 200);
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const chairGetNotification = async (ctx: Context<Environment>) => {
  const chair = ctx.var.chair;

  await ctx.var.dbConn.beginTransaction();
  try {
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE chair_id = ? ORDER BY updated_at DESC LIMIT 1",
      [chair.id],
    );
    if (!ride) {
      await ctx.var.dbConn.commit();
      return ctx.json({ retry_after_ms: 30 }, 200);
    }

    const [[yetSentRideStatus]] = await ctx.var.dbConn.query<
      Array<Pick<RideStatus, "id" | "status"> & RowDataPacket>
    >(
      "SELECT id, status FROM ride_statuses WHERE ride_id = ? AND chair_sent_at IS NULL ORDER BY created_at ASC LIMIT 1",
      [ride.id],
    );
    const status = yetSentRideStatus
      ? yetSentRideStatus.status
      : await getLatestRideStatus(ctx.var.dbConn, ride.id);

    const [[user]] = await ctx.var.dbConn.query<
      Array<Pick<User, "id" | "firstname" | "lastname"> & RowDataPacket>
    >(
      "SELECT id, firstname, lastname FROM users WHERE id = ? FOR SHARE",
      [ride.user_id],
    );

    if (yetSentRideStatus?.id) {
      await ctx.var.dbConn.query(
        "UPDATE ride_statuses SET chair_sent_at = CURRENT_TIMESTAMP(6) WHERE id = ?",
        [yetSentRideStatus.id],
      );
    }

    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        data: {
          ride_id: ride.id,
          user: {
            id: user.id,
            name: `${user.firstname} ${user.lastname}`,
          },
          pickup_coordinate: {
            latitude: ride.pickup_latitude,
            longitude: ride.pickup_longitude,
          },
          destination_coordinate: {
            latitude: ride.destination_latitude,
            longitude: ride.destination_longitude,
          },
          status,
        },
        retry_after_ms: 30,
      },
      200,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const chairPostRideStatus = async (ctx: Context<Environment>) => {
  const rideID = ctx.req.param("ride_id");
  const chair = ctx.var.chair;
  const reqJson = await ctx.req.json<{ status: string }>();
  await ctx.var.dbConn.beginTransaction();
  try {
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ? FOR UPDATE",
      [rideID],
    );
    if (!ride) {
      return ctx.text("ride not found", 404);
    }
    if (ride.chair_id !== chair.id) {
      return ctx.text("not assigned to this ride", 400);
    }
    switch (reqJson.status) {
      // Acknowledge the ride
      case "ENROUTE":
        await ctx.var.dbConn.query(
          "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
          [ulid(), ride.id, "ENROUTE"],
        );
        break;
      // After Picking up user
      case "CARRYING": {
        const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
        if (status !== "PICKUP") {
          return ctx.text("chair has not arrived yet", 400);
        }
        await ctx.var.dbConn.query(
          "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, ?)",
          [ulid(), ride.id, "CARRYING"],
        );
        break;
      }
      default:
        return ctx.text("invalid status", 400);
    }
    await ctx.var.dbConn.commit();
    return ctx.body(null, 204);
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

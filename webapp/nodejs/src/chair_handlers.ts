import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { RowDataPacket } from "mysql2";
import { ulid } from "ulid";
import { recordChairLocation } from "./chair_location_repository.js";
import { getLatestRideStatus } from "./common.js";
import { insertRideStatus } from "./notification_repository.js";
import { notificationResponse } from "./notification_stream.js";
import type { Environment } from "./types/hono.js";
import type { Coordinate, Owner, Ride } from "./types/models.js";
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
  await ctx.var.dbConn.beginTransaction();
  try {
    await ctx.var.dbConn.query(
      "INSERT INTO chairs (id, owner_id, name, model, is_active, access_token) VALUES (?, ?, ?, ?, ?, ?)",
      [chairID, owner.id, name, model, false, accessToken],
    );
    await ctx.var.dbConn.query(
      "INSERT INTO chair_location_state (chair_id) VALUES (?)",
      [chairID],
    );
    await ctx.var.dbConn.commit();
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }

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

export const chairPostCoordinate = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<Coordinate>();
  const chair = ctx.var.chair;
  const chairLocationID = ulid();
  await ctx.var.dbConn.beginTransaction();
  try {
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE chair_id = ? ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",
      [chair.id],
    );
    const recordedAt = await recordChairLocation(
      ctx.var.dbConn,
      chair.id,
      chairLocationID,
      reqJson,
    );
    if (ride) {
      const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
      if (status !== "COMPLETED" && status !== "CANCELED") {
        if (
          reqJson.latitude === ride.pickup_latitude &&
          reqJson.longitude === ride.pickup_longitude &&
          status === "ENROUTE"
        ) {
          await insertRideStatus(ctx.var.dbConn, ride.id, "PICKUP");
        }
        if (
          reqJson.latitude === ride.destination_latitude &&
          reqJson.longitude === ride.destination_longitude &&
          status === "CARRYING"
        ) {
          await insertRideStatus(ctx.var.dbConn, ride.id, "ARRIVED");
        }
      }
    }
    await ctx.var.dbConn.commit();
    return ctx.json({ recorded_at: recordedAt.getTime() }, 200);
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const chairGetNotification = (ctx: Context<Environment>) =>
  notificationResponse(ctx, "chair");

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
        await insertRideStatus(ctx.var.dbConn, ride.id, "ENROUTE");
        break;
      // After Picking up user
      case "CARRYING": {
        const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
        if (status !== "PICKUP") {
          return ctx.text("chair has not arrived yet", 400);
        }
        await insertRideStatus(ctx.var.dbConn, ride.id, "CARRYING");
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

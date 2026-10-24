import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import {
  ErroredUpstream,
  calculateFare,
  getLatestRideStatus,
} from "./common.js";
import { calculateDiscountedFare } from "./notification_payload.js";
import { insertRideStatus } from "./notification_repository.js";
import { notificationResponse } from "./notification_stream.js";
import { requestPaymentGatewayPostPayment } from "./payment_gateway.js";
import type { Environment } from "./types/hono.js";
import type {
  Chair,
  Coordinate,
  Coupon,
  Owner,
  PaymentToken,
  Ride,
  User,
} from "./types/models.js";
import type { CountResult } from "./types/util.js";
import { atoi } from "./utils/integer.js";
import { secureRandomStr } from "./utils/random.js";

type AppPostUserRequest = Readonly<{
  username: string;
  firstname: string;
  lastname: string;
  date_of_birth: string;
  invitation_code: string;
}>;

export const appPostUsers = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<AppPostUserRequest>();
  if (
    reqJson.username === "" ||
    reqJson.firstname === "" ||
    reqJson.lastname === "" ||
    reqJson.date_of_birth === ""
  ) {
    return ctx.text(
      "required fields(username, firstname, lastname, date_of_birth) are empty",
      400,
    );
  }
  const userId = ulid();
  const accessToken = secureRandomStr(32);
  const invitationCode = secureRandomStr(15);
  await ctx.var.dbConn.beginTransaction();
  try {
    await ctx.var.dbConn.query(
      "INSERT INTO users (id, username, firstname, lastname, date_of_birth, access_token, invitation_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        reqJson.username,
        reqJson.firstname,
        reqJson.lastname,
        reqJson.date_of_birth,
        accessToken,
        invitationCode,
      ],
    );

    // 初回登録キャンペーンのクーポンを付与
    await ctx.var.dbConn.query(
      "INSERT INTO coupons (user_id, code, discount) VALUES (?, ?, ?)",
      [userId, "CP_NEW2024", 3000],
    );

    // 招待コードを使った登録
    if (reqJson.invitation_code) {
      // 招待する側の招待数をチェック
      const [coupons] = await ctx.var.dbConn.query<
        Array<Coupon & RowDataPacket>
      >(
        "SELECT * FROM coupons WHERE code = ? FOR UPDATE",
        `INV_${reqJson.invitation_code}`,
      );
      if (coupons.length >= 3) {
        return ctx.text("この招待コードは使用できません。", 400);
      }

      // ユーザーチェック
      const [inviter] = await ctx.var.dbConn.query<Array<User & RowDataPacket>>(
        "SELECT * FROM users WHERE invitation_code = ?",
        [reqJson.invitation_code],
      );
      if (inviter.length === 0) {
        return ctx.text("この招待コードは使用できません。", 400);
      }

      // 招待クーポン付与
      await ctx.var.dbConn.query(
        "INSERT INTO coupons (user_id, code, discount) VALUES (?, ?, ?)",
        [userId, `INV_${reqJson.invitation_code}`, 1500],
      );
      // 招待した人にもRewardを付与
      await ctx.var.dbConn.query(
        "INSERT INTO coupons (user_id, code, discount) VALUES (?, CONCAT(?, '_', FLOOR(UNIX_TIMESTAMP(NOW(3))*1000)), ?)",
        [inviter[0].id, `RWD_${reqJson.invitation_code}`, 1000],
      );
    }

    await ctx.var.dbConn.commit();
    setCookie(ctx, "app_session", accessToken, {
      path: "/",
    });

    return ctx.json(
      {
        id: userId,
        invitation_code: invitationCode,
      },
      201,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostPaymentMethods = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{ token: string }>();
  if (reqJson.token === "") {
    return ctx.text("token is required but was empty", 400);
  }
  const user = ctx.var.user;
  await ctx.var.dbConn.query(
    "INSERT INTO payment_tokens (user_id, token) VALUES (?, ?)",
    [user.id, reqJson.token],
  );
  return ctx.body(null, 204);
};

type GetAppRidesResponseItem = {
  id: string;
  pickup_coordinate: Coordinate;
  destination_coordinate: Coordinate;
  chair: {
    id: string;
    owner: string;
    name: string;
    model: string;
  };
  fare: number;
  evaluation: number | null;
  requested_at: number;
  completed_at: number;
};

export const appGetRides = async (ctx: Context<Environment>) => {
  const user = ctx.var.user;
  await ctx.var.dbConn.beginTransaction();
  const items: GetAppRidesResponseItem[] = [];
  try {
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE user_id = ? ORDER BY created_at DESC",
      [user.id],
    );
    for (const ride of rides) {
      const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
      if (status !== "COMPLETED") {
        continue;
      }

      const fare = await calculateDiscountedFare(
        ctx.var.dbConn,
        user.id,
        ride,
        ride.pickup_latitude,
        ride.pickup_longitude,
        ride.destination_latitude,
        ride.destination_longitude,
      );

      const [[chair]] = await ctx.var.dbConn.query<
        Array<Chair & RowDataPacket>
      >("SELECT * FROM chairs WHERE id = ?", [ride.chair_id]);
      const [[owner]] = await ctx.var.dbConn.query<
        Array<Owner & RowDataPacket>
      >("SELECT * FROM owners WHERE id = ?", [chair.owner_id]);
      const item = {
        id: ride.id,
        pickup_coordinate: {
          latitude: ride.pickup_latitude,
          longitude: ride.pickup_longitude,
        },
        destination_coordinate: {
          latitude: ride.destination_latitude,
          longitude: ride.destination_longitude,
        },
        fare,
        evaluation: ride.evaluation,
        requested_at: ride.created_at.getTime(),
        completed_at: ride.updated_at.getTime(),
        chair: {
          id: chair.id,
          name: chair.name,
          model: chair.model,
          owner: owner.name,
        },
      };
      items.push(item);
    }
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        rides: items,
      },
      200,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRides = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{
    pickup_coordinate: Coordinate;
    destination_coordinate: Coordinate;
  }>();
  if (!reqJson.pickup_coordinate || !reqJson.destination_coordinate) {
    return ctx.text(
      "required fields(pickup_coordinate, destination_coordinate) are empty",
      400,
    );
  }
  const user = ctx.var.user;
  const rideId = ulid();
  await ctx.var.dbConn.beginTransaction();
  try {
    const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE user_id = ?",
      [user.id],
    );
    let continuingRideCount = 0;
    for (const ride of rides) {
      const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
      if (status !== "COMPLETED") {
        continuingRideCount++;
      }
    }
    if (continuingRideCount > 0) {
      return ctx.text("ride already exists", 409);
    }
    await ctx.var.dbConn.query(
      "INSERT INTO rides (id, user_id, pickup_latitude, pickup_longitude, destination_latitude, destination_longitude) VALUES (?, ?, ?, ?, ?, ?)",
      [
        rideId,
        user.id,
        reqJson.pickup_coordinate.latitude,
        reqJson.pickup_coordinate.longitude,
        reqJson.destination_coordinate.latitude,
        reqJson.destination_coordinate.longitude,
      ],
    );
    await insertRideStatus(ctx.var.dbConn, rideId, "MATCHING");
    const [[{ "COUNT(*)": rideCount }]] = await ctx.var.dbConn.query<
      Array<CountResult & RowDataPacket>
    >("SELECT COUNT(*) FROM rides WHERE user_id = ?", [user.id]);
    if (rideCount === 1) {
      // 初回利用で、初回利用クーポンがあれば必ず使う
      const [[coupon]] = await ctx.var.dbConn.query<
        Array<Coupon & RowDataPacket>
      >(
        "SELECT * FROM coupons WHERE user_id = ? AND code = 'CP_NEW2024' AND used_by IS NULL FOR UPDATE",
        [user.id],
      );

      if (!coupon) {
        // 無ければ他のクーポンを付与された順番に使う
        const [[coupon]] = await ctx.var.dbConn.query<
          Array<Coupon & RowDataPacket>
        >(
          "SELECT * FROM coupons WHERE user_id = ? AND used_by IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE",
          [user.id],
        );

        if (coupon) {
          await ctx.var.dbConn.query(
            "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = ?",
            [rideId, user.id, coupon.code],
          );
        }
      } else {
        await ctx.var.dbConn.query(
          "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = 'CP_NEW2024'",
          [rideId, user.id],
        );
      }
    } else {
      // 他のクーポンを付与された順番に使う
      const [[coupon]] = await ctx.var.dbConn.query<
        Array<Coupon & RowDataPacket>
      >(
        "SELECT * FROM coupons WHERE user_id = ? AND used_by IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE",
        [user.id],
      );
      if (coupon) {
        await ctx.var.dbConn.query(
          "UPDATE coupons SET used_by = ? WHERE user_id = ? AND code = ?",
          [rideId, user.id, coupon.code],
        );
      }
    }
    const [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ?",
      [rideId],
    );
    const fare = await calculateDiscountedFare(
      ctx.var.dbConn,
      user.id,
      ride,
      reqJson.pickup_coordinate.latitude,
      reqJson.pickup_coordinate.longitude,
      reqJson.destination_coordinate.latitude,
      reqJson.destination_coordinate.longitude,
    );
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        ride_id: rideId,
        fare,
      },
      202,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRidesEstimatedFare = async (ctx: Context<Environment>) => {
  const reqJson = await ctx.req.json<{
    pickup_coordinate: Coordinate;
    destination_coordinate: Coordinate;
  }>();
  if (!reqJson.pickup_coordinate || !reqJson.destination_coordinate) {
    return ctx.text(
      "required fields(pickup_coordinate, destination_coordinate) are empty",
      400,
    );
  }
  const user = ctx.var.user;
  await ctx.var.dbConn.beginTransaction();
  try {
    const discounted = await calculateDiscountedFare(
      ctx.var.dbConn,
      user.id,
      null,
      reqJson.pickup_coordinate.latitude,
      reqJson.pickup_coordinate.longitude,
      reqJson.destination_coordinate.latitude,
      reqJson.destination_coordinate.longitude,
    );
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        fare: discounted,
        discount:
          calculateFare(
            reqJson.pickup_coordinate.latitude,
            reqJson.pickup_coordinate.longitude,
            reqJson.destination_coordinate.latitude,
            reqJson.destination_coordinate.longitude,
          ) - discounted,
      },
      200,
    );
  } catch (e) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${e}`, 500);
  }
};

export const appPostRideEvaluatation = async (ctx: Context<Environment>) => {
  const rideId = ctx.req.param("ride_id");
  const reqJson = await ctx.req.json<{ evaluation: number }>();
  if (reqJson.evaluation < 1 || reqJson.evaluation > 5) {
    return ctx.text("evaluation must be between 1 and 5", 400);
  }
  await ctx.var.dbConn.beginTransaction();
  try {
    let [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ? FOR UPDATE",
      rideId,
    );
    if (!ride) {
      return ctx.text("ride not found", 404);
    }
    const status = await getLatestRideStatus(ctx.var.dbConn, ride.id);
    if (status !== "ARRIVED") {
      return ctx.text("not arrived yet", 400);
    }

    const [result] = await ctx.var.dbConn.query<ResultSetHeader>(
      "UPDATE rides SET evaluation = ? WHERE id = ?",
      [reqJson.evaluation, rideId],
    );
    if (result.affectedRows === 0) {
      return ctx.text("ride not found", 404);
    }

    await insertRideStatus(ctx.var.dbConn, rideId, "COMPLETED");

    [[ride]] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
      "SELECT * FROM rides WHERE id = ?",
      rideId,
    );
    if (!ride) {
      return ctx.text("ride not found", 404);
    }

    const [[paymentToken]] = await ctx.var.dbConn.query<
      Array<PaymentToken & RowDataPacket>
    >("SELECT * FROM payment_tokens WHERE user_id = ?", [ride.user_id]);
    if (!paymentToken) {
      return ctx.text("payment token not registered", 400);
    }
    const fare = await calculateDiscountedFare(
      ctx.var.dbConn,
      ride.user_id,
      ride,
      ride.pickup_latitude,
      ride.pickup_longitude,
      ride.destination_latitude,
      ride.destination_longitude,
    );
    const paymentGatewayRequest = { amount: fare };

    const [[{ value: paymentGatewayURL }]] = await ctx.var.dbConn.query<
      Array<string & RowDataPacket>
    >("SELECT value FROM settings WHERE name = 'payment_gateway_url'");
    const err = await requestPaymentGatewayPostPayment(
      paymentGatewayURL,
      paymentToken.token,
      paymentGatewayRequest,
      async () => {
        const [rides] = await ctx.var.dbConn.query<Array<Ride & RowDataPacket>>(
          "SELECT * FROM rides WHERE user_id = ? ORDER BY created_at ASC",
          [ride.user_id],
        );
        return rides;
      },
    );
    if (err instanceof ErroredUpstream) {
      return ctx.text(`${err}`, 502);
    }
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        completed_at: ride.updated_at.getTime(),
      },
      200,
    );
  } catch (err) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${err}`, 500);
  }
};

export const appGetNotification = (ctx: Context<Environment>) =>
  notificationResponse(ctx, "app");

export const appGetNearbyChairs = async (ctx: Context<Environment>) => {
  const latStr = ctx.req.query("latitude");
  const lonStr = ctx.req.query("longitude");
  const distanceStr = ctx.req.query("distance");
  if (!latStr || !lonStr) {
    return ctx.text("latitude and longitude is empty", 400);
  }

  const lat = atoi(latStr);
  if (lat === false) {
    return ctx.text("latitude is invalid", 400);
  }
  const lon = atoi(lonStr);
  if (lon === false) {
    return ctx.text("longitude is invalid", 400);
  }

  let distance: number | false = 50;
  if (distanceStr) {
    distance = atoi(distanceStr);
    if (distance === false) {
      return ctx.text("distance is invalid", 400);
    }
  }

  await ctx.var.dbConn.beginTransaction();
  try {
    // 相関先のIDも並び順に含め、既存の複合インデックスを逆順に読む。
    const [chairs] = await ctx.var.dbConn.query<
      Array<
        {
          id: string;
          name: string;
          model: string;
          latitude: number;
          longitude: number;
        } & RowDataPacket
      >
    >(
      `SELECT chairs.id, chairs.name, chairs.model,
              location.latitude, location.longitude
       FROM chairs
       JOIN chair_locations location ON location.id = (
         SELECT id FROM chair_locations
         WHERE chair_id = chairs.id
         ORDER BY chair_id DESC, created_at DESC LIMIT 1
       )
       WHERE chairs.is_active = TRUE
         AND ABS(location.latitude - ?) + ABS(location.longitude - ?) <= ?
         AND NOT EXISTS (
           SELECT 1 FROM rides
           WHERE rides.chair_id = chairs.id
             AND COALESCE((
               SELECT status FROM ride_statuses
               WHERE ride_id = rides.id
               ORDER BY ride_id DESC, created_at DESC LIMIT 1
             ), '') <> 'COMPLETED'
         )`,
      [lat, lon, distance],
    );
    const nearbyChairs = chairs.map((chair) => ({
      id: chair.id,
      name: chair.name,
      model: chair.model,
      current_coordinate: {
        latitude: chair.latitude,
        longitude: chair.longitude,
      },
    }));

    const [[{ "CURRENT_TIMESTAMP(6)": retrievedAt }]] =
      await ctx.var.dbConn.query<
        Array<{ "CURRENT_TIMESTAMP(6)": Date } & RowDataPacket>
      >("SELECT CURRENT_TIMESTAMP(6)");
    await ctx.var.dbConn.commit();
    return ctx.json(
      {
        chairs: nearbyChairs,
        retrieved_at: retrievedAt.getTime(),
      },
      200,
    );
  } catch (err) {
    await ctx.var.dbConn.rollback();
    return ctx.text(`${err}`, 500);
  }
};

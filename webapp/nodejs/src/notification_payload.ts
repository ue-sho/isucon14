import type { Connection, RowDataPacket } from "mysql2/promise";
import {
  FARE_PER_DISTANCE,
  INITIAL_FARE,
  calculateDistance,
} from "./common.js";
import type {
  Chair,
  Coordinate,
  Coupon,
  Ride,
  RideStatus,
} from "./types/models.js";

type AppGetNotificationResponseData = {
  ride_id: string;
  pickup_coordinate: Coordinate;
  destination_coordinate: Coordinate;
  fare: number;
  status: string;
  chair?: {
    id: string;
    name: string;
    model: string;
    stats: {
      total_rides_count: number;
      total_evaluation_avg: number;
    };
  };
  created_at: number;
  updated_at: number;
};

type AppGetNotificationResponse = {
  data: AppGetNotificationResponseData;
  retry_after_ms?: number;
};

export async function appNotificationData(
  dbConn: Connection,
  ride: Ride,
  status: string,
) {
  const fare = await calculateDiscountedFare(
    dbConn,
    ride.user_id,
    ride,
    ride.pickup_latitude,
    ride.pickup_longitude,
    ride.destination_latitude,
    ride.destination_longitude,
  );

  const response: AppGetNotificationResponse = {
    data: {
      ride_id: ride.id,
      pickup_coordinate: {
        latitude: ride.pickup_latitude,
        longitude: ride.pickup_longitude,
      },
      destination_coordinate: {
        latitude: ride.destination_latitude,
        longitude: ride.destination_longitude,
      },
      fare,
      status,
      created_at: ride.created_at.getTime(),
      updated_at: ride.updated_at.getTime(),
    },
    retry_after_ms: 30,
  };
  if (ride.chair_id !== null) {
    const [[chair]] = await dbConn.query<Array<Chair & RowDataPacket>>(
      "SELECT * FROM chairs WHERE id = ?",
      [ride.chair_id],
    );
    const stats = await getChairStats(dbConn, chair.id);
    response.data.chair = {
      id: chair.id,
      name: chair.name,
      model: chair.model,
      stats: {
        total_rides_count: stats.total_rides_count,
        total_evaluation_avg: stats.total_evaluation_avg,
      },
    };
  }

  return response.data;
}

type AppGetNotificationResponseChairStats = {
  total_rides_count: number;
  total_evaluation_avg: number;
};

async function getChairStats(
  dbConn: Connection,
  chairId: string,
): Promise<AppGetNotificationResponseChairStats> {
  const [rides] = await dbConn.query<Array<Ride & RowDataPacket>>(
    "SELECT * FROM rides WHERE chair_id = ? ORDER BY updated_at DESC",
    [chairId],
  );

  if (rides.length === 0) {
    return {
      total_rides_count: 0,
      total_evaluation_avg: 0,
    };
  }

  const [allStatuses] = await dbConn.query<Array<RideStatus & RowDataPacket>>(
    `SELECT rs.*
     FROM ride_statuses AS rs
     JOIN rides AS r ON r.id = rs.ride_id
     WHERE r.chair_id = ?
     ORDER BY rs.ride_id, rs.created_at`,
    [chairId],
  );
  const statusesByRideId = new Map<string, RideStatus[]>();
  for (const status of allStatuses) {
    const statuses = statusesByRideId.get(status.ride_id);
    if (statuses) {
      statuses.push(status);
    } else {
      statusesByRideId.set(status.ride_id, [status]);
    }
  }

  let totalRidesCount = 0;
  let totalEvaluation = 0.0;
  for (const ride of rides) {
    const rideStatuses = statusesByRideId.get(ride.id) ?? [];
    let arrivedAt: Date | undefined;
    let pickupedAt: Date | undefined;
    let isCompleted = false;
    for (const status of rideStatuses) {
      if (status.status === "ARRIVED") {
        arrivedAt = status.created_at;
      } else if (status.status === "CARRYING") {
        pickupedAt = status.created_at;
      }
      if (status.status === "COMPLETED") {
        isCompleted = true;
      }
      if (!arrivedAt || !pickupedAt) {
        continue;
      }
      if (!isCompleted) {
        continue;
      }

      totalRidesCount++;
      totalEvaluation += ride.evaluation ?? 0;
    }
  }
  return {
    total_rides_count: totalRidesCount,
    total_evaluation_avg:
      totalRidesCount > 0 ? totalEvaluation / totalRidesCount : 0,
  };
}

export async function calculateDiscountedFare(
  dbConn: Connection,
  userId: string,
  ride: Ride | null,
  _pickupLatitude: number,
  _pickupLongitude: number,
  _destinationLatitude: number,
  _destinationLongitude: number,
): Promise<number> {
  let discount = 0;
  let destinationLatitude = _destinationLatitude;
  let destinationLongitude = _destinationLongitude;
  let pickupLatitude = _pickupLatitude;
  let pickupLongitude = _pickupLongitude;
  if (ride) {
    destinationLatitude = ride.destination_latitude;
    destinationLongitude = ride.destination_longitude;
    pickupLatitude = ride.pickup_latitude;
    pickupLongitude = ride.pickup_longitude;

    // すでにクーポンが紐づいているならそれの割引額を参照
    const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
      "SELECT * FROM coupons WHERE used_by = ?",
      ride.id,
    );
    if (coupon) {
      discount = coupon.discount;
    }
  } else {
    // 初回利用クーポンを最優先で使う
    const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
      "SELECT * FROM coupons WHERE user_id = ? AND code = 'CP_NEW2024' AND used_by IS NULL",
      [userId],
    );
    if (coupon) {
      discount = coupon.discount;
    } else {
      // 無いなら他のクーポンを付与された順番に使う
      const [[coupon]] = await dbConn.query<Array<Coupon & RowDataPacket>>(
        "SELECT * FROM coupons WHERE user_id = ? AND used_by IS NULL ORDER BY created_at LIMIT 1",
        [userId],
      );
      if (coupon) {
        discount = coupon.discount;
      }
    }
  }
  const meteredFare =
    FARE_PER_DISTANCE *
    calculateDistance(
      pickupLatitude,
      pickupLongitude,
      destinationLatitude,
      destinationLongitude,
    );
  const discountedMeteredFare = Math.max(meteredFare - discount, 0);

  return INITIAL_FARE + discountedMeteredFare;
}

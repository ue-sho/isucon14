import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import {
  createConnection,
  createPool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { ulid } from "ulid";
import { appGetNearbyChairs } from "../src/app_handlers.js";
import { chairPostChairs, chairPostCoordinate } from "../src/chair_handlers.js";
import {
  chairAuthMiddleware,
  ownerAuthMiddleware,
} from "../src/middlewares.js";
import {
  insertRideStatus,
  takeNotificationTargets,
} from "../src/notification_repository.js";
import { ownerGetChairs } from "../src/owner_handlers.js";
import type { Environment } from "../src/types/hono.js";

// Only an explicit, nonstandard loopback port is accepted. Every run creates
// its own random database and rewrites the schema/dump USE before executing it.
const port = Number(process.env.LOCATION_STATE_TEST_MYSQL_PORT);
const database = `test_location_${randomUUID().replace(/-/g, "")}`;
const config = {
  host: "127.0.0.1",
  port,
  user: "root",
  password: process.env.LOCATION_STATE_TEST_MYSQL_PASSWORD ?? "",
  timezone: "+00:00",
  multipleStatements: true,
};
const db = createPool({ ...config, database });
const app = new Hono<Environment>();
let ownerId: string;
let ownerToken: string;
let registerToken: string;
let failQuery = "";
let failCommit = false;
let frozenTime = false;
let databaseCreated = false;

app.use(async (ctx, next) => {
  const conn = await db.getConnection();
  const wrapped = {
    beginTransaction: () => conn.beginTransaction(),
    rollback: () => conn.rollback(),
    commit: () => {
      if (failCommit) throw new Error("injected commit failure");
      return conn.commit();
    },
    query: (sql: string, values?: unknown[]) => {
      if (failQuery && sql.includes(failQuery))
        throw new Error("injected SQL failure");
      return conn.query(sql, values);
    },
  } as PoolConnection;
  ctx.set("dbConn", wrapped);
  try {
    if (frozenTime) await conn.query("SET timestamp = 1790000000");
    await next();
  } finally {
    await conn.rollback();
    await conn.query("SET timestamp = DEFAULT");
    takeNotificationTargets(wrapped);
    conn.release();
  }
});
app.post("/api/chair/chairs", chairPostChairs);
app.post("/api/chair/coordinate", chairAuthMiddleware, chairPostCoordinate);
app.get("/api/owner/chairs", ownerAuthMiddleware, ownerGetChairs);
app.get("/api/app/nearby-chairs", appGetNearbyChairs);

async function register() {
  const response = await app.request("/api/chair/chairs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test chair",
      model: "test",
      chair_register_token: registerToken,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { id } = await response.json();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { id: id as string, cookie };
}

async function coordinate(cookie: string, latitude: number, longitude: number) {
  return app.request("/api/chair/coordinate", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ latitude, longitude }),
  });
}

async function report(cookie: string, latitude: number, longitude: number) {
  const response = await coordinate(cookie, latitude, longitude);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).recorded_at as number;
}

async function state(id: string) {
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT *, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s.%f') AS exact_time
     FROM chair_location_state WHERE chair_id = ?`,
    [id],
  );
  return row;
}

async function ownerChairs() {
  const response = await app.request("/api/owner/chairs", {
    headers: { Cookie: `owner_session=${ownerToken}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).chairs as Array<{
    id: string;
    total_distance: number;
    total_distance_updated_at?: number;
  }>;
}

async function rebuild() {
  await db.query(
    await readFile(
      new URL("../../sql/5-chair-location-state.sql", import.meta.url),
      "utf8",
    ),
  );
}

async function assertMatchesHistory() {
  const [history] = await db.query<RowDataPacket[]>(
    `SELECT chair_id, latitude, longitude,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS exact_time
     FROM chair_locations ORDER BY chair_id, created_at, id`,
  );
  const expected = new Map<
    string,
    { latitude: number; longitude: number; distance: number; time: string }
  >();
  for (const row of history) {
    const prev = expected.get(row.chair_id);
    expected.set(row.chair_id, {
      latitude: row.latitude,
      longitude: row.longitude,
      time: row.exact_time,
      distance: prev
        ? prev.distance +
          Math.abs(prev.latitude - row.latitude) +
          Math.abs(prev.longitude - row.longitude)
        : 0,
    });
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT c.id, s.latitude, s.longitude, s.total_distance,
            DATE_FORMAT(s.recorded_at, '%Y-%m-%d %H:%i:%s.%f') AS exact_time
     FROM chairs c LEFT JOIN chair_location_state s ON s.chair_id = c.id`,
  );
  for (const row of rows) {
    const prev = expected.get(row.id);
    assert.deepEqual(
      [row.latitude, row.longitude, Number(row.total_distance), row.exact_time],
      prev
        ? [prev.latitude, prev.longitude, prev.distance, prev.time]
        : [null, null, 0, null],
      `history differs for chair ${row.id}`,
    );
  }
}

describe(
  "chair location state with isolated MySQL",
  { skip: !process.env.LOCATION_STATE_TEST_MYSQL_PORT },
  () => {
    before(async () => {
      assert.ok(
        Number.isInteger(port) && port > 1024 && port <= 65535 && port !== 3306,
      );
      const admin = await createConnection(config);
      try {
        await admin.query(
          `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
        );
        databaseCreated = true;
        const schema = await readFile(
          new URL("../../sql/1-schema.sql", import.meta.url),
          "utf8",
        );
        assert.ok(schema.includes("USE isuride;"));
        await admin.query(
          schema.replace("USE isuride;", `USE \`${database}\`;`),
        );
      } finally {
        await admin.end();
      }
    });

    beforeEach(async () => {
      failQuery = "";
      failCommit = false;
      frozenTime = false;
      for (const table of [
        "notification_events",
        "notification_streams",
        "ride_statuses",
        "rides",
        "chair_locations",
        "chair_location_state",
        "chairs",
        "owners",
        "users",
        "coupons",
        "payment_tokens",
      ])
        await db.query(`DELETE FROM ${table}`);
      ownerId = ulid();
      ownerToken = ulid();
      registerToken = ulid();
      await db.query(
        "INSERT INTO owners (id, name, access_token, chair_register_token) VALUES (?, ?, ?, ?)",
        [ownerId, ownerId, ownerToken, registerToken],
      );
    });

    after(async () => {
      try {
        if (databaseCreated)
          await db.query(`DROP DATABASE IF EXISTS \`${database}\``);
      } finally {
        await db.end();
      }
    });

    test("registration creates empty state and owner response omits its timestamp", async () => {
      const chair = await register();
      assert.deepEqual(await ownerChairs(), [
        {
          id: chair.id,
          name: "Test chair",
          model: "test",
          active: false,
          registered_at: (
            await db.query<RowDataPacket[]>(
              "SELECT created_at FROM chairs WHERE id = ?",
              [chair.id],
            )
          )[0][0].created_at.getTime(),
          total_distance: 0,
        },
      ]);
      await assertMatchesHistory();
    });

    test("first report, repeated coordinates, negative coordinates and round trips match history", async () => {
      const chair = await register();
      const first = await report(chair.cookie, 0, 0);
      assert.equal((await state(chair.id)).total_distance, 0);
      await report(chair.cookie, 3, 4);
      assert.equal((await state(chair.id)).total_distance, 7);
      const prev = await state(chair.id);
      await report(chair.cookie, 3, 4);
      const repeated = await state(chair.id);
      assert.equal(repeated.total_distance, 7);
      assert.ok(repeated.exact_time > prev.exact_time);
      await report(chair.cookie, 0, 0);
      assert.equal((await state(chair.id)).total_distance, 14);
      const last = await report(chair.cookie, -3, -4);
      assert.equal((await state(chair.id)).total_distance, 21);
      assert.ok(last >= first);
      const own = (await ownerChairs())[0];
      assert.equal(own.total_distance, 21);
      assert.equal(own.total_distance_updated_at, last);
      await assertMatchesHistory();
    });

    test("owner filtering and nearby search retain the API behavior", async () => {
      const chair = await register();
      await report(chair.cookie, 10, 20);
      await db.query("UPDATE chairs SET is_active = TRUE WHERE id = ?", [
        chair.id,
      ]);
      await db.query(
        "INSERT INTO chairs (id, owner_id, name, model, is_active, access_token) VALUES ('other', 'other-owner', 'Other', 'test', 0, 'other-token')",
      );
      await db.query(
        "INSERT INTO chair_location_state (chair_id) VALUES ('other')",
      );
      assert.deepEqual(
        (await ownerChairs()).map((c) => c.id),
        [chair.id],
      );
      const response = await app.request(
        "/api/app/nearby-chairs?latitude=10&longitude=20&distance=0",
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.chairs[0].id, chair.id);
      assert.deepEqual(body.chairs[0].current_coordinate, {
        latitude: 10,
        longitude: 20,
      });
    });

    test("parallel reports have no lost distance and preserve history order even at a frozen DB time", async () => {
      const chair = await register();
      frozenTime = true;
      await report(chair.cookie, 0, 0);
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          report(chair.cookie, i - 5, 2 * i),
        ),
      );
      const [[counts]] = await db.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT created_at) AS times FROM chair_locations WHERE chair_id = ?",
        [chair.id],
      );
      assert.equal(counts.n, 13);
      assert.equal(counts.times, 13);
      await assertMatchesHistory();
      const before = await state(chair.id);
      await rebuild();
      assert.deepEqual(await state(chair.id), before);
    });

    test("a failed COMMIT rolls back both history and accumulated distance", async () => {
      const chair = await register();
      await report(chair.cookie, 1, 2);
      const before = await state(chair.id);
      failCommit = true;
      assert.equal((await coordinate(chair.cookie, 30, 40)).status, 500);
      failCommit = false;
      assert.deepEqual(await state(chair.id), before);
      const [[count]] = await db.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM chair_locations",
      );
      assert.equal(count.n, 1);
      await report(chair.cookie, 30, 40);
      await assertMatchesHistory();
    });

    test("registration is rolled back if its state cannot be created", async () => {
      failQuery = "INSERT INTO chair_location_state";
      const response = await app.request("/api/chair/chairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "failure",
          model: "test",
          chair_register_token: registerToken,
        }),
      });
      assert.equal(response.status, 500);
      const [[count]] = await db.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM chairs",
      );
      assert.equal(count.n, 0);
    });

    test("missing state fails without silently resetting historical distance", async () => {
      const chair = await register();
      await report(chair.cookie, 0, 0);
      await report(chair.cookie, 3, 4);
      await db.query("DELETE FROM chair_location_state WHERE chair_id = ?", [
        chair.id,
      ]);
      const response = await coordinate(chair.cookie, 10, 20);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /chair location state missing/);
      const [[count]] = await db.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM chair_locations WHERE chair_id = ?",
        [chair.id],
      );
      assert.equal(count.n, 2);
      await rebuild();
      assert.equal(Number((await state(chair.id)).total_distance), 7);
      await report(chair.cookie, 10, 20);
      await assertMatchesHistory();
    });

    test("arrival, notification events, history and distance commit and roll back together", async () => {
      const chair = await register();
      await report(chair.cookie, 0, 0);
      const rideId = ulid();
      await db.query(
        "INSERT INTO rides (id, user_id, chair_id, pickup_latitude, pickup_longitude, destination_latitude, destination_longitude) VALUES (?, 'test-user', ?, 1, 2, 3, 4)",
        [rideId, chair.id],
      );
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        await insertRideStatus(conn, rideId, "ENROUTE");
        await conn.commit();
      } finally {
        takeNotificationTargets(conn);
        conn.release();
      }
      const before = await state(chair.id);
      failQuery = "INSERT INTO notification_events";
      assert.equal((await coordinate(chair.cookie, 1, 2)).status, 500);
      failQuery = "";
      assert.deepEqual(await state(chair.id), before);
      const [[counts]] = await db.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM ride_statuses) AS statuses, (SELECT COUNT(*) FROM notification_events) AS events, (SELECT COUNT(*) FROM chair_locations) AS locations",
      );
      assert.deepEqual(
        [counts.statuses, counts.events, counts.locations],
        [1, 2, 1],
      );
      await Promise.all([
        report(chair.cookie, 1, 2),
        report(chair.cookie, 1, 2),
      ]);
      await db.query(
        "INSERT INTO ride_statuses (id, ride_id, status) VALUES (?, ?, 'CARRYING')",
        [ulid(), rideId],
      );
      await report(chair.cookie, 3, 4);
      const [statuses] = await db.query<RowDataPacket[]>(
        "SELECT status, COUNT(*) AS n FROM ride_statuses GROUP BY status",
      );
      assert.deepEqual(
        Object.fromEntries(statuses.map((r) => [r.status, r.n])),
        { ENROUTE: 1, PICKUP: 1, CARRYING: 1, ARRIVED: 1 },
      );
      const [events] = await db.query<RowDataPacket[]>(
        "SELECT recipient_type, status FROM notification_events WHERE status IN ('PICKUP', 'ARRIVED') ORDER BY recipient_type, seq",
      );
      assert.deepEqual(
        events.map((r) => [r.recipient_type, r.status]),
        [
          ["app", "PICKUP"],
          ["app", "ARRIVED"],
          ["chair", "PICKUP"],
          ["chair", "ARRIVED"],
        ],
      );
      await assertMatchesHistory();
    });

    test("rebuild restores all reference chairs, is repeatable, and new reports continue their distance", async () => {
      const compressed = await readFile(
        new URL("../../sql/3-initial-data.sql.gz", import.meta.url),
      );
      const initial = gunzipSync(compressed).toString("utf8");
      assert.match(initial, /USE `isuride`;/);
      await db.query(initial.replace("USE `isuride`;", `USE \`${database}\`;`));
      await rebuild();
      const [[counts]] = await db.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n, SUM(recorded_at IS NULL) AS empty_count FROM chair_location_state",
      );
      assert.equal(counts.n, 500);
      assert.equal(Number(counts.empty_count), 113);
      await assertMatchesHistory();
      await rebuild();
      await assertMatchesHistory();
      const [[chair]] = await db.query<RowDataPacket[]>(
        "SELECT c.id, c.access_token, s.latitude, s.longitude FROM chairs c JOIN chair_location_state s ON s.chair_id = c.id WHERE s.recorded_at IS NOT NULL LIMIT 1",
      );
      const old = await state(chair.id);
      await report(
        `chair_session=${chair.access_token}`,
        chair.latitude + 3,
        chair.longitude - 4,
      );
      assert.equal(
        Number((await state(chair.id)).total_distance),
        Number(old.total_distance) + 7,
      );
      await assertMatchesHistory();
    });
  },
);

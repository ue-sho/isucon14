import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import {
  createConnection,
  type Connection,
  type PoolConnection,
} from "mysql2/promise";
import { appGetNearbyChairs } from "../src/app_handlers.js";
import type { Environment } from "../src/types/hono.js";

// Opt in with a local MySQL socket. All tables live in a new, isolated database;
// this suite never initializes the application's database or starts its server.
const socketPath = process.env.NEARBY_TEST_MYSQL_SOCKET;
const database = `test_nearby_${randomUUID().replace(/-/g, "")}`;
let conn: Connection;
let sequence = 0;
const queries: string[] = [];
const app = new Hono<Environment>();

app.get("/", (ctx) => {
  ctx.set("dbConn", {
    beginTransaction: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    query: (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return conn.query(sql, values);
    },
  } as PoolConnection);
  return appGetNearbyChairs(ctx);
});

async function chair(id: string, active = true) {
  await conn.query(
    `INSERT INTO chairs (id, owner_id, name, model, is_active, access_token)
     VALUES (?, 'owner', ?, 'test model', ?, ?)`,
    [id, `chair ${id}`, active, `test-token-${id}`],
  );
}

async function location(
  id: string,
  latitude: number,
  longitude: number,
  second = 0,
) {
  await conn.query(
    `INSERT INTO chair_locations (id, chair_id, latitude, longitude, created_at)
     VALUES (?, ?, ?, ?, TIMESTAMPADD(SECOND, ?, '2026-01-01 00:00:00'))`,
    [`location-${++sequence}`, id, latitude, longitude, second],
  );
}

async function ride(chairId: string | null, statuses: string[]) {
  const id = `ride-${++sequence}`;
  await conn.query(
    `INSERT INTO rides (id, user_id, chair_id, pickup_latitude, pickup_longitude,
                       destination_latitude, destination_longitude)
     VALUES (?, 'user', ?, 1, 2, 3, 4)`,
    [id, chairId],
  );
  for (const [second, status] of statuses.entries()) {
    await conn.query(
      `INSERT INTO ride_statuses (id, ride_id, status, created_at)
       VALUES (?, ?, ?, TIMESTAMPADD(SECOND, ?, '2026-01-01 00:00:00'))`,
      [`status-${++sequence}`, id, status, second],
    );
  }
}

async function search(params = "latitude=10&longitude=20") {
  queries.length = 0;
  const response = await app.request(`/?${params}`);
  assert.equal(
    response.status,
    200,
    response.status === 200 ? "" : await response.text(),
  );
  const body = await response.json();
  assert.equal(
    queries.length,
    2,
    "search and retrieved_at should take two queries",
  );
  assert.ok(Math.abs(Date.now() - body.retrieved_at) < 2000);
  return body.chairs as Array<{
    id: string;
    name: string;
    model: string;
    current_coordinate: { latitude: number; longitude: number };
  }>;
}

describe("nearby chairs with real MySQL", { skip: !socketPath }, () => {
  before(async () => {
    conn = await createConnection({
      socketPath,
      user: "root",
      timezone: "+00:00",
      multipleStatements: true,
    });
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const schema = await readFile(
      new URL("../../sql/1-schema.sql", import.meta.url),
      "utf8",
    );
    assert.ok(schema.includes("USE isuride;"));
    await conn.query(schema.replace("USE isuride;", `USE \`${database}\`;`));
  });

  beforeEach(async () => {
    for (const table of ["ride_statuses", "rides", "chair_locations", "chairs"])
      await conn.query(`DELETE FROM ${table}`);
    queries.length = 0;
  });

  after(async () => {
    if (!conn) return;
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await conn.end();
    }
  });

  test("uses the latest coordinate and excludes inactive, busy, missing and distant chairs", async () => {
    for (const id of [
      "idle",
      "completed",
      "busy",
      "old-busy",
      "no-location",
      "outside",
      "inside",
      "boundary",
      "diagonal",
      "beyond",
    ])
      await chair(id);
    await chair("offline", false);
    for (const id of ["idle", "completed", "busy", "old-busy", "offline"])
      await location(id, 10, 20);
    await location("outside", 100, 100, 2);
    await location("outside", 10, 20, 1); // Insert the older position last.
    await location("inside", 10, 20, 2);
    await location("inside", 100, 100, 1);
    await location("boundary", 60, 20);
    await location("diagonal", 35, 45);
    await location("beyond", 36, 45);
    await ride("completed", ["MATCHING", "ENROUTE", "COMPLETED"]);
    await ride("completed", ["MATCHING", "COMPLETED"]);
    await ride("busy", ["MATCHING", "CARRYING"]);
    await ride("old-busy", ["MATCHING", "ENROUTE"]);
    await ride("old-busy", ["MATCHING", "COMPLETED"]);
    await ride(null, ["MATCHING"]);

    const chairs = await search();
    assert.deepEqual(chairs.map((c) => c.id).sort(), [
      "boundary",
      "completed",
      "diagonal",
      "idle",
      "inside",
    ]);
    assert.deepEqual(
      chairs.find((c) => c.id === "inside"),
      {
        id: "inside",
        name: "chair inside",
        model: "test model",
        current_coordinate: { latitude: 10, longitude: 20 },
      },
    );
  });

  test("returns empty results with a fixed query count, including when no chairs exist", async () => {
    assert.deepEqual(await search(), []);
    await chair("far");
    await location("far", 100, 100);
    assert.deepEqual(await search(), []);
  });

  test("handles zero and custom distance and negative coordinates", async () => {
    await chair("origin");
    await chair("edge");
    await location("origin", -10, -20);
    await location("edge", -13, -24);
    assert.deepEqual(
      (await search("latitude=-10&longitude=-20&distance=0")).map((c) => c.id),
      ["origin"],
    );
    assert.deepEqual(
      (await search("latitude=-10&longitude=-20&distance=7"))
        .map((c) => c.id)
        .sort(),
      ["edge", "origin"],
    );
    assert.deepEqual(
      await search("latitude=-10&longitude=-20&distance=-1"),
      [],
    );
  });

  test("reflects committed position, activity and ride state changes on the next request", async () => {
    await chair("changing");
    await location("changing", 10, 20);
    assert.equal((await search()).length, 1);
    await location("changing", 100, 100, 1);
    assert.deepEqual(await search(), []);
    await location("changing", 10, 20, 2);
    await conn.query(
      "UPDATE chairs SET is_active = FALSE WHERE id = 'changing'",
    );
    assert.deepEqual(await search(), []);
    await conn.query(
      "UPDATE chairs SET is_active = TRUE WHERE id = 'changing'",
    );
    await ride("changing", ["MATCHING"]);
    assert.deepEqual(await search(), []);
    await conn.query("UPDATE ride_statuses SET status = 'COMPLETED'");
    assert.equal((await search()).length, 1);
  });

  test("rejects invalid parameters without querying the database", async () => {
    for (const [params, message] of [
      ["longitude=20", "latitude and longitude is empty"],
      ["latitude=10", "latitude and longitude is empty"],
      ["latitude=invalid&longitude=20", "latitude is invalid"],
      ["latitude=10&longitude=invalid", "longitude is invalid"],
      ["latitude=10&longitude=20&distance=invalid", "distance is invalid"],
    ]) {
      queries.length = 0;
      const response = await app.request(`/?${params}`);
      assert.equal(response.status, 400);
      assert.equal(await response.text(), message);
      assert.equal(queries.length, 0);
    }
  });
});

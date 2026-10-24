import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import type { RowDataPacket } from "mysql2";
import { ulid } from "ulid";
import { pool } from "../src/db.js";
import { internalGetMatching } from "../src/internal_handlers.js";
import type { Environment } from "../src/types/hono.js";

// This suite recreates the schema. Only run against an isolated local MySQL.
const enabled = process.env.MATCHING_TEST_MYSQL === "1";
const statuses = [
  "MATCHING",
  "ENROUTE",
  "PICKUP",
  "CARRYING",
  "ARRIVED",
  "COMPLETED",
];
function app(beforeTransaction?: () => Promise<void>) {
  const result = new Hono<Environment>();
  result.use("*", async (ctx, next) => {
    const conn = await pool.getConnection();
    const proxy = new Proxy(conn, {
      get(target, key) {
        if (key === "beginTransaction" && beforeTransaction) {
          return async () => {
            await beforeTransaction();
            await target.beginTransaction();
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    ctx.set("dbConn", proxy);
    try {
      await next();
    } finally {
      await conn.rollback();
      conn.release();
    }
  });
  result.get("/matching", internalGetMatching);
  return result;
}
async function chair(model: string, lat?: number, lon = 0, active = true) {
  const id = ulid();
  await pool.query(
    "INSERT INTO chairs(id,owner_id,name,model,is_active,access_token) VALUES (?,?,'test',?,?,?)",
    [id, ulid(), model, active, id],
  );
  if (lat !== undefined) await location(id, lat, lon, "2026-10-24 00:00:01");
  return id;
}
async function location(id: string, lat: number, lon: number, at: string) {
  await pool.query(
    "INSERT INTO chair_locations(id,chair_id,latitude,longitude,created_at) VALUES (?,?,?,?,?)",
    [ulid(), id, lat, lon, at],
  );
}
async function ride(
  chairId: string | null = null,
  completed = false,
  sent = false,
  at = "2026-10-24 00:00:01",
) {
  const id = ulid();
  await pool.query(
    `INSERT INTO rides(id,user_id,chair_id,pickup_latitude,pickup_longitude,destination_latitude,destination_longitude,created_at)
     VALUES (?,?,?,0,0,10,10,?)`,
    [id, ulid(), chairId, at],
  );
  for (const status of completed ? statuses : ["MATCHING"]) {
    await pool.query(
      "INSERT INTO ride_statuses(id,ride_id,status,chair_sent_at) VALUES (?,?,?,?)",
      [ulid(), id, status, sent ? "2026-10-24 00:00:02" : null],
    );
  }
  return id;
}
async function assigned(id: string) {
  const [[r]] = await pool.query<
    Array<RowDataPacket & { chair_id: string | null }>
  >("SELECT chair_id FROM rides WHERE id = ?", [id]);
  return r.chair_id;
}
async function match(instance = app()) {
  const response = await instance.request("/matching");
  assert.equal(response.status, 204, await response.text());
}

describe("ETA matching with MySQL", { skip: !enabled }, () => {
  before(async () => {
    assert.ok(
      ["127.0.0.1", "localhost"].includes(
        process.env.ISUCON_DB_HOST || "127.0.0.1",
      ),
    );
    assert.ok(
      process.env.ISUCON_DB_PORT && process.env.ISUCON_DB_PORT !== "3306",
    );
    const schema = await readFile(
      new URL("../../sql/1-schema.sql", import.meta.url),
      "utf8",
    );
    for (const statement of schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pool.query(statement);
    }
  });
  beforeEach(async () => {
    for (const table of [
      "notification_events",
      "notification_streams",
      "ride_statuses",
      "rides",
      "chair_locations",
      "chairs",
      "chair_models",
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query(
      "INSERT INTO chair_models(name,speed) VALUES ('slow',2),('fast',7)",
    );
  });
  after(async () => {
    await pool.end();
  });

  test("chooses pickup time over shortest distance and queues MATCHING history", async () => {
    await chair("slow", 4); // ETA 2
    const fast = await chair("fast", -7, 1); // Manhattan ETA 8/7
    const id = await ride();
    await match();
    assert.equal(await assigned(id), fast);
    const [[event]] = await pool.query<RowDataPacket[]>(
      "SELECT recipient_id,status FROM notification_events",
    );
    assert.equal(event.recipient_id, fast);
    assert.equal(event.status, "MATCHING");
  });
  test("uses the newest location, not an old closer one", async () => {
    const stale = await chair("fast", 0);
    await location(stale, 100, 100, "2026-10-24 00:00:02");
    const near = await chair("slow", 1);
    const id = await ride();
    await match();
    assert.equal(await assigned(id), near);
  });
  test("excludes inactive, busy, and completed-but-unnotified chairs", async () => {
    await chair("fast", 0, 0, false);
    const busy = await chair("fast", 0);
    await ride(busy);
    const unnotified = await chair("fast", 0);
    await ride(unnotified, true, false);
    const free = await chair("slow", 10);
    await ride(free, true, true);
    const id = await ride();
    await match();
    assert.equal(await assigned(id), free);
  });
  test("keeps oldest-request-first scheduling", async () => {
    const free = await chair("fast", 0);
    const newer = await ride(null, false, false, "2026-10-24 00:00:02");
    const older = await ride(null, false, false, "2026-10-24 00:00:01");
    await match();
    assert.equal(await assigned(older), free);
    assert.equal(await assigned(newer), null);
  });
  test("prefers known positions and still allows new chairs and unknown models", async () => {
    const unknown = await chair("unregistered");
    const known = await chair("slow", 100);
    const first = await ride();
    await match();
    assert.equal(await assigned(first), known);
    const second = await ride();
    await match();
    assert.equal(await assigned(second), unknown);
  });
  test("returns without assignment when no chair is free", async () => {
    const busy = await chair("fast", 0);
    await ride(busy);
    const id = await ride();
    await match();
    assert.equal(await assigned(id), null);
    const [[events]] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM notification_events",
    );
    assert.equal(events.n, 0);
  });
  test("rechecks an activity change after candidate selection", async () => {
    const selected = await chair("fast", 0);
    const id = await ride();
    await match(
      app(async () => {
        await pool.query("UPDATE chairs SET is_active = FALSE WHERE id = ?", [
          selected,
        ]);
      }),
    );
    assert.equal(await assigned(id), null);
  });
  test("rechecks a chair assigned by another matcher after candidate selection", async () => {
    const selected = await chair("fast", 0);
    const id = await ride();
    await match(
      app(async () => {
        await ride(selected);
      }),
    );
    assert.equal(await assigned(id), null);
  });
  test("concurrent matchers cannot double-assign a chair or duplicate history", async () => {
    const selected = await chair("fast", 0);
    await ride(null, false, false, "2026-10-24 00:00:01");
    await ride(null, false, false, "2026-10-24 00:00:02");
    const instance = app();
    await Promise.all(Array.from({ length: 8 }, () => match(instance)));
    const [[count]] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM rides WHERE chair_id = ?",
      [selected],
    );
    assert.equal(count.n, 1);
    const [[events]] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM notification_events",
    );
    assert.equal(events.n, 1);
  });
});

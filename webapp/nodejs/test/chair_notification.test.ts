import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import type { RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { pool } from "../src/db.js";
import {
  enqueueChairHistory,
  insertRideStatus,
  readEvents,
} from "../src/notification_repository.js";
import { notificationResponse } from "../src/notification_stream.js";
import type { Environment } from "../src/types/hono.js";

// This suite resets its database. Require an explicit opt-in and a loopback,
// nonstandard MySQL port so it cannot accidentally target s1 or a default DB.
const enabled = process.env.SSE_TEST_MYSQL === "1";
const base = "http://127.0.0.1:18081";
let server: ChildProcess;
let output = "";
const streams: Array<{ close: () => void }> = [];
async function waitFor(check: () => Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await delay(10);
  }
}
async function start(transport = "sse") {
  server = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: "18081", NOTIFICATION_TRANSPORT: transport },
    stdio: ["ignore", "pipe", "pipe"],
  });
  output = "";
  server.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  await waitFor(async () => {
    assert.equal(server.exitCode, null, output);
    return output.includes("Server is running");
  }, 10000);
}
async function stop() {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
async function initialize() {
  const start = Date.now();
  const response = await fetch(`${base}/api/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payment_server: "http://127.0.0.1:12345" }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.ok(Date.now() - start < 30000, "initialize exceeded 30 seconds");
}
async function fixture() {
  const user = ulid();
  const chair = ulid();
  await pool.query(
    `INSERT INTO users (id, username, firstname, lastname, date_of_birth, access_token, invitation_code)
    VALUES (?, ?, 'Test', 'User', '2000-01-01', ?, ?)`,
    [user, user, user, user],
  );
  await pool.query(
    `INSERT INTO chairs (id, owner_id, name, model, is_active, access_token)
    VALUES (?, ?, 'Test chair', 'test', 1, ?)`,
    [chair, ulid(), chair],
  );
  return { user, chair };
}
async function ride(
  user: string,
  chair: string | null,
  statuses = ["MATCHING"],
) {
  const id = ulid();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO rides (id, user_id, chair_id, pickup_latitude, pickup_longitude,
      destination_latitude, destination_longitude) VALUES (?, ?, ?, 1, 2, 3, 4)`,
      [id, user, chair],
    );
    for (const status of statuses) await insertRideStatus(conn, id, status);
    await conn.commit();
  } finally {
    await conn.rollback();
    conn.release();
  }
  return id;
}
async function open(type: "app" | "chair", id: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/${type}/notification`, {
    headers: { Cookie: `${type}_session=${id}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  const messages: Array<null | {
    ride_id: string;
    status: string;
    fare?: number;
  }> = [];
  assert.ok(response.body);
  const reader = response.body.getReader();
  let ended = false;
  const pumping = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("data: "))
            messages.push(JSON.parse(frame.slice(6)));
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      /* aborted connections are expected in this suite */
    } finally {
      ended = true;
    }
  })();
  const stream = {
    messages,
    pumping,
    get ended() {
      return ended;
    },
    close: () => controller.abort(),
    count: (n: number) => waitFor(async () => messages.length >= n),
  };
  streams.push(stream);
  return stream;
}
async function written(type: string, id: string, seq: number) {
  await waitFor(async () => {
    const [[row]] = await pool.query<RowDataPacket[]>(
      "SELECT written_seq FROM notification_streams WHERE recipient_type = ? AND recipient_id = ?",
      [type, id],
    );
    return row?.written_seq === seq;
  });
}

describe(
  "SSE notifications with real MySQL",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      assert.equal(process.env.ISUCON_DB_HOST ?? "127.0.0.1", "127.0.0.1");
      assert.equal(process.env.ISUCON_DB_NAME ?? "isuride", "isuride");
      assert.ok(
        process.env.ISUCON_DB_PORT && process.env.ISUCON_DB_PORT !== "3306",
      );
      await start();
      await initialize();
    });
    after(async () => {
      for (const stream of streams) stream.close();
      await stop();
      await pool.end();
    });

    test("authenticates both notification routes", async () => {
      for (const type of ["app", "chair"]) {
        const response = await fetch(`${base}/api/${type}/notification`);
        assert.equal(response.status, 401);
        const invalid = await fetch(`${base}/api/${type}/notification`, {
          headers: { Cookie: `${type}_session=invalid` },
        });
        assert.equal(invalid.status, 401);
      }
    });

    test("delivers null immediately and does not hold DB connections for idle streams", async () => {
      const opened = [];
      for (let i = 0; i < 24; i++) {
        const f = await fixture();
        const stream = await open(
          i % 2 ? "chair" : "app",
          i % 2 ? f.chair : f.user,
        );
        await stream.count(1);
        assert.deepEqual(stream.messages, [null]);
        opened.push(stream);
      }
      const f = await fixture();
      const response = await fetch(`${base}/api/app/rides`, {
        headers: { Cookie: `app_session=${f.user}` },
      });
      assert.equal(response.status, 200);
      for (const stream of opened) stream.close();
    });

    test("delivers every transition across rides to both recipients and replays latest on reconnect", async () => {
      const f = await fixture();
      const statuses = [
        "MATCHING",
        "ENROUTE",
        "PICKUP",
        "CARRYING",
        "ARRIVED",
        "COMPLETED",
      ];
      const first = await ride(f.user, f.chair, statuses);
      const second = await ride(f.user, f.chair, ["MATCHING", "ENROUTE"]);
      for (const [type, id] of [
        ["app", f.user],
        ["chair", f.chair],
      ] as const) {
        const stream = await open(type, id);
        await stream.count(8);
        assert.deepEqual(
          stream.messages.map((m) => [m?.ride_id, m?.status]),
          [
            ...statuses.map((s) => [first, s]),
            [second, "MATCHING"],
            [second, "ENROUTE"],
          ],
        );
        if (type === "app") assert.equal(stream.messages[0]?.fare, 900);
        await written(type, id, 8);
        stream.close();
        await stream.pumping;
        const reconnected = await open(type, id);
        await reconnected.count(1);
        assert.equal(reconnected.messages[0]?.status, "ENROUTE");
        reconnected.close();
      }
      const [[row]] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(app_sent_at) AS app, COUNT(chair_sent_at) AS chair FROM ride_statuses WHERE ride_id IN (?, ?)",
        [first, second],
      );
      assert.equal(row.app, 8);
      assert.equal(row.chair, 8);
    });

    test("does not publish rolled back states and reconciles committed states without a wake event", async () => {
      const f = await fixture();
      const stream = await open("app", f.user);
      await stream.count(1);
      const id = await ride(f.user, null);
      await stream.count(2); // committed directly in another process: periodic reconciliation
      assert.equal(stream.messages[1]?.status, "MATCHING");
      await written("app", f.user, 1);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await insertRideStatus(conn, id, "ENROUTE");
        assert.equal((await readEvents("app", f.user, false)).length, 0);
        await conn.rollback();
        await delay(1100);
        assert.equal(stream.messages.length, 2);
      } finally {
        await conn.rollback();
        conn.release();
      }
      stream.close();
    });

    test("assignment enqueues MATCHING for the chair and API commits wake streams", async () => {
      const f = await fixture();
      const id = await ride(f.user, null);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("SELECT id FROM rides WHERE id = ? FOR UPDATE", [id]);
        await conn.query("UPDATE rides SET chair_id = ? WHERE id = ?", [
          f.chair,
          id,
        ]);
        await enqueueChairHistory(conn, id, f.chair);
        await conn.commit();
      } finally {
        await conn.rollback();
        conn.release();
      }
      const stream = await open("chair", f.chair);
      await stream.count(1);
      assert.equal(stream.messages[0]?.status, "MATCHING");
      const response = await fetch(`${base}/api/chair/rides/${id}/status`, {
        method: "POST",
        headers: {
          Cookie: `chair_session=${f.chair}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "ENROUTE" }),
      });
      assert.equal(response.status, 204, await response.text());
      await stream.count(2);
      assert.equal(stream.messages[1]?.status, "ENROUTE");
      stream.close();
    });

    test("all live status producers enqueue ordered events and refresh chair statistics", async () => {
      const f = await fixture();
      const app = await open("app", f.user);
      await app.count(1);
      const response = await fetch(`${base}/api/app/rides`, {
        method: "POST",
        headers: {
          Cookie: `app_session=${f.user}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pickup_coordinate: { latitude: 1, longitude: 2 },
          destination_coordinate: { latitude: 3, longitude: 4 },
        }),
      });
      assert.equal(
        response.status,
        202,
        response.status === 202 ? "" : await response.text(),
      );
      const { ride_id: id } = await response.json();
      await app.count(2);
      assert.equal(app.messages[1]?.status, "MATCHING");
      // Isolate the reference random matcher to this ride/chair.
      await pool.query("UPDATE chairs SET is_active = FALSE");
      await pool.query("UPDATE chairs SET is_active = TRUE WHERE id = ?", [
        f.chair,
      ]);
      await pool.query(
        "UPDATE rides SET chair_id = ? WHERE chair_id IS NULL AND id <> ?",
        [ulid(), id],
      );
      const matched = await fetch(`${base}/api/internal/matching`);
      assert.equal(matched.status, 204, await matched.text());
      const chair = await open("chair", f.chair);
      await chair.count(1);
      const post = async (path: string, body: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            Cookie: `chair_session=${f.chair}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        assert.ok(res.ok, await res.text());
      };
      await post(`/api/chair/rides/${id}/status`, { status: "ENROUTE" });
      await Promise.all([
        post("/api/chair/coordinate", { latitude: 1, longitude: 2 }),
        post("/api/chair/coordinate", { latitude: 1, longitude: 2 }),
      ]);
      await post(`/api/chair/rides/${id}/status`, { status: "CARRYING" });
      await post("/api/chair/coordinate", { latitude: 3, longitude: 4 });
      const payment = createServer((req, res) => {
        req.resume();
        res.writeHead(204);
        res.end();
      });
      payment.listen(0, "127.0.0.1");
      await once(payment, "listening");
      try {
        const address = payment.address();
        assert.ok(address && typeof address !== "string");
        await pool.query(
          "UPDATE settings SET value = ? WHERE name = 'payment_gateway_url'",
          [`http://127.0.0.1:${address.port}`],
        );
        await pool.query(
          "INSERT INTO payment_tokens (user_id, token) VALUES (?, 'test')",
          [f.user],
        );
        const evaluated = await fetch(
          `${base}/api/app/rides/${id}/evaluation`,
          {
            method: "POST",
            headers: {
              Cookie: `app_session=${f.user}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ evaluation: 5 }),
          },
        );
        assert.equal(evaluated.status, 200, await evaluated.text());
        await app.count(7);
        await chair.count(6);
        const statuses = [
          "MATCHING",
          "ENROUTE",
          "PICKUP",
          "CARRYING",
          "ARRIVED",
          "COMPLETED",
        ];
        assert.deepEqual(
          app.messages.slice(1).map((m) => m?.status),
          statuses,
        );
        assert.deepEqual(
          chair.messages.map((m) => m?.status),
          statuses,
        );
        const last = app.messages.at(-1) as unknown as {
          chair: {
            stats: { total_rides_count: number; total_evaluation_avg: number };
          };
        };
        assert.deepEqual(last.chair.stats, {
          total_rides_count: 1,
          total_evaluation_avg: 5,
        });
        await written("chair", f.chair, 6);
      } finally {
        payment.closeAllConnections();
        await new Promise<void>((resolve) => payment.close(() => resolve()));
        app.close();
        chair.close();
      }
    });

    test("canceling an unread stream leaves every transition pending", async () => {
      const f = await fixture();
      await ride(f.user, null, ["MATCHING", "ENROUTE", "PICKUP"]);
      const local = new Hono<Environment>();
      local.get("/", (ctx) => notificationResponse(ctx, "app"));
      const controller = new AbortController();
      const response = await local.request("/", {
        headers: { Cookie: `app_session=${f.user}` },
        signal: controller.signal,
      });
      await delay(50);
      controller.abort();
      await response.body?.cancel();
      await delay(20);
      assert.equal((await readEvents("app", f.user, false)).length, 3);
    });

    test("an unread slow stream times out without advancing its cursor", async () => {
      const f = await fixture();
      await ride(f.user, null);
      const local = new Hono<Environment>();
      local.get("/", (ctx) => notificationResponse(ctx, "app"));
      const response = await local.request("/", {
        headers: { Cookie: `app_session=${f.user}` },
      });
      await delay(2200);
      assert.equal((await readEvents("app", f.user, false)).length, 1);
      assert.ok(response.body);
      await assert.rejects(
        response.body.getReader().read(),
        /notification closed/,
      );
    });

    test("failed send leaves the event pending and overlapping reconnects serialize delivery", async () => {
      const f = await fixture();
      await ride(f.user, null, ["MATCHING", "ENROUTE", "PICKUP"]);
      // Cancel before consuming a frame, then establish competing replacements.
      const controller = new AbortController();
      const response = await fetch(`${base}/api/app/notification`, {
        headers: { Cookie: `app_session=${f.user}` },
        signal: controller.signal,
      });
      controller.abort();
      await response.body?.cancel().catch(() => {});
      const first = await open("app", f.user);
      const second = await open("app", f.user);
      await second.count(1);
      await written("app", f.user, 3);
      assert.equal(second.messages.at(-1)?.status, "PICKUP");
      await waitFor(async () => first.ended);
      second.close();
    });

    test("initialize rejects concurrent resets and API traffic while DDL waits", async () => {
      const conn = await pool.getConnection();
      let reset: Promise<void> | undefined;
      try {
        await conn.beginTransaction();
        await conn.query("SELECT id FROM users LIMIT 1 FOR SHARE");
        reset = initialize();
        await waitFor(async () => {
          const res = await fetch(`${base}/api/app/notification`);
          return res.status === 503;
        });
        const concurrent = await fetch(`${base}/api/initialize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_server: "http://127.0.0.1:12345" }),
        });
        assert.equal(concurrent.status, 503);
        await conn.rollback();
        await reset;
      } finally {
        await conn.rollback();
        conn.release();
        await reset;
      }
    });

    test("initialize closes old streams, clears new tables and is repeatable", async () => {
      const f = await fixture();
      await ride(f.user, null);
      const stream = await open("app", f.user);
      await stream.count(1);
      await initialize();
      await waitFor(async () => stream.ended);
      const [[row]] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM notification_streams WHERE recipient_id = ?",
        [f.user],
      );
      assert.equal(row.n, 0);
      await initialize();
      const [[cursor]] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM notification_streams WHERE written_seq > last_seq",
      );
      assert.equal(cursor.n, 0);
    });

    test("initial-data reconstruction preserves unacknowledged history and contiguous watermarks", async () => {
      const f = await fixture();
      const id = await ride(f.user, f.chair, ["MATCHING", "ENROUTE", "PICKUP"]);
      await pool.query(
        "UPDATE ride_statuses SET app_sent_at = NOW(6), chair_sent_at = NOW(6) WHERE ride_id = ? AND status <> 'ENROUTE'",
        [id],
      );
      await pool.query("DELETE FROM notification_events");
      await pool.query("DELETE FROM notification_streams");
      const sql = await readFile(
        new URL("../../sql/4-notification-data.sql", import.meta.url),
        "utf8",
      );
      for (const statement of sql.split(";").filter((part) => part.trim()))
        await pool.query(statement);
      for (const type of ["app", "chair"] as const) {
        const events = await readEvents(
          type,
          type === "app" ? f.user : f.chair,
          false,
        );
        assert.deepEqual(
          events.map((event) => event.status),
          ["ENROUTE", "PICKUP"],
        );
      }
    });

    test("JSON fallback drains the same history and returns latest once caught up", async () => {
      await stop();
      await start("json");
      const f = await fixture();
      const first = await ride(f.user, f.chair, ["MATCHING", "ENROUTE"]);
      const second = await ride(f.user, f.chair);
      for (const [type, id] of [
        ["app", f.user],
        ["chair", f.chair],
      ] as const) {
        for (const [rideId, status] of [
          [first, "MATCHING"],
          [first, "ENROUTE"],
          [second, "MATCHING"],
        ]) {
          const response = await fetch(`${base}/api/${type}/notification`, {
            headers: { Cookie: `${type}_session=${id}` },
          });
          const body = await response.json();
          assert.equal(body.data.ride_id, rideId);
          assert.equal(body.data.status, status);
          assert.equal(body.retry_after_ms, 30);
        }
        const response = await fetch(`${base}/api/${type}/notification`, {
          headers: { Cookie: `${type}_session=${id}` },
        });
        assert.equal((await response.json()).retry_after_ms, 300);
      }
    });
  },
);

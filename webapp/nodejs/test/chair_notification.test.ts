import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { chairGetNotification } from "../src/chair_handlers.js";
import type { Environment } from "../src/types/hono.js";

const ride = {
  id: "ride-1", user_id: "user-1", pickup_latitude: 1,
  pickup_longitude: 2, destination_latitude: 3, destination_longitude: 4,
};
const user = { id: "user-1", firstname: "Test", lastname: "User" };

function fixture(responses: unknown[]) {
  const events: string[] = [];
  const writes: unknown[][] = [];
  const connection = {
    async beginTransaction() { events.push("begin"); },
    async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); },
    async query(sql: string, params: unknown[]) {
      if (sql.startsWith("UPDATE")) {
        writes.push(params);
        return [{ affectedRows: 1 }];
      }
      assert.ok(responses.length > 0, "unexpected extra database read");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return [response];
    },
  };
  const app = new Hono<Environment>();
  app.use(async (ctx, next) => {
    ctx.set("dbConn", connection as unknown as Environment["Variables"]["dbConn"]);
    ctx.set("chair", { id: "chair-1" } as Environment["Variables"]["chair"]);
    await next();
  });
  app.get("/", chairGetNotification);
  return { app, events, writes };
}

test("no ride returns retry interval and finishes the transaction", async () => {
  const { app, events, writes } = fixture([[]]);
  const response = await app.request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { retry_after_ms: 30 });
  assert.deepEqual(events, ["begin", "commit"]);
  assert.deepEqual(writes, []);
});

test("pending notification is returned and marked sent before commit", async () => {
  const { app, events, writes } = fixture([[ride], [{ id: "status-1", status: "PICKUP" }], [user]]);
  const response = await app.request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      ride_id: "ride-1", user: { id: "user-1", name: "Test User" },
      pickup_coordinate: { latitude: 1, longitude: 2 },
      destination_coordinate: { latitude: 3, longitude: 4 }, status: "PICKUP",
    },
    retry_after_ms: 30,
  });
  assert.deepEqual(writes, [["status-1"]]);
  assert.deepEqual(events, ["begin", "commit"]);
});

test("no pending notification returns latest status without updating delivery", async () => {
  const { app, events, writes } = fixture([[ride], [], [{ status: "COMPLETED" }], [user]]);
  const response = await app.request("/");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "COMPLETED");
  assert.deepEqual(writes, []);
  assert.deepEqual(events, ["begin", "commit"]);
});

test("database failure rolls back without committing delivery", async () => {
  const { app, events, writes } = fixture([[ride], new Error("database failure")]);
  const response = await app.request("/");
  assert.equal(response.status, 500);
  assert.deepEqual(events, ["begin", "rollback"]);
  assert.deepEqual(writes, []);
});

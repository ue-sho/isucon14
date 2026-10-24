import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db.js";
import {
  enterRequest,
  isInitializing,
  leaveRequest,
  onReset,
} from "./notification_lifecycle.js";
import { appNotificationData } from "./notification_payload.js";
import {
  type NotificationEvent,
  type RecipientType,
  readEvents,
  recordWritten,
} from "./notification_repository.js";
import type { Environment } from "./types/hono.js";
import type { Ride } from "./types/models.js";

type Subscriber = {
  type: RecipientType;
  id: string;
  wake: () => void;
  stop: () => Promise<void>;
};
const subscribers = new Map<string, Subscriber>();
const keyOf = (type: RecipientType, id: string) => `${type}:${id}`;
export function wakeNotifications(keys?: string[]) {
  if (keys) {
    for (const key of keys) subscribers.get(key)?.wake();
  } else {
    for (const subscriber of subscribers.values()) subscriber.wake();
  }
}

let checking = false;
const timer = setInterval(async () => {
  if (checking || isInitializing() || subscribers.size === 0) return;
  checking = true;
  try {
    const active = [...subscribers.values()];
    for (let i = 0; i < active.length; i += 128) {
      const chunk = active.slice(i, i + 128);
      const [rows] = await pool.query<
        Array<
          RowDataPacket & {
            recipient_type: RecipientType;
            recipient_id: string;
          }
        >
      >(
        `SELECT recipient_type, recipient_id FROM notification_streams WHERE
         (recipient_type, recipient_id) IN (${chunk.map(() => "(?, ?)").join(",")}) AND last_seq > written_seq`,
        chunk.flatMap((s) => [s.type, s.id]),
      );
      for (const row of rows)
        subscribers.get(keyOf(row.recipient_type, row.recipient_id))?.wake();
    }
  } catch (error) {
    console.error("notification reconciliation failed", error);
  } finally {
    checking = false;
  }
}, 1000);
timer.unref();

async function payload(
  type: RecipientType,
  id: string,
  event: NotificationEvent,
) {
  const conn = await pool.getConnection();
  try {
    const [[ride]] = await conn.query<Array<Ride & RowDataPacket>>(
      `SELECT * FROM rides WHERE id = ? AND ${type === "app" ? "user_id" : "chair_id"} = ?`,
      [event.ride_id, id],
    );
    if (!ride) throw new Error("notification ride not found");
    if (type === "app")
      return await appNotificationData(conn, ride, event.status);
    const [[user]] = await conn.query<
      Array<RowDataPacket & { id: string; firstname: string; lastname: string }>
    >("SELECT id, firstname, lastname FROM users WHERE id = ?", [ride.user_id]);
    return {
      ride_id: ride.id,
      user: { id: user.id, name: `${user.firstname} ${user.lastname}` },
      pickup_coordinate: {
        latitude: ride.pickup_latitude,
        longitude: ride.pickup_longitude,
      },
      destination_coordinate: {
        latitude: ride.destination_latitude,
        longitude: ride.destination_longitude,
      },
      status: event.status,
    };
  } finally {
    conn.release();
  }
}

export async function notificationResponse(
  ctx: Context<Environment>,
  type: RecipientType,
) {
  const token = getCookie(
    ctx,
    type === "app" ? "app_session" : "chair_session",
  );
  if (!token) return ctx.text("session cookie is required", 401);
  const table = type === "app" ? "users" : "chairs";
  const [[identity]] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${table} WHERE access_token = ?`,
    [token],
  );
  if (!identity) return ctx.text("invalid access token", 401);
  if (isInitializing()) return ctx.text("initializing", 503);
  const id = identity.id;
  if (process.env.NOTIFICATION_TRANSPORT === "json")
    return jsonNotification(ctx, type, id);
  const key = keyOf(type, id);
  while (subscribers.has(key)) await subscribers.get(key)?.stop();
  if (isInitializing()) return ctx.text("initializing", 503);

  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const encoder = new TextEncoder();
  let stopped = false;
  let dirty = true;
  let initial = true;
  let running: Promise<void> | undefined;
  let lastWrite = Date.now();
  let removeReset = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function cleanup() {
    if (subscribers.get(key) === subscriber) subscribers.delete(key);
    removeReset();
  }
  const abort = () => {
    if (stopped) return;
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    if (!running) cleanup();
    ctx.req.raw.signal.removeEventListener("abort", abort);
    void writer.abort(new Error("notification closed")).catch(() => {});
  };
  async function write(frame: string) {
    if (stopped) throw new Error("notification closed");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        writer.write(encoder.encode(frame)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("notification write timeout")),
            2000,
          );
        }),
      ]);
      if (stopped) throw new Error("notification closed");
      lastWrite = Date.now();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function drain() {
    while (dirty && !stopped) {
      dirty = false;
      const events = await readEvents(type, id, initial);
      if (stopped) return;
      if (events.length === 0 && initial) await write("data: null\n\n");
      for (const event of events) {
        const data = await payload(type, id, event);
        await write(`data: ${JSON.stringify(data)}\n\n`);
        if (stopped) return;
        if (!event.pending) continue;
        const conn = await pool.getConnection();
        try {
          if (stopped) return;
          await recordWritten(conn, type, id, event);
        } finally {
          conn.release();
        }
      }
      initial = false;
      if (events.length === 64) dirty = true;
      if (!dirty && Date.now() - lastWrite >= 15000)
        await write(": heartbeat\n\n");
    }
  }
  function wake() {
    if (stopped) return;
    dirty = true;
    if (!running) {
      running = drain()
        .catch((error) => {
          if (!stopped) console.error("notification stream failed", error);
          abort();
        })
        .finally(() => {
          running = undefined;
          if (stopped) cleanup();
          else if (dirty) wake();
        });
    }
  }
  const subscriber: Subscriber = {
    type,
    id,
    wake,
    stop: async () => {
      abort();
      await running;
      cleanup();
    },
  };
  subscribers.set(key, subscriber);
  removeReset = onReset(subscriber.stop);
  ctx.req.raw.signal.addEventListener("abort", abort, { once: true });
  if (ctx.req.raw.signal.aborted) abort();
  if (!stopped) {
    heartbeat = setInterval(wake, 15000);
    heartbeat.unref();
  }
  wake();
  return new Response(transform.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// A JSON fallback uses the same queue and cursor, preserving ordering across rides.
const jsonTails = new Map<string, Promise<void>>();
async function jsonNotification(
  ctx: Context<Environment>,
  type: RecipientType,
  id: string,
) {
  enterRequest();
  const key = keyOf(type, id);
  const previous = jsonTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  jsonTails.set(key, tail);
  try {
    await previous;
    if (isInitializing()) return ctx.text("initializing", 503);
    const [event] = await readEvents(type, id, true, 1);
    const data = event ? await payload(type, id, event) : undefined;
    if (event?.pending) {
      const conn = await pool.getConnection();
      try {
        await recordWritten(conn, type, id, event);
      } finally {
        conn.release();
      }
    }
    return ctx.json({ data, retry_after_ms: event?.pending ? 30 : 300 });
  } finally {
    release();
    if (jsonTails.get(key) === tail) jsonTails.delete(key);
    leaveRequest();
  }
}

import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  appGetNearbyChairs,
  appGetNotification,
  appGetRides,
  appPostPaymentMethods,
  appPostRideEvaluatation,
  appPostRides,
  appPostRidesEstimatedFare,
  appPostUsers,
} from "./app_handlers.js";
import {
  chairGetNotification,
  chairPostActivity,
  chairPostChairs,
  chairPostCoordinate,
  chairPostRideStatus,
} from "./chair_handlers.js";
import { pool } from "./db.js";
import { internalGetMatching } from "./internal_handlers.js";
import {
  appAuthMiddleware,
  chairAuthMiddleware,
  ownerAuthMiddleware,
} from "./middlewares.js";
import {
  beginReset,
  enterRequest,
  failReset,
  finishReset,
  isInitializing,
  isResetting,
  leaveRequest,
} from "./notification_lifecycle.js";
import { takeNotificationTargets } from "./notification_repository.js";
import { wakeNotifications } from "./notification_stream.js";
import {
  ownerGetChairs,
  ownerGetSales,
  ownerPostOwners,
} from "./owner_handlers.js";
import type { Environment } from "./types/hono.js";
// import { logger } from "hono/logger";

const app = new Hono<Environment>();
// app.use(logger());
app.use(
  createMiddleware<Environment>(async (ctx, next) => {
    if (ctx.req.path === "/api/initialize") return next();
    if (isInitializing()) return ctx.text("initializing", 503);
    if (
      ctx.req.path === "/api/app/notification" ||
      ctx.req.path === "/api/chair/notification"
    )
      return next();
    enterRequest();
    try {
      const connection = await pool.getConnection();
      ctx.set("dbConn", connection);
      try {
        await next();
      } finally {
        try {
          await connection.rollback();
        } finally {
          wakeNotifications(takeNotificationTargets(connection));
          connection.release();
        }
      }
    } finally {
      leaveRequest();
    }
  }),
);

app.post("/api/initialize", postInitialize);

// app handlers
app.post("/api/app/users", appPostUsers);

app.post("/api/app/payment-methods", appAuthMiddleware, appPostPaymentMethods);
app.get("/api/app/rides", appAuthMiddleware, appGetRides);
app.post("/api/app/rides", appAuthMiddleware, appPostRides);
app.post(
  "/api/app/rides/estimated-fare",
  appAuthMiddleware,
  appPostRidesEstimatedFare,
);
app.post(
  "/api/app/rides/:ride_id/evaluation",
  appAuthMiddleware,
  appPostRideEvaluatation,
);
app.get("/api/app/notification", appGetNotification);
app.get("/api/app/nearby-chairs", appAuthMiddleware, appGetNearbyChairs);

// owner handlers
app.post("/api/owner/owners", ownerPostOwners);

app.get("/api/owner/sales", ownerAuthMiddleware, ownerGetSales);
app.get("/api/owner/chairs", ownerAuthMiddleware, ownerGetChairs);

// chair handlers
app.post("/api/chair/chairs", chairPostChairs);

app.post("/api/chair/activity", chairAuthMiddleware, chairPostActivity);
app.post("/api/chair/coordinate", chairAuthMiddleware, chairPostCoordinate);
app.get("/api/chair/notification", chairGetNotification);
app.post(
  "/api/chair/rides/:ride_id/status",
  chairAuthMiddleware,
  chairPostRideStatus,
);

// internal handlers
app.get("/api/internal/matching", internalGetMatching);

const port = Number(process.env.PORT || 8080);
serve(
  {
    fetch: app.fetch,
    port,
  },
  (addr) => {
    console.log(`Server is running on http://localhost:${addr.port}`);
  },
);

async function postInitialize(ctx: Context<Environment>) {
  const body = await ctx.req.json<{ payment_server: string }>();
  if (isResetting()) return ctx.text("initializing", 503);
  try {
    await beginReset();
    await runInitializationScript();
    await pool.query(
      "UPDATE settings SET value = ? WHERE name = 'payment_gateway_url'",
      [body.payment_server],
    );
    await pool.query(
      "SELECT last_seq, written_seq FROM notification_streams LIMIT 1",
    );
    finishReset();
    return ctx.json({ language: "node" });
  } catch (error) {
    failReset();
    return ctx.text(`Failed to initialize\n${error}`, 500);
  }
}

// Stop mysql/gzip children too, so a timed-out reset cannot race its retry.
function runInitializationScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["../sql/init.sh"], {
      stdio: "inherit",
      detached: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          console.error("failed to stop initialization", error);
        }
      }
    }, 25000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!timedOut && code === 0) resolve();
      else
        reject(
          new Error(
            timedOut
              ? "initialization timed out"
              : `init.sh exited with ${code}`,
          ),
        );
    });
  });
}

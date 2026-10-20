import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import paymentRoutes from "./paymentRoutes.js";
import providerRoutes from "./providerRoutes.js";
import { getPool } from "./db.js";

export function createApp() {
  const app = express();
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean);

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      const error = new Error("Origin not allowed");
      Object.assign(error, { status: 403, code: "origin_not_allowed" });
      return callback(error);
    },
  }));
  app.use(express.json({ limit: "64kb", type: "application/json" }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      service: "mobiwave-payments-api",
      status: "ok",
      mode: process.env.NODE_ENV ?? "development",
    });
  });

  app.use("/api/v1", paymentRoutes);
  app.use("/api/v1", providerRoutes);

  app.get("/ready", async (_req, res) => {
    try {
      await getPool().query("select 1");
      return res.status(200).json({ status: "ready", database: "connected" });
    } catch {
      return res.status(503).json({ status: "not_ready", database: "unavailable" });
    }
  });

  app.get("/api/v1", (_req, res) => {
    res.status(200).json({
      name: "MobiWave Payments API",
      version: "v1",
      status: "foundation",
      livePaymentsEnabled: false,
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "The requested resource was not found." });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as { status?: number; type?: string; code?: string };
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ error: "payload_too_large", message: "Request body exceeds the allowed size." });
    }
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "Request body must contain valid JSON." });
    }
    if (error?.code === "origin_not_allowed") {
      return res.status(403).json({ error: "origin_not_allowed", message: "This origin is not allowed." });
    }
    // Never expose internal errors, credentials, or provider payloads to clients.
    return res.status(500).json({ error: "internal_server_error", message: "An unexpected error occurred." });
  });

  return app;
}

export default createApp();

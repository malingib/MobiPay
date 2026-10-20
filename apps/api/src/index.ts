import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed"));
}}));
app.use(express.json({ limit: "64kb", type: "application/json" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));

app.get("/health", (_req, res) => {
  res.status(200).json({ service: "mobiwave-payments-api", status: "ok", mode: process.env.NODE_ENV ?? "development" });
});

app.get("/api/v1", (_req, res) => {
  res.status(200).json({ name: "MobiWave Payments API", version: "v1", status: "foundation" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Do not leak internal errors, secrets, or provider payloads to clients.
  res.status(500).json({ error: "internal_server_error", message: "An unexpected error occurred." });
});

app.listen(port, () => {
  console.log(`MobiWave Payments API listening on port ${port}`);
});

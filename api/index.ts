import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../apps/api/src/app.js";

type VercelRequest = IncomingMessage & { url?: string };

export default function handler(req: VercelRequest, res: ServerResponse) {
  const incoming = new URL(req.url ?? "/", "https://internal.invalid");
  const path = incoming.searchParams.get("__path");
  if (path) {
    if (path !== "/api/v1" && !path.startsWith("/api/v1/")) {
      res.statusCode = 400;
      res.end("Invalid API path");
      return;
    }
    const query = new URLSearchParams();
    for (const [key, value] of incoming.searchParams.entries()) {
      if (key !== "__path") query.append(key, value);
    }
    req.url = path + (query.size ? `?${query.toString()}` : "");
  }
  return app(req, res);
}

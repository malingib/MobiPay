import type { IncomingMessage, ServerResponse } from "node:http";

export default async function handler(req: IncomingMessage & { url?: string }, res: ServerResponse) {
  try {
    const mod = await import("../apps/api/src/app.js");
    const app = mod.default as (req: IncomingMessage, res: ServerResponse) => unknown;
    if (new URL(req.url ?? "/", "https://diagnostics.invalid").searchParams.get("route") === "v1") req.url = "/api/v1";
    return app(req, res);
  } catch (error) {
    const value = error as { name?: string; message?: string; code?: string };
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, name: value.name ?? "Error", code: value.code ?? null, message: value.message ?? "Express invocation failed" }));
  }
}

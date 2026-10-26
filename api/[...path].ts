import app from "../apps/api/src/app.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return app(req, res);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../backend/src/app.js";

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  req.url = req.url?.replace(/^\/api(?=\/|$)/, "") || "/";
  return app(req, res);
}

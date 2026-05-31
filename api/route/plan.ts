import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../../backend/src/app.js";

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const query = req.url?.includes("?") ? `?${req.url.split("?")[1]}` : "";
  req.url = `/route/plan${query}`;
  return app(req, res);
}

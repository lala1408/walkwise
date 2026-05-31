import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("api", () => {
  it("reports health", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("validates route payload", async () => {
    const app = createApp();
    const res = await request(app).post("/route/plan").send({ city: "Berlin" });
    expect(res.status).toBe(400);
  });
});

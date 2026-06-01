import express from "express";
import cors from "cors";
import { z } from "zod";
import { searchCities } from "./services/city-service.js";
import { geocodeAddress } from "./services/geocode-service.js";
import { fetchPois } from "./services/poi-service.js";
import { buildWalkingPlan } from "./services/optimizer.js";

const routeRequestSchema = z.object({
  city: z.string().min(1),
  start: z.object({ lat: z.number(), lon: z.number() }).optional(),
  end: z.object({ lat: z.number(), lon: z.number() }).optional(),
  city_center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  time_budget_minutes: z.number().int().min(60).max(1000).optional(),
  route_preference: z.enum(["fastest", "beautiful", "manual"]).default("fastest"),
  selected_pois: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        category: z.string(),
        description: z.string().default("Interessanter Stopp fuer deine Walking-Route."),
        imageUrl: z.string().default("https://placehold.co/360x220/e2e8f0/334155?text=Stopp"),
        location: z.object({ lat: z.number(), lon: z.number() }),
        priority: z.number().int().min(1).max(5).default(1)
      })
    )
    .min(1),
  mode: z.literal("walking")
});

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/cities", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    if (query.length < 2) return res.json({ cities: [] });
    try {
      const cities = await searchCities(query);
      return res.json({ cities });
    } catch {
      return res.status(502).json({ error: "Failed to fetch city suggestions" });
    }
  });

  app.get("/geocode", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    if (query.length < 2) return res.json({ addresses: [] });
    try {
      const city = req.query.city ? String(req.query.city) : undefined;
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lon = req.query.lon ? Number(req.query.lon) : undefined;
      const center = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat as number, lon: lon as number } : undefined;
      const addresses = await geocodeAddress(query, city, center);
      return res.json({ addresses });
    } catch {
      return res.status(502).json({ error: "Failed to geocode address" });
    }
  });

  app.get("/pois", async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    const city = String(req.query.city ?? "").trim();
    const categories = String(req.query.categories ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!city) return res.status(400).json({ error: "city is required" });
    try {
      const osmType = req.query.osmType ? String(req.query.osmType) : undefined;
      const osmId = req.query.osmId ? Number(req.query.osmId) : undefined;
      const lat = req.query.lat ? Number(req.query.lat) : undefined;
      const lon = req.query.lon ? Number(req.query.lon) : undefined;
      const center = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat as number, lon: lon as number } : undefined;
      const pois = await fetchPois(city, categories, osmType, osmId, center);
      return res.json({ pois });
    } catch (error) {
      console.error("Failed to fetch POIs", error);
      return res.status(502).json({ error: "Failed to fetch POIs from OpenStreetMap" });
    }
  });

  app.post("/route/plan", async (req, res) => {
    const parsed = routeRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    const input = parsed.data;
    if (!input.start && !input.selected_pois[0]?.location) return res.status(400).json({ error: "Start or selected POIs are required" });
    const result = await buildWalkingPlan({
      start: input.start,
      end: input.end,
      timeBudgetMinutes: input.time_budget_minutes,
      selectedPois: input.selected_pois,
      routePreference: input.route_preference
    });
    return res.json({
      ordered_stops: result.orderedStops,
      polyline: result.polyline,
      totals: result.totals,
      dropped_pois: result.droppedPois,
      explanation: result.explanation
    });
  });

  return app;
}

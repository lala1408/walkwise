import { describe, expect, it } from "vitest";
import { buildWalkingPlan } from "../src/services/optimizer.js";

describe("optimizer", () => {
  it("respects time budget by dropping stops", async () => {
    const result = await buildWalkingPlan({
      start: { lat: 52.52, lon: 13.4 },
      timeBudgetMinutes: 90,
      routePreference: "fastest",
      selectedPois: [
        { id: "a", name: "A", category: "landmark", description: "A", imageUrl: "https://example.com/a.jpg", location: { lat: 52.53, lon: 13.4 }, priority: 1 },
        { id: "b", name: "B", category: "landmark", description: "B", imageUrl: "https://example.com/b.jpg", location: { lat: 52.7, lon: 13.42 }, priority: 1 },
        { id: "c", name: "C", category: "landmark", description: "C", imageUrl: "https://example.com/c.jpg", location: { lat: 52.8, lon: 13.45 }, priority: 1 }
      ]
    });

    expect(result.orderedStops.length).toBeGreaterThan(0);
    expect(result.totals.estimated_total_minutes).toBeLessThanOrEqual(90);
    expect(result.droppedPois.length).toBeGreaterThan(0);
  });

  it("chooses the best free start when no start is provided", async () => {
    const result = await buildWalkingPlan({
      routePreference: "fastest",
      selectedPois: [
        { id: "b", name: "B", category: "landmark", description: "B", imageUrl: "https://example.com/b.jpg", location: { lat: 52.54, lon: 13.4 }, priority: 1 },
        { id: "a", name: "A", category: "landmark", description: "A", imageUrl: "https://example.com/a.jpg", location: { lat: 52.53, lon: 13.4 }, priority: 1 },
        { id: "c", name: "C", category: "landmark", description: "C", imageUrl: "https://example.com/c.jpg", location: { lat: 52.55, lon: 13.4 }, priority: 1 }
      ]
    });

    expect(result.orderedStops[0].poi.name).not.toBe("B");
    expect(result.orderedStops[1].poi.name).toBe("B");
    expect(result.orderedStops[0].walkMinutesFromPrev).toBe(0);
    expect(result.polyline[0]).toEqual([result.orderedStops[0].poi.location.lat, result.orderedStops[0].poi.location.lon]);
  });

  it("optimizes the whole route instead of choosing only the nearest next stop", async () => {
    const result = await buildWalkingPlan({
      start: { lat: 0, lon: 0 },
      routePreference: "fastest",
      selectedPois: [
        { id: "a", name: "A", category: "landmark", description: "A", imageUrl: "https://example.com/a.jpg", location: { lat: 4.2909, lon: 1.13 }, priority: 1 },
        { id: "b", name: "B", category: "landmark", description: "B", imageUrl: "https://example.com/b.jpg", location: { lat: 11.0426, lon: -4.9239 }, priority: 1 },
        { id: "c", name: "C", category: "landmark", description: "C", imageUrl: "https://example.com/c.jpg", location: { lat: 14.078, lon: 12.7519 }, priority: 1 },
        { id: "d", name: "D", category: "landmark", description: "D", imageUrl: "https://example.com/d.jpg", location: { lat: -3.7365, lon: 6.4169 }, priority: 1 },
        { id: "e", name: "E", category: "landmark", description: "E", imageUrl: "https://example.com/e.jpg", location: { lat: -3.0494, lon: -2.0204 }, priority: 1 }
      ]
    });

    expect(result.orderedStops.map((stop) => stop.poi.name)).toEqual(["E", "D", "A", "B", "C"]);
  });

  it("uses the fastest stop order for beautiful routes", async () => {
    const selectedPois = [
      { id: "a", name: "A", category: "landmark", description: "A", imageUrl: "https://example.com/a.jpg", location: { lat: 52.53, lon: 13.4 }, priority: 1 },
      { id: "c", name: "C", category: "landmark", description: "C", imageUrl: "https://example.com/c.jpg", location: { lat: 52.75, lon: 13.5 }, priority: 1 },
      { id: "b", name: "B", category: "landmark", description: "B", imageUrl: "https://example.com/b.jpg", location: { lat: 52.54, lon: 13.41 }, priority: 1 }
    ];

    const fastest = await buildWalkingPlan({ routePreference: "fastest", selectedPois });
    const beautiful = await buildWalkingPlan({ routePreference: "beautiful", selectedPois });

    expect(beautiful.orderedStops.map((stop) => stop.poi.name)).toEqual(fastest.orderedStops.map((stop) => stop.poi.name));
    expect(beautiful.explanation).toContain("Schoenste Route");
  });
});

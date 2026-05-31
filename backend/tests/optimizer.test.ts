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

  it("starts at the first selected POI when no start is provided", async () => {
    const result = await buildWalkingPlan({
      routePreference: "fastest",
      selectedPois: [
        { id: "a", name: "A", category: "landmark", description: "A", imageUrl: "https://example.com/a.jpg", location: { lat: 52.53, lon: 13.4 }, priority: 1 },
        { id: "b", name: "B", category: "landmark", description: "B", imageUrl: "https://example.com/b.jpg", location: { lat: 52.54, lon: 13.41 }, priority: 1 }
      ]
    });

    expect(result.orderedStops[0].poi.name).toBe("A");
    expect(result.orderedStops[0].walkMinutesFromPrev).toBe(0);
    expect(result.polyline[0]).toEqual([52.53, 13.4]);
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
    expect(beautiful.orderedStops.map((stop) => stop.poi.name)).toEqual(["A", "B", "C"]);
    expect(beautiful.explanation).toContain("Schoenste Route");
  });
});

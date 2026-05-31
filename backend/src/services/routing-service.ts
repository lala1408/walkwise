import axios from "axios";
import { LRUCache } from "lru-cache";
import { haversineKm, walkMinutesForKm } from "./geo.js";
import type { LatLng } from "../types.js";
import { OPEN_DATA_HEADERS } from "./open-data-headers.js";

export type WalkingSegment = {
  distanceKm: number;
  durationMinutes: number;
  polyline: [number, number][];
  isFallback: boolean;
};

const ROUTE_CACHE = new LRUCache<string, WalkingSegment>({ max: 800, ttl: 1000 * 60 * 60 * 6 });

export async function getWalkingSegment(from: LatLng, to: LatLng, preference: "fastest" | "beautiful" = "fastest"): Promise<WalkingSegment> {
  if (process.env.NODE_ENV === "test") return fallbackSegment(from, to);

  const cacheKey = `${preference}:${roundCoord(from.lat)},${roundCoord(from.lon)}:${roundCoord(to.lat)},${roundCoord(to.lon)}`;
  const cached = ROUTE_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const coordinates = `${from.lon},${from.lat};${to.lon},${to.lat}`;
    const response = await axios.get(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordinates}`, {
      params: {
        overview: "full",
        geometries: "geojson",
        steps: false,
        alternatives: preference === "beautiful"
      },
      headers: OPEN_DATA_HEADERS,
      timeout: 8000
    });
    const routes = response.data?.routes ?? [];
    const route = preference === "beautiful" ? chooseBeautifulRoute(routes) : routes[0];
    const coordinatesList = route?.geometry?.coordinates ?? [];
    if (!route || !Array.isArray(coordinatesList) || coordinatesList.length < 2) throw new Error("No walking route");

    const segment: WalkingSegment = {
      distanceKm: Number(route.distance ?? 0) / 1000,
      durationMinutes: Number(route.duration ?? 0) / 60,
      polyline: coordinatesList.reduce((points: [number, number][], point: unknown) => {
        if (!Array.isArray(point)) return points;
        const lat = Number(point[1]);
        const lon = Number(point[0]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lat, lon]);
        return points;
      }, []),
      isFallback: false
    };
    ROUTE_CACHE.set(cacheKey, segment);
    return segment;
  } catch {
    return fallbackSegment(from, to);
  }
}

function chooseBeautifulRoute(routes: any[]): any {
  if (!Array.isArray(routes) || !routes.length) return null;
  const fastestDuration = Math.min(...routes.map((route) => Number(route.duration ?? Number.POSITIVE_INFINITY)));
  const maxDuration = fastestDuration * 1.25;
  return [...routes]
    .filter((route) => Number(route.duration ?? Number.POSITIVE_INFINITY) <= maxDuration)
    .sort((a, b) => scenicScore(b) - scenicScore(a))[0] ?? routes[0];
}

function scenicScore(route: any): number {
  const distance = Number(route.distance ?? 0);
  const duration = Number(route.duration ?? 0);
  const points = route.geometry?.coordinates?.length ?? 0;
  if (!distance || !duration) return 0;
  const directnessPenalty = duration / Math.max(distance, 1);
  return points / 40 - directnessPenalty / 900;
}

function fallbackSegment(from: LatLng, to: LatLng): WalkingSegment {
  const distanceKm = haversineKm(from, to);
  return {
    distanceKm,
    durationMinutes: walkMinutesForKm(distanceKm),
    polyline: [
      [from.lat, from.lon],
      [to.lat, to.lon]
    ],
    isFallback: true
  };
}

function roundCoord(value: number): string {
  return value.toFixed(5);
}

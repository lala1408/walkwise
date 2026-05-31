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
const SCENIC_FEATURE_CACHE = new LRUCache<string, ScenicFeature[]>({ max: 500, ttl: 1000 * 60 * 60 * 3 });
const BEAUTIFUL_MAX_DURATION_FACTOR = 1.32;
const BEAUTIFUL_DETOUR_LIMIT = 2;

type OsrmRoute = {
  distance?: number;
  duration?: number;
  geometry?: {
    coordinates?: unknown[];
  };
};

type ScenicFeature = {
  lat: number;
  lon: number;
  weight: number;
  type: "positive" | "negative";
};

export async function getWalkingSegment(from: LatLng, to: LatLng, preference: "fastest" | "beautiful" = "fastest"): Promise<WalkingSegment> {
  if (process.env.NODE_ENV === "test") return fallbackSegment(from, to);

  const cacheKey = `${preference}:${roundCoord(from.lat)},${roundCoord(from.lon)}:${roundCoord(to.lat)},${roundCoord(to.lon)}`;
  const cached = ROUTE_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const routes = await fetchFootRoutes(from, to, preference === "beautiful");
    const route = preference === "beautiful" ? await chooseBeautifulRoute(from, to, routes) : routes[0];
    const segment = routeToSegment(route);
    if (!segment) throw new Error("No walking route");
    ROUTE_CACHE.set(cacheKey, segment);
    return segment;
  } catch {
    return fallbackSegment(from, to);
  }
}

async function fetchFootRoutes(from: LatLng, to: LatLng, alternatives: boolean): Promise<OsrmRoute[]> {
  const coordinates = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const response = await axios.get(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordinates}`, {
    params: {
      overview: "full",
      geometries: "geojson",
      steps: false,
      alternatives
    },
    headers: OPEN_DATA_HEADERS,
    timeout: 8000
  });
  return Array.isArray(response.data?.routes) ? response.data.routes : [];
}

function routeToSegment(route: OsrmRoute | null | undefined): WalkingSegment | null {
  const coordinatesList = route?.geometry?.coordinates ?? [];
  if (!route || !Array.isArray(coordinatesList) || coordinatesList.length < 2) return null;

  return {
    distanceKm: Number(route.distance ?? 0) / 1000,
    durationMinutes: Number(route.duration ?? 0) / 60,
    polyline: coordinatesList.reduce((points: [number, number][], point: unknown) => {
      if (!Array.isArray(point)) return points;
      const lat = Number(point[1]);
      const lon = Number(point[0]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lat, lon]);
      return points;
    }, [] as [number, number][]),
    isFallback: false
  };
}

async function chooseBeautifulRoute(from: LatLng, to: LatLng, routes: OsrmRoute[]): Promise<OsrmRoute | null> {
  if (!Array.isArray(routes) || !routes.length) return null;
  const fastestDuration = Math.min(...routes.map((route) => Number(route.duration ?? Number.POSITIVE_INFINITY)));
  const features = await fetchScenicFeaturesForRoutes(routes);
  const detourRoutes = await fetchBeautifulDetours(from, to, routes[0], fastestDuration, features);
  return [...routes, ...detourRoutes]
    .filter((route) => Number(route.duration ?? Number.POSITIVE_INFINITY) <= maxDuration(fastestDuration))
    .sort((a, b) => scenicScore(b, fastestDuration, features) - scenicScore(a, fastestDuration, features))[0] ?? routes[0];
}

function maxDuration(fastestDuration: number): number {
  return fastestDuration * BEAUTIFUL_MAX_DURATION_FACTOR;
}

async function fetchBeautifulDetours(
  from: LatLng,
  to: LatLng,
  fastestRoute: OsrmRoute | undefined,
  fastestDuration: number,
  features: ScenicFeature[]
): Promise<OsrmRoute[]> {
  const fastestPoints = routeToLatLngs(fastestRoute);
  if (fastestDuration < 7 * 60 || fastestPoints.length < 2) return [];

  const candidates = features
    .filter((feature) => feature.type === "positive" && feature.weight >= 3)
    .map((feature) => ({ feature, distanceToRoute: minDistanceKm(feature, fastestPoints) }))
    .filter(({ feature, distanceToRoute }) => distanceToRoute <= 0.35 && haversineKm(from, feature) > 0.2 && haversineKm(to, feature) > 0.2)
    .sort((a, b) => b.feature.weight - a.feature.weight || a.distanceToRoute - b.distanceToRoute)
    .slice(0, BEAUTIFUL_DETOUR_LIMIT);

  const routes: OsrmRoute[] = [];
  for (const { feature } of candidates) {
    try {
      const [firstRoute] = await fetchFootRoutes(from, feature, false);
      const [secondRoute] = await fetchFootRoutes(feature, to, false);
      const combined = combineRoutes(firstRoute, secondRoute);
      if (combined && Number(combined.duration ?? Number.POSITIVE_INFINITY) <= maxDuration(fastestDuration)) routes.push(combined);
    } catch {
      // Scenic detours are optional; the direct alternatives remain usable.
    }
  }
  return routes;
}

function combineRoutes(first: OsrmRoute | undefined, second: OsrmRoute | undefined): OsrmRoute | null {
  const firstCoordinates = first?.geometry?.coordinates;
  const secondCoordinates = second?.geometry?.coordinates;
  if (!Array.isArray(firstCoordinates) || !Array.isArray(secondCoordinates) || firstCoordinates.length < 2 || secondCoordinates.length < 2) return null;
  return {
    distance: Number(first?.distance ?? 0) + Number(second?.distance ?? 0),
    duration: Number(first?.duration ?? 0) + Number(second?.duration ?? 0),
    geometry: {
      coordinates: [...firstCoordinates, ...secondCoordinates.slice(1)]
    }
  };
}

function scenicScore(route: OsrmRoute, fastestDuration: number, features: ScenicFeature[]): number {
  const distance = Number(route.distance ?? 0);
  const duration = Number(route.duration ?? 0);
  const points = routeToLatLngs(route);
  if (!distance || !duration) return 0;
  const durationPenalty = ((duration - fastestDuration) / 60) * 1.4;
  const directnessPenalty = duration / Math.max(distance, 1) / 500;
  return scenicFeatureScore(points, features) - durationPenalty - directnessPenalty;
}

function scenicFeatureScore(points: LatLng[], features: ScenicFeature[]): number {
  if (!points.length || !features.length) return 0;
  const sampled = sampleRoutePoints(points);
  let score = 0;
  for (const point of sampled) {
    for (const feature of features) {
      const distance = haversineKm(point, feature);
      const radius = feature.type === "positive" ? 0.09 : 0.055;
      if (distance > radius) continue;
      const closeness = 1 - distance / radius;
      score += feature.weight * closeness;
    }
  }
  return score / Math.max(sampled.length, 1);
}

async function fetchScenicFeaturesForRoutes(routes: OsrmRoute[]): Promise<ScenicFeature[]> {
  const points = routes.flatMap(routeToLatLngs);
  if (!points.length) return [];

  const bounds = expandedBounds(points, 0.0045);
  const cacheKey = bounds.map((value) => value.toFixed(3)).join(",");
  const cached = SCENIC_FEATURE_CACHE.get(cacheKey);
  if (cached) return cached;

  const [south, west, north, east] = bounds;
  const query = `
    [out:json][timeout:4];
    (
      way["leisure"~"^(park|garden)$"](${south},${west},${north},${east});
      relation["leisure"~"^(park|garden)$"](${south},${west},${north},${east});
      way["natural"="water"](${south},${west},${north},${east});
      relation["natural"="water"](${south},${west},${north},${east});
      way["waterway"~"^(river|canal)$"](${south},${west},${north},${east});
      way["highway"~"^(pedestrian|living_street)$"](${south},${west},${north},${east});
      way["name"~"(Promenade|promenade|Quai|Embankment|Esplanade|Riverside)"](${south},${west},${north},${east});
      way["place"="square"](${south},${west},${north},${east});
      node["place"="square"](${south},${west},${north},${east});
      node["tourism"~"^(attraction|viewpoint|artwork)$"](${south},${west},${north},${east});
      way["tourism"~"^(attraction|viewpoint|artwork)$"](${south},${west},${north},${east});
      way["highway"~"^(primary|secondary|trunk|motorway)$"](${south},${west},${north},${east});
      way["highway"="steps"](${south},${west},${north},${east});
      way["incline"](${south},${west},${north},${east});
    );
    out center tags 240;
  `;

  try {
    const response = await axios.post("https://overpass-api.de/api/interpreter", new URLSearchParams({ data: query }), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...OPEN_DATA_HEADERS
      },
      timeout: 4500
    });
    const features = normalizeScenicFeatures(response.data?.elements ?? []);
    SCENIC_FEATURE_CACHE.set(cacheKey, features);
    return features;
  } catch {
    return [];
  }
}

function normalizeScenicFeatures(elements: any[]): ScenicFeature[] {
  return elements.reduce((features: ScenicFeature[], element) => {
    const tags = element.tags ?? {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return features;
    const weight = scenicFeatureWeight(tags);
    if (weight === 0) return features;
    features.push({ lat, lon, weight, type: weight > 0 ? "positive" : "negative" });
    return features;
  }, []);
}

function scenicFeatureWeight(tags: Record<string, string>): number {
  if (tags.leisure === "park" || tags.leisure === "garden") return 5;
  if (tags.natural === "water" || tags.waterway === "river" || tags.waterway === "canal") return 4;
  if (/(promenade|quai|embankment|esplanade|riverside)/i.test(tags.name ?? "")) return 3.8;
  if (tags.highway === "pedestrian" || tags.highway === "living_street") return 3.2;
  if (tags.place === "square") return 3;
  if (tags.tourism === "viewpoint") return 4.5;
  if (tags.tourism === "attraction" || tags.tourism === "artwork") return 2.4;
  if (tags.highway === "steps") return -1.8;
  if (tags.incline && tags.incline !== "no" && tags.incline !== "0") return -1.3;
  if (/^(primary|secondary|trunk|motorway)$/.test(tags.highway ?? "")) return -4.2;
  return 0;
}

function routeToLatLngs(route: OsrmRoute | undefined): LatLng[] {
  const coordinates = route?.geometry?.coordinates ?? [];
  if (!Array.isArray(coordinates)) return [];
  return coordinates.reduce((points: LatLng[], point: unknown) => {
    if (!Array.isArray(point)) return points;
    const lat = Number(point[1]);
    const lon = Number(point[0]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
    return points;
  }, [] as LatLng[]);
}

function sampleRoutePoints(points: LatLng[]): LatLng[] {
  if (points.length <= 60) return points;
  const step = Math.ceil(points.length / 60);
  return points.filter((_, index) => index % step === 0);
}

function expandedBounds(points: LatLng[], paddingDegrees: number): [number, number, number, number] {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return [
    Math.min(...lats) - paddingDegrees,
    Math.min(...lons) - paddingDegrees,
    Math.max(...lats) + paddingDegrees,
    Math.max(...lons) + paddingDegrees
  ];
}

function minDistanceKm(feature: LatLng, routePoints: LatLng[]): number {
  return routePoints.reduce((best, point) => Math.min(best, haversineKm(feature, point)), Number.POSITIVE_INFINITY);
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

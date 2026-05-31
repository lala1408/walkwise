import { haversineKm, walkMinutesForKm } from "./geo.js";
import { getWalkingSegment, type WalkingSegment } from "./routing-service.js";
import type { LatLng, Poi, RouteStop } from "../types.js";

type RoutePreference = "fastest" | "beautiful" | "manual";

type PlanInput = {
  start?: LatLng;
  end?: LatLng;
  timeBudgetMinutes?: number;
  selectedPois: Poi[];
  routePreference: RoutePreference;
};

export async function buildWalkingPlan(input: PlanInput) {
  const ordered = await orderStops(input);
  const dropped: Poi[] = [];
  let currentMinutes = await estimateTotalMinutes(input.start, ordered, input.end);

  while (input.timeBudgetMinutes && ordered.length > 1 && currentMinutes > input.timeBudgetMinutes) {
    dropped.push(ordered.pop() as Poi);
    currentMinutes = await estimateTotalMinutes(input.start, ordered, input.end);
  }

  const origin = input.start ?? ordered[0]?.location;
  const stops: RouteStop[] = [];
  const routePolyline: [number, number][] = [];
  let prev = origin;
  let eta = 0;
  let totalKm = 0;
  let usedFallback = false;
  const segmentPreference = input.routePreference === "beautiful" ? "beautiful" : "fastest";

  for (const [index, poi] of ordered.entries()) {
    if (!prev) break;
    const segment = index === 0 && !input.start ? zeroSegment(poi.location) : await getWalkingSegment(prev, poi.location, segmentPreference);
    usedFallback = usedFallback || segment.isFallback;
    appendSegment(routePolyline, segment.polyline);
    eta += segment.durationMinutes;
    totalKm += segment.distanceKm;
    stops.push({
      poi,
      distanceFromPrevKm: round(segment.distanceKm),
      walkMinutesFromPrev: round(segment.durationMinutes),
      etaMinutesFromStart: round(eta)
    });
    prev = poi.location;
  }

  if (prev && input.end) {
    const endSegment = await getWalkingSegment(prev, input.end, segmentPreference);
    usedFallback = usedFallback || endSegment.isFallback;
    appendSegment(routePolyline, endSegment.polyline);
    totalKm += endSegment.distanceKm;
    eta += endSegment.durationMinutes;
  }

  const preferenceText =
    input.routePreference === "beautiful"
      ? "Schoenste Route nutzt dieselbe Stoppreihenfolge wie die schnellste Route und bevorzugt angenehmere Fussweg-Alternativen zwischen den Stopps."
      : "Schnellste Route nach Gehzeit zwischen den Stopps.";
  const fallbackText = usedFallback ? " Einzelne Abschnitte wurden geschätzt, weil der Fußwegdienst nicht geantwortet hat." : "";
  const budgetText = input.timeBudgetMinutes ? `, ${dropped.length} ausgelassen (Zeitbudget)` : "";

  return {
    orderedStops: stops,
    droppedPois: dropped,
    polyline: routePolyline,
    totals: {
      walk_minutes: round(eta),
      distance_km: round(totalKm),
      estimated_total_minutes: round(eta + ordered.length * 20)
    },
    explanation: `${stops.length} Stopps eingeplant${budgetText}. ${preferenceText}${fallbackText}`
  };
}

async function orderStops(input: PlanInput): Promise<Poi[]> {
  if (input.routePreference === "manual") return [...input.selectedPois];
  return orderFastest(input);
}

async function orderFastest(input: PlanInput): Promise<Poi[]> {
  const remaining = [...input.selectedPois];
  const ordered: Poi[] = [];
  let cursor = input.start;

  if (!cursor) {
    const first = remaining.shift();
    if (!first) return [];
    ordered.push(first);
    cursor = first.location;
  }

  while (remaining.length && cursor) {
    const next = await pickFastestNext(cursor, remaining);
    ordered.push(next);
    cursor = next.location;
  }

  return ordered;
}

async function pickFastestNext(origin: LatLng, pois: Poi[]): Promise<Poi> {
  let index = 0;
  let best = Number.POSITIVE_INFINITY;

  const scores = await Promise.all(
    pois.map(async (poi) => {
      const segment = await getWalkingSegment(origin, poi.location, "fastest");
      return segment.durationMinutes - poi.priority * 0.3;
    })
  );

  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] < best) {
      best = scores[i];
      index = i;
    }
  }

  return pois.splice(index, 1)[0];
}

async function estimateTotalMinutes(start: LatLng | undefined, ordered: Poi[], end?: LatLng): Promise<number> {
  const routeStart = start ?? ordered[0]?.location;
  if (!routeStart) return 0;

  let prev = routeStart;
  let minutes = 0;
  for (const [index, poi] of ordered.entries()) {
    if (index === 0 && !start) {
      prev = poi.location;
      continue;
    }
    minutes += await estimateMinutes(prev, poi.location);
    prev = poi.location;
  }
  if (end) minutes += await estimateMinutes(prev, end);
  return minutes + ordered.length * 20;
}

async function estimateMinutes(from: LatLng, to: LatLng): Promise<number> {
  const segment = await getWalkingSegment(from, to, "fastest");
  if (segment.isFallback) return walkMinutesForKm(haversineKm(from, to));
  return segment.durationMinutes;
}

function zeroSegment(location: LatLng): WalkingSegment {
  return {
    distanceKm: 0,
    durationMinutes: 0,
    polyline: [[location.lat, location.lon]],
    isFallback: false
  };
}

function appendSegment(target: [number, number][], segment: [number, number][]) {
  for (const point of segment) {
    const last = target[target.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    target.push(point);
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

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

const EXACT_ROUTE_LIMIT = 12;
const EPSILON = 0.000001;

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
      ? "Schoenste Route nutzt die kuerzeste Gesamt-Reihenfolge und bewertet Fusswege nach Parks, Wasser, Plaetzen, Fussgaengerzonen und grossen Strassen."
      : "Schnellste Route minimiert die geschaetzte Gesamtgehzeit ueber alle Stopps.";
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
  return orderShortestOverall(input);
}

function orderShortestOverall(input: PlanInput): Poi[] {
  const pois = [...input.selectedPois];
  if (pois.length <= 1) return pois;

  const matrix = buildEstimatedMatrix(pois);
  const startCosts = pois.map((poi) => (input.start ? estimatedWalkMinutes(input.start, poi.location) : 0));
  const endCosts = pois.map((poi) => (input.end ? estimatedWalkMinutes(poi.location, input.end) : 0));
  const indices =
    pois.length <= EXACT_ROUTE_LIMIT
      ? solveExactShortestOrder(matrix, startCosts, endCosts)
      : improveOrderWithTwoOpt(buildBestGreedyOrder(matrix, startCosts, endCosts), matrix, startCosts, endCosts);

  return indices.map((index) => pois[index]);
}

function buildEstimatedMatrix(pois: Poi[]): number[][] {
  return pois.map((from, fromIndex) =>
    pois.map((to, toIndex) => (fromIndex === toIndex ? 0 : estimatedWalkMinutes(from.location, to.location)))
  );
}

function solveExactShortestOrder(matrix: number[][], startCosts: number[], endCosts: number[]): number[] {
  const n = matrix.length;
  const stateCount = 1 << n;
  const dp = Array.from({ length: stateCount }, () => Array<number>(n).fill(Number.POSITIVE_INFINITY));
  const parent = Array.from({ length: stateCount }, () => Array<number>(n).fill(-1));

  for (let index = 0; index < n; index += 1) {
    dp[1 << index][index] = startCosts[index];
  }

  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let last = 0; last < n; last += 1) {
      const current = dp[mask][last];
      if (!Number.isFinite(current)) continue;

      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        const candidate = current + matrix[last][next];
        if (candidate < dp[nextMask][next] - EPSILON) {
          dp[nextMask][next] = candidate;
          parent[nextMask][next] = last;
        }
      }
    }
  }

  const fullMask = stateCount - 1;
  let bestLast = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let last = 0; last < n; last += 1) {
    const candidate = dp[fullMask][last] + endCosts[last];
    if (candidate < bestScore - EPSILON) {
      bestScore = candidate;
      bestLast = last;
    }
  }

  const order: number[] = [];
  let mask = fullMask;
  let last = bestLast;
  while (last !== -1) {
    order.push(last);
    const previous = parent[mask][last];
    mask ^= 1 << last;
    last = previous;
  }

  return order.reverse();
}

function buildBestGreedyOrder(matrix: number[][], startCosts: number[], endCosts: number[]): number[] {
  const candidates = matrix.map((_, startIndex) => buildGreedyOrderFrom(startIndex, matrix));
  return candidates.reduce((best, candidate) =>
    totalEstimatedScore(candidate, matrix, startCosts, endCosts) < totalEstimatedScore(best, matrix, startCosts, endCosts)
      ? candidate
      : best
  );
}

function buildGreedyOrderFrom(startIndex: number, matrix: number[][]): number[] {
  const remaining = new Set(matrix.map((_, index) => index));
  const order = [startIndex];
  remaining.delete(startIndex);

  while (remaining.size) {
    const last = order[order.length - 1];
    let bestNext = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of remaining) {
      if (matrix[last][candidate] < bestScore - EPSILON) {
        bestScore = matrix[last][candidate];
        bestNext = candidate;
      }
    }
    order.push(bestNext);
    remaining.delete(bestNext);
  }

  return order;
}

function improveOrderWithTwoOpt(order: number[], matrix: number[][], startCosts: number[], endCosts: number[]): number[] {
  let bestOrder = [...order];
  let bestScore = totalEstimatedScore(bestOrder, matrix, startCosts, endCosts);
  let improved = true;
  let passes = 0;

  while (improved && passes < 8) {
    improved = false;
    passes += 1;
    for (let start = 0; start < bestOrder.length - 1; start += 1) {
      for (let end = start + 1; end < bestOrder.length; end += 1) {
        const candidate = [
          ...bestOrder.slice(0, start),
          ...bestOrder.slice(start, end + 1).reverse(),
          ...bestOrder.slice(end + 1)
        ];
        const score = totalEstimatedScore(candidate, matrix, startCosts, endCosts);
        if (score < bestScore - EPSILON) {
          bestOrder = candidate;
          bestScore = score;
          improved = true;
        }
      }
    }
  }

  return bestOrder;
}

function totalEstimatedScore(order: number[], matrix: number[][], startCosts: number[], endCosts: number[]): number {
  if (!order.length) return 0;
  let score = startCosts[order[0]];
  for (let index = 1; index < order.length; index += 1) {
    score += matrix[order[index - 1]][order[index]];
  }
  return score + endCosts[order[order.length - 1]];
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

function estimatedWalkMinutes(from: LatLng, to: LatLng): number {
  return walkMinutesForKm(haversineKm(from, to));
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

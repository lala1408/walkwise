import type { LatLng } from "../types.js";

const EARTH_RADIUS_KM = 6371;
const WALK_KM_PER_HOUR = 4.8;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const x = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(x));
}

export function walkMinutesForKm(distanceKm: number): number {
  return (distanceKm / WALK_KM_PER_HOUR) * 60;
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

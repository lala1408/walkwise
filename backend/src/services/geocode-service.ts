import axios from "axios";
import { LRUCache } from "lru-cache";
import type { AddressSuggestion, LatLng } from "../types.js";

const GEOCODE_CACHE = new LRUCache<string, AddressSuggestion[]>({ max: 300, ttl: 1000 * 60 * 60 * 24 });

export async function geocodeAddress(query: string, city?: string, center?: LatLng): Promise<AddressSuggestion[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const scopedQuery = city && !cleaned.toLowerCase().includes(city.toLowerCase()) ? `${cleaned}, ${city}` : cleaned;
  const cacheKey = `${scopedQuery.toLowerCase()}::${center?.lat ?? ""},${center?.lon ?? ""}`;
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached) return cached;

  const response = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: {
      q: scopedQuery,
      format: "jsonv2",
      limit: 5,
      addressdetails: 1,
      bounded: center ? 1 : undefined,
      viewbox: center ? buildViewbox(center) : undefined
    },
    headers: {
      "User-Agent": "walking-route-planner/0.1 (local development)"
    },
    timeout: 8000
  });

  const suggestions = normalizeAddressSuggestions(response.data ?? []);
  GEOCODE_CACHE.set(cacheKey, suggestions);
  return suggestions;
}

function normalizeAddressSuggestions(results: any[]): AddressSuggestion[] {
  return results
    .map((item) => ({
      label: String(item.display_name ?? item.name ?? "").trim(),
      location: { lat: Number(item.lat), lon: Number(item.lon) }
    }))
    .filter((item) => item.label && Number.isFinite(item.location.lat) && Number.isFinite(item.location.lon));
}

function buildViewbox(center: LatLng): string {
  const latDelta = 0.22;
  const lonDelta = 0.34;
  return [center.lon - lonDelta, center.lat + latDelta, center.lon + lonDelta, center.lat - latDelta].join(",");
}

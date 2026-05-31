import axios from "axios";
import { LRUCache } from "lru-cache";
import type { CitySuggestion } from "../types.js";

const CITY_CACHE = new LRUCache<string, CitySuggestion[]>({ max: 200, ttl: 1000 * 60 * 60 * 24 });

const POPULAR_CITIES: CitySuggestion[] = [
  {
    id: "relation/347950",
    name: "Barcelona",
    displayName: "Barcelona, Catalunya, España",
    country: "España",
    location: { lat: 41.38258, lon: 2.17707 },
    osmType: "relation",
    osmId: 347950
  },
  {
    id: "relation/62422",
    name: "Berlin",
    displayName: "Berlin, Deutschland",
    country: "Deutschland",
    location: { lat: 52.51704, lon: 13.38886 },
    osmType: "relation",
    osmId: 62422
  },
  {
    id: "relation/71525",
    name: "Paris",
    displayName: "Paris, Île-de-France, France",
    country: "France",
    location: { lat: 48.8535, lon: 2.34839 },
    osmType: "relation",
    osmId: 71525
  },
  {
    id: "relation/41485",
    name: "London",
    displayName: "London, England, United Kingdom",
    country: "United Kingdom",
    location: { lat: 51.50745, lon: -0.12777 },
    osmType: "relation",
    osmId: 41485
  },
  {
    id: "relation/41428",
    name: "Rome",
    displayName: "Roma, Lazio, Italia",
    country: "Italia",
    location: { lat: 41.89332, lon: 12.48293 },
    osmType: "relation",
    osmId: 41428
  },
  {
    id: "relation/5326784",
    name: "Amsterdam",
    displayName: "Amsterdam, Noord-Holland, Nederland",
    country: "Nederland",
    location: { lat: 52.37308, lon: 4.89245 },
    osmType: "relation",
    osmId: 5326784
  },
  {
    id: "relation/109166",
    name: "Vienna",
    displayName: "Wien, Österreich",
    country: "Österreich",
    location: { lat: 48.20835, lon: 16.3725 },
    osmType: "relation",
    osmId: 109166
  },
  {
    id: "relation/439840",
    name: "Prague",
    displayName: "Praha, Česko",
    country: "Česko",
    location: { lat: 50.08747, lon: 14.42125 },
    osmType: "relation",
    osmId: 439840
  },
  {
    id: "relation/540629",
    name: "Lisbon",
    displayName: "Lisboa, Portugal",
    country: "Portugal",
    location: { lat: 38.70775, lon: -9.13659 },
    osmType: "relation",
    osmId: 540629
  }
];

export async function searchCities(query: string): Promise<CitySuggestion[]> {
  const key = query.toLowerCase();
  const cached = CITY_CACHE.get(key);
  if (cached) return cached;

  const response = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: {
      q: query,
      format: "jsonv2",
      limit: 6,
      addressdetails: 1,
      featuretype: "city"
    },
    headers: {
      "User-Agent": "walking-route-planner/0.1 (local development)"
    },
    timeout: 10000
  });

  const curated = POPULAR_CITIES.filter((city) => city.name.toLowerCase().startsWith(key));
  const suggestions = mergeCities([...curated, ...normalizeCities(response.data ?? [])]);
  CITY_CACHE.set(key, suggestions);
  return suggestions;
}

function normalizeCities(results: any[]): CitySuggestion[] {
  return results
    .filter((item) => ["relation", "way", "node"].includes(item.osm_type))
    .map((item) => {
      const address = item.address ?? {};
      const name = address.city ?? address.town ?? address.village ?? item.name ?? String(item.display_name).split(",")[0];
      return {
        id: `${item.osm_type}/${item.osm_id}`,
        name,
        displayName: item.display_name,
        country: address.country,
        location: { lat: Number(item.lat), lon: Number(item.lon) },
        osmType: item.osm_type,
        osmId: Number(item.osm_id)
      };
    })
    .filter((item) => Number.isFinite(item.location.lat) && Number.isFinite(item.location.lon) && Number.isFinite(item.osmId));
}

function mergeCities(cities: CitySuggestion[]): CitySuggestion[] {
  const seen = new Set<string>();
  const merged: CitySuggestion[] = [];
  for (const city of cities) {
    if (seen.has(city.id)) continue;
    seen.add(city.id);
    merged.push(city);
  }
  return merged.slice(0, 8);
}

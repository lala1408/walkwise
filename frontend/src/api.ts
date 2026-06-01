import axios from "axios";
import type { AddressSuggestion, CitySuggestion, PlanResult, Poi, PoiResult, RoutePreference } from "./types";

const api = axios.create({ baseURL: "/api" });

export async function searchCities(query: string): Promise<CitySuggestion[]> {
  const res = await api.get("/cities", { params: { query } });
  return res.data.cities as CitySuggestion[];
}

export async function getPois(
  city: string,
  categories: string[],
  selectedCity?: CitySuggestion | null,
  options?: { useLlm?: boolean; llmToken?: string }
): Promise<PoiResult> {
  const res = await api.get("/pois", {
    params: {
      city,
      categories: categories.join(","),
      osmType: selectedCity?.osmType,
      osmId: selectedCity?.osmId,
      lat: selectedCity?.location.lat,
      lon: selectedCity?.location.lon,
      enhance: options?.useLlm ? "llm" : undefined,
      requestId: Date.now()
    },
    headers: {
      ...(options?.useLlm && options.llmToken ? { "x-walkwise-llm-token": options.llmToken } : {})
    }
  });
  return {
    pois: res.data.pois as Poi[],
    enhancement: res.data.enhancement ?? "open-data",
    message: res.data.message,
    model: res.data.model
  };
}

export async function geocodeAddress(
  query: string,
  city: string,
  selectedCity?: CitySuggestion | null
): Promise<AddressSuggestion[]> {
  const res = await api.get("/geocode", {
    params: {
      query,
      city,
      lat: selectedCity?.location.lat,
      lon: selectedCity?.location.lon
    }
  });
  return res.data.addresses as AddressSuggestion[];
}

export async function planRoute(payload: {
  city: string;
  start?: { lat: number; lon: number };
  end?: { lat: number; lon: number };
  city_center?: { lat: number; lon: number };
  time_budget_minutes?: number;
  route_preference?: RoutePreference;
  selected_pois: Poi[];
}): Promise<PlanResult> {
  const res = await api.post("/route/plan", { ...payload, mode: "walking" });
  return res.data as PlanResult;
}

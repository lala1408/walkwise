export type Poi = {
  id: string;
  name: string;
  category: string;
  description: string;
  imageUrl: string;
  location: { lat: number; lon: number };
  priority: number;
};

export type CitySuggestion = {
  id: string;
  name: string;
  displayName: string;
  country?: string;
  location: { lat: number; lon: number };
  osmType: "relation" | "way" | "node";
  osmId: number;
};

export type AddressSuggestion = {
  label: string;
  location: { lat: number; lon: number };
};

export type RouteStop = {
  poi: Poi;
  distanceFromPrevKm: number;
  walkMinutesFromPrev: number;
  etaMinutesFromStart: number;
};

export type PlanResult = {
  ordered_stops: RouteStop[];
  polyline: [number, number][];
  totals: {
    walk_minutes: number;
    distance_km: number;
    estimated_total_minutes: number;
  };
  dropped_pois: Poi[];
  explanation: string;
};

export type RoutePreference = "fastest" | "beautiful" | "manual";

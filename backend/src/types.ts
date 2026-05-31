export type LatLng = {
  lat: number;
  lon: number;
};

export type Poi = {
  id: string;
  name: string;
  category: string;
  description: string;
  imageUrl: string;
  location: LatLng;
  priority: number;
};

export type CitySuggestion = {
  id: string;
  name: string;
  displayName: string;
  country?: string;
  location: LatLng;
  osmType: "relation" | "way" | "node";
  osmId: number;
};

export type AddressSuggestion = {
  label: string;
  location: LatLng;
};

export type RouteStop = {
  poi: Poi;
  distanceFromPrevKm: number;
  walkMinutesFromPrev: number;
  etaMinutesFromStart: number;
};

import { useCallback, useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import { geocodeAddress, getPois, planRoute, searchCities } from "./api";
import type { AddressSuggestion, CitySuggestion, PlanResult, Poi, PoiEnhancement, RoutePreference } from "./types";
import "./App.css";

const CITY_DEFAULT = "Berlin";
const LLM_TOKEN_STORAGE_KEY = "walkwise_llm_token";
const INITIAL_CITY: CitySuggestion = {
  id: "relation/62422",
  name: "Berlin",
  displayName: "Berlin, Deutschland",
  country: "Deutschland",
  location: { lat: 52.51704, lon: 13.38886 },
  osmType: "relation",
  osmId: 62422
};

const CATEGORIES = [
  { key: "museum", label: "Museum" },
  { key: "gallery", label: "Galerie" },
  { key: "landmark", label: "Highlight" },
  { key: "viewpoint", label: "Aussicht" },
  { key: "monument", label: "Denkmal" },
  { key: "memorial", label: "Gedenkort" },
  { key: "castle", label: "Schloss" },
  { key: "church", label: "Kirche" },
  { key: "square", label: "Platz" },
  { key: "park", label: "Park" },
  { key: "architecture", label: "Architektur" }
];

const mutedBluePoiIcon = createPoiIcon("blue", "muted");
const greenPoiIcon = createPoiIcon("green");
const startIcon = createEndpointIcon("S", "start");
const endIcon = createEndpointIcon("E", "end");

type LatLon = { lat: number; lon: number };
type SharedRouteState = {
  city: string;
  selectedCity: CitySuggestion | null;
  startText: string;
  endText: string;
  routeStart: LatLon | null;
  routeEnd: LatLon | null;
  routePreference: RoutePreference;
  pois: Poi[];
  orderedPois?: Poi[];
  poiIds?: string[];
  fallbackPois?: Poi[];
};
type CompactSharedRouteState = {
  v: 1;
  c: string;
  sc: CitySuggestion | null;
  st: string;
  et: string;
  rs: LatLon | null;
  re: LatLon | null;
  rp: RoutePreference;
  p: CompactSharedPoi[];
  o?: CompactSharedPoi[];
};
type ThinSharedRouteState = {
  v: 2;
  c: string;
  sc: CompactSharedCity | null;
  st?: string;
  et?: string;
  rs?: CompactLatLon | LatLon | null;
  re?: CompactLatLon | LatLon | null;
  rp?: RoutePreference;
  ids: string[];
  f?: CompactSharedPoi[];
};
type CompactLatLon = [number, number];
type CompactOsmType = "r" | "w" | "n";
type CompactSharedCity = {
  d?: string;
  y?: string;
  a: number;
  o: number;
  t: CompactOsmType | CitySuggestion["osmType"];
  x: number;
};
type CompactSharedPoi = {
  i: string;
  n: string;
  c: string;
  d?: string;
  a: number;
  o: number;
  p: number;
};

function parseLatLon(value: string): LatLon | null {
  const [lat, lon] = value.split(",").map((x) => Number(x.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function readStoredLlmToken(): string {
  try {
    return window.localStorage.getItem(LLM_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function shouldShowLlmSettings(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("llm");
  } catch {
    return false;
  }
}

export default function App() {
  const [city, setCity] = useState(CITY_DEFAULT);
  const [citySuggestions, setCitySuggestions] = useState<CitySuggestion[]>([]);
  const [selectedCity, setSelectedCity] = useState<CitySuggestion | null>(INITIAL_CITY);
  const [isSearchingCities, setIsSearchingCities] = useState(false);
  const [isLoadingPois, setIsLoadingPois] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [pois, setPois] = useState<Poi[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [manualPoiText, setManualPoiText] = useState("");
  const [startSuggestions, setStartSuggestions] = useState<AddressSuggestion[]>([]);
  const [endSuggestions, setEndSuggestions] = useState<AddressSuggestion[]>([]);
  const [manualPoiSuggestions, setManualPoiSuggestions] = useState<AddressSuggestion[]>([]);
  const [selectedStartLabel, setSelectedStartLabel] = useState("");
  const [selectedEndLabel, setSelectedEndLabel] = useState("");
  const [selectedManualPoiLabel, setSelectedManualPoiLabel] = useState("");
  const [isSearchingStart, setIsSearchingStart] = useState(false);
  const [isSearchingEnd, setIsSearchingEnd] = useState(false);
  const [isSearchingManualPoi, setIsSearchingManualPoi] = useState(false);
  const [isAddingPoi, setIsAddingPoi] = useState(false);
  const [routePreference, setRoutePreference] = useState<RoutePreference>("fastest");
  const [routeStart, setRouteStart] = useState<LatLon | null>(null);
  const [routeEnd, setRouteEnd] = useState<LatLon | null>(null);
  const [draggedStopIndex, setDraggedStopIndex] = useState<number | null>(null);
  const [activePoiId, setActivePoiId] = useState<string | null>(null);
  const [shareFeedback, setShareFeedback] = useState("");
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [error, setError] = useState("");
  const [showLlmSettings] = useState(shouldShowLlmSettings);
  const [llmToken, setLlmToken] = useState(readStoredLlmToken);
  const [useLlmEnhancement, setUseLlmEnhancement] = useState(() => Boolean(readStoredLlmToken()));
  const [poiEnhancement, setPoiEnhancement] = useState<PoiEnhancement>("open-data");
  const [llmNotice, setLlmNotice] = useState("");

  const selectedPois = useMemo(() => pois.filter((p) => selectedIds.has(p.id)), [pois, selectedIds]);
  const routeIndexByPoiId = useMemo(() => {
    const indexById = new Map<string, number>();
    plan?.ordered_stops.forEach((stop, index) => indexById.set(stop.poi.id, index));
    return indexById;
  }, [plan]);
  const activePoi = useMemo(() => pois.find((poi) => poi.id === activePoiId) ?? null, [activePoiId, pois]);
  const mapCenter: [number, number] = selectedCityCenter(selectedCity) ?? [52.52, 13.405];

  useEffect(() => {
    const sharedRoute = readSharedRouteState();
    if (!sharedRoute) return;

    let isActive = true;
    window.queueMicrotask(() => {
      if (!isActive) return;
      setCity(sharedRoute.city);
      setSelectedCity(sharedRoute.selectedCity);
      setStartText(sharedRoute.startText);
      setEndText(sharedRoute.endText);
      setRouteStart(sharedRoute.routeStart);
      setRouteEnd(sharedRoute.routeEnd);
      setRoutePreference(sharedRoute.routePreference === "manual" ? "fastest" : sharedRoute.routePreference);
      setIsPlanning(true);
    });

    hydrateSharedRoutePois(sharedRoute)
      .then(async (importedPois) => {
        if (!isActive) return;
        setPois(importedPois);
        setSelectedIds(new Set(importedPois.map((poi) => poi.id)));
        const route = await planRoute({
          city: sharedRoute.city,
          start: sharedRoute.routeStart ?? undefined,
          end: sharedRoute.routeEnd ?? undefined,
          route_preference: "manual",
          selected_pois: importedPois
        });
        if (isActive) setPlan(route);
      })
      .catch(() => {
        if (isActive) setError("Geteilte Route konnte nicht geladen werden.");
      })
      .finally(() => {
        if (isActive) setIsPlanning(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (city.trim().length < 2 || selectedCity?.name === city.trim()) {
      window.queueMicrotask(() => {
        setIsSearchingCities(false);
        setCitySuggestions([]);
      });
      return;
    }

    let isActive = true;
    const handle = window.setTimeout(async () => {
      setIsSearchingCities(true);
      try {
        const suggestions = await searchCities(city.trim());
        if (isActive) setCitySuggestions(suggestions);
      } catch {
        if (isActive) setCitySuggestions([]);
      } finally {
        if (isActive) setIsSearchingCities(false);
      }
    }, 300);

    return () => {
      isActive = false;
      window.clearTimeout(handle);
    };
  }, [city, selectedCity?.name]);

  const searchAddressesForField = useCallback((
    value: string,
    setSuggestions: (suggestions: AddressSuggestion[]) => void,
    setSearching: (value: boolean) => void,
    selectedLabel = ""
  ) => {
    const trimmed = value.trim();
    if (trimmed.length < 3 || parseLatLon(trimmed) || (selectedLabel && value === selectedLabel)) {
      setSearching(false);
      setSuggestions([]);
      return;
    }

    let isActive = true;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const matches = await geocodeAddress(trimmed, city, selectedCity);
        if (isActive) setSuggestions(matches);
      } catch {
        if (isActive) setSuggestions([]);
      } finally {
        if (isActive) setSearching(false);
      }
    }, 350);

    return () => {
      isActive = false;
      window.clearTimeout(handle);
    };
  }, [city, selectedCity]);

  useEffect(() => searchAddressesForField(startText, setStartSuggestions, setIsSearchingStart, selectedStartLabel), [
    searchAddressesForField,
    startText,
    selectedStartLabel
  ]);
  useEffect(() => searchAddressesForField(endText, setEndSuggestions, setIsSearchingEnd, selectedEndLabel), [
    searchAddressesForField,
    endText,
    selectedEndLabel
  ]);
  useEffect(
    () => searchAddressesForField(manualPoiText, setManualPoiSuggestions, setIsSearchingManualPoi, selectedManualPoiLabel),
    [searchAddressesForField, manualPoiText, selectedManualPoiLabel]
  );

  function updateLlmToken(value: string) {
    setLlmToken(value);
    try {
      if (value.trim()) window.localStorage.setItem(LLM_TOKEN_STORAGE_KEY, value.trim());
      else window.localStorage.removeItem(LLM_TOKEN_STORAGE_KEY);
    } catch {
      // LocalStorage can be unavailable in private browser modes.
    }
  }

  async function loadPois() {
    setError("");
    setLlmNotice("");
    setIsLoadingPois(true);
    setPois([]);
    setSelectedIds(new Set());
    setPlan(null);
    setPoiEnhancement("open-data");
    try {
      const resolvedCity = selectedCity ?? (await resolveTypedCity());
      const wantsLlm = showLlmSettings && useLlmEnhancement && Boolean(llmToken.trim());
      const result = await getPois(city, [], resolvedCity, { useLlm: wantsLlm, llmToken: llmToken.trim() });
      setPois(result.pois);
      setPoiEnhancement(result.enhancement);
      setSelectedIds(new Set(result.pois.slice(0, 8).map((x) => x.id)));
      if (wantsLlm) {
        setLlmNotice(
          result.enhancement === "llm"
            ? `KI-Veredelung aktiv${result.model ? ` (${result.model})` : ""}.`
            : result.message ?? "KI nicht aktiv, Open-Data-Ranking wird genutzt."
        );
      }
      if (!result.pois.length) setError("Keine Sehenswürdigkeiten gefunden. Bitte eine andere Stadt wählen.");
    } catch {
      setError("POIs konnten nicht geladen werden.");
    } finally {
      setIsLoadingPois(false);
    }
  }

  async function addManualPoi(suggestion?: AddressSuggestion) {
    setError("");
    const trimmed = manualPoiText.trim();
    if (!suggestion && !trimmed) return;
    setIsAddingPoi(true);
    try {
      const best = suggestion ?? (await geocodeAddress(trimmed, city, selectedCity))[0];
      if (!best) throw new Error("Ort wurde nicht gefunden. Bitte Adresse oder Namen konkreter eingeben.");
      const name = displayNameFromAddress(best.label);
      const poi: Poi = {
        id: `manual/${Date.now()}`,
        name,
        category: "landmark",
        description: best.label,
        imageUrl: `https://placehold.co/360x220/e2e8f0/334155?text=${encodeURIComponent(name.slice(0, 28))}`,
        location: best.location,
        priority: 3
      };
      setPois((prev) => [poi, ...prev]);
      setSelectedIds((prev) => new Set(prev).add(poi.id));
      setManualPoiText("");
      setSelectedManualPoiLabel("");
      setManualPoiSuggestions([]);
      setPlan(null);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Ort konnte nicht hinzugefügt werden.");
    } finally {
      setIsAddingPoi(false);
    }
  }

  async function resolveTypedCity() {
    const suggestions = citySuggestions.length ? citySuggestions : await searchCities(city.trim());
    const normalizedCity = city.trim().toLowerCase();
    const exact = suggestions.find((suggestion) => suggestion.name.toLowerCase() === normalizedCity);
    const best = exact ?? suggestions[0] ?? null;
    if (best) chooseCity(best);
    return best;
  }

  function chooseCity(suggestion: CitySuggestion) {
    setSelectedCity(suggestion);
    setCity(suggestion.name);
    setCitySuggestions([]);
    setIsSearchingCities(false);
    setPois([]);
    setSelectedIds(new Set());
    setPlan(null);
    setRouteStart(null);
    setRouteEnd(null);
  }

  function togglePoi(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generateRoute() {
    setError("");
    if (!selectedPois.length) {
      setError("Bitte mindestens eine Sehenswürdigkeit auswählen.");
      return;
    }
    setIsPlanning(true);
    try {
      const start = await resolveAddressInput(startText, "Start");
      const end = await resolveAddressInput(endText, "Ende");
      const result = await planRoute({
        city,
        start: start ?? undefined,
        end: end ?? undefined,
        city_center: selectedCity?.location,
        route_preference: routePreference,
        selected_pois: selectedPois
      });
      setRouteStart(start);
      setRouteEnd(end);
      setPlan(result);
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : "Route konnte nicht berechnet werden.");
    } finally {
      setIsPlanning(false);
    }
  }

  async function resolveAddressInput(value: string, label: string) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const coordinates = parseLatLon(trimmed);
    if (coordinates) return coordinates;

    const matches = await geocodeAddress(trimmed, city, selectedCity);
    const best = matches[0];
    if (!best) throw new Error(`${label} wurde nicht gefunden. Bitte Adresse konkreter eingeben.`);
    return best.location;
  }

  function chooseAddressSuggestion(
    suggestion: AddressSuggestion,
    setText: (value: string) => void,
    setSuggestions: (suggestions: AddressSuggestion[]) => void,
    setSelectedLabel: (value: string) => void,
    setSearching: (value: boolean) => void
  ) {
    setSelectedLabel(suggestion.label);
    setText(suggestion.label);
    setSuggestions([]);
    setSearching(false);
  }

  function chooseManualPoiSuggestion(suggestion: AddressSuggestion) {
    setSelectedManualPoiLabel(suggestion.label);
    setManualPoiText(suggestion.label);
    setManualPoiSuggestions([]);
    setIsSearchingManualPoi(false);
    void addManualPoi(suggestion);
  }

  async function replanManualRoute(orderedPois: Poi[]) {
    if (!orderedPois.length) return;
    setIsPlanning(true);
    setError("");
    try {
      const result = await planRoute({
        city,
        start: routeStart ?? undefined,
        end: routeEnd ?? undefined,
        route_preference: "manual",
        selected_pois: orderedPois
      });
      setPlan(result);
    } catch {
      setError("Route konnte nach dem Verschieben nicht neu berechnet werden.");
    } finally {
      setIsPlanning(false);
    }
  }

  function moveRouteStop(fromIndex: number, toIndex: number) {
    if (!plan || toIndex < 0 || toIndex >= plan.ordered_stops.length || fromIndex === toIndex) return;
    const orderedPois = plan.ordered_stops.map((stop) => stop.poi);
    const [moved] = orderedPois.splice(fromIndex, 1);
    orderedPois.splice(toIndex, 0, moved);
    void replanManualRoute(orderedPois);
  }

  function focusPoi(poiId: string, scrollListCard: boolean) {
    setActivePoiId(poiId);
    if (!scrollListCard) return;
    window.setTimeout(() => {
      document.getElementById(poiCardId(poiId))?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  function iconForPoi(poi: Poi) {
    const routeIndex = routeIndexByPoiId.get(poi.id);
    const isActive = activePoiId === poi.id;
    if (routeIndex !== undefined) return createNumberedPoiIcon(routeIndex + 1, isActive);
    if (selectedIds.has(poi.id)) return isActive ? createPoiIcon("green", "active") : greenPoiIcon;
    return isActive ? createPoiIcon("blue", "active muted") : mutedBluePoiIcon;
  }

  function shareRoute() {
    const state = buildShareState(city, selectedCity, startText, endText, routeStart, routeEnd, routePreference, selectedPois, plan);
    if (!state) {
      setError("Bitte zuerst Sehenswürdigkeiten auswählen oder eine Route planen.");
      return;
    }
    const url = `${window.location.origin}${window.location.pathname}#r=${encodeShareState(state)}`;
    void copyToClipboard(url).then((copied) => {
      setShareFeedback(copied ? "Link kopiert" : "Link erstellt");
      if (!copied) window.prompt("Route-Link", url);
    });
  }

  function exportRoutePdf() {
    if (!plan) {
      setError("Bitte zuerst eine Route planen.");
      return;
    }
    const cleanupPrintMode = () => {
      document.body.classList.remove("printRoute");
      window.removeEventListener("afterprint", cleanupPrintMode);
    };

    document.body.classList.add("printRoute");
    window.addEventListener("afterprint", cleanupPrintMode);
    window.dispatchEvent(new Event("resize"));
    window.setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
      window.print();
      window.setTimeout(cleanupPrintMode, 1000);
    }, 150);
  }

  function openInGoogleMaps() {
    if (!plan) {
      setError("Bitte zuerst eine Route planen.");
      return;
    }
    window.open(buildGoogleMapsUrl(plan, routeStart, routeEnd), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="layout">
      <section className="panel controlsPanel">
        <h1>Walking Planner</h1>
        <label>Stadt</label>
        <div className="cityField">
          <input
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setSelectedCity(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void resolveTypedCity();
            }}
            placeholder="z. B. Barcelona"
          />
          {(citySuggestions.length > 0 || isSearchingCities) && (
            <div className="suggestions">
              {isSearchingCities && <div className="suggestion muted">Suche...</div>}
              {citySuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseCity(suggestion)}
                >
                  <strong>{suggestion.name}</strong>
                  <span>{suggestion.country ?? suggestion.displayName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedCity && <p className="selectedCity">Ausgewählt: {selectedCity.displayName}</p>}

        {showLlmSettings && (
          <div className="llmBox">
            <label className="checkRow">
              <input type="checkbox" checked={useLlmEnhancement} onChange={(event) => setUseLlmEnhancement(event.target.checked)} />
              KI-Veredelung fuer meine Suche
            </label>
            <input
              type="password"
              value={llmToken}
              onChange={(event) => updateLlmToken(event.target.value)}
              placeholder="Privates Walkwise-Token"
              autoComplete="off"
            />
            <p>Nur mit deinem Token aktiv. Oeffentliche Nutzer bleiben beim Open-Data-Ranking.</p>
          </div>
        )}

        <button type="button" onClick={loadPois} disabled={isLoadingPois}>
          {isLoadingPois ? (
            <span className="buttonLoading">
              <span className="spinner" /> Suche läuft...
            </span>
          ) : (
            "Sehenswürdigkeiten laden"
          )}
        </button>

        <label>Start (optional)</label>
        <div className="addressField">
          <input
            value={startText}
            onChange={(e) => {
              setSelectedStartLabel("");
              setStartText(e.target.value);
            }}
            placeholder="Adresse, Hotel oder Bahnhof"
          />
          <AddressSuggestions
            isSearching={isSearchingStart}
            suggestions={startSuggestions}
            onSelect={(suggestion) =>
              chooseAddressSuggestion(suggestion, setStartText, setStartSuggestions, setSelectedStartLabel, setIsSearchingStart)
            }
          />
        </div>
        <label>Ende (optional)</label>
        <div className="addressField">
          <input
            value={endText}
            onChange={(e) => {
              setSelectedEndLabel("");
              setEndText(e.target.value);
            }}
            placeholder="Adresse, Hotel oder Bahnhof"
          />
          <AddressSuggestions
            isSearching={isSearchingEnd}
            suggestions={endSuggestions}
            onSelect={(suggestion) =>
              chooseAddressSuggestion(suggestion, setEndText, setEndSuggestions, setSelectedEndLabel, setIsSearchingEnd)
            }
          />
        </div>
        <label>Route</label>
        <div className="segmentedControl" role="group" aria-label="Routenart">
          <button
            type="button"
            className={routePreference === "fastest" ? "active" : ""}
            onClick={() => setRoutePreference("fastest")}
          >
            Schnellste
          </button>
          <button
            type="button"
            className={routePreference === "beautiful" ? "active" : ""}
            onClick={() => setRoutePreference("beautiful")}
          >
            Schönste
          </button>
        </div>
        <button type="button" onClick={generateRoute} disabled={isPlanning}>
          {isPlanning ? (
            <span className="buttonLoading">
              <span className="spinner" /> Route wird geplant...
            </span>
          ) : (
            "Tagesroute planen"
          )}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel poiPanel" aria-busy={isLoadingPois}>
        <h2>Sehenswürdigkeiten ({selectedPois.length} ausgewählt)</h2>
        <div className="manualPoi">
          <div className="addressField">
            <input
              value={manualPoiText}
              onChange={(event) => {
                setSelectedManualPoiLabel("");
                setManualPoiText(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addManualPoi();
              }}
              placeholder="Sehenswürdigkeit, Adresse oder Name hinzufügen"
            />
            <AddressSuggestions
              isSearching={isSearchingManualPoi}
              suggestions={manualPoiSuggestions}
              onSelect={chooseManualPoiSuggestion}
            />
          </div>
          <button type="button" onClick={() => void addManualPoi()} disabled={isAddingPoi}>
            {isAddingPoi ? "Suche..." : "Hinzufügen"}
          </button>
        </div>
        {isLoadingPois && <p className="resultMeta">Suche die beliebtesten Orte aus offenen Daten...</p>}
        {llmNotice && !isLoadingPois && <p className={poiEnhancement === "llm" ? "notice success" : "notice"}>{llmNotice}</p>}
        {pois.length > 0 && !isLoadingPois && (
          <p className="resultMeta">
            {pois.length} Vorschläge, {poiEnhancement === "llm" ? "KI-veredelt" : "sortiert nach Beliebtheit"}
          </p>
        )}
        <div className="poiList">
          {isLoadingPois &&
            Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="poiSkeleton">
                <span />
                <div>
                  <i />
                  <b />
                  <em />
                </div>
              </div>
            ))}
          {pois.map((poi) => (
            <article
              key={poi.id}
              id={poiCardId(poi.id)}
              className={[
                "poiCard",
                selectedIds.has(poi.id) ? "selected" : "",
                activePoiId === poi.id ? "active" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => focusPoi(poi.id, false)}
            >
              <img src={poi.imageUrl} alt="" loading="lazy" />
              <div className="poiContent">
                <div className="poiMeta">
                  <span className="categoryBadge">{formatCategory(poi.category)}</span>
                  <label className="selectPoi">
                    <input type="checkbox" checked={selectedIds.has(poi.id)} onChange={() => togglePoi(poi.id)} />
                    Auswählen
                  </label>
                </div>
                <h3>{poi.name}</h3>
                <p>{poi.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mapPanel">
        <MapContainer center={mapCenter} zoom={13} className="map">
          <MapViewSync activePoi={activePoi} city={selectedCity} pois={pois} plan={plan} />
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {plan?.polyline && <Polyline positions={plan.polyline} />}
          {pois.map((poi) => (
            <Marker
              key={poi.id}
              eventHandlers={{ click: () => focusPoi(poi.id, true) }}
              icon={iconForPoi(poi)}
              position={[poi.location.lat, poi.location.lon]}
            >
              <Popup>
                <strong>{poi.name}</strong>
                <br />
                {formatCategory(poi.category)}
              </Popup>
            </Marker>
          ))}
          {plan && routeEndpoint(plan, routeStart, "start") && (
            <Marker icon={startIcon} position={routeEndpoint(plan, routeStart, "start") as [number, number]}>
              <Popup>Start</Popup>
            </Marker>
          )}
          {plan && routeEndpoint(plan, routeEnd, "end") && (
            <Marker icon={endIcon} position={routeEndpoint(plan, routeEnd, "end") as [number, number]}>
              <Popup>Ende</Popup>
            </Marker>
          )}
        </MapContainer>
        <div className="routeInfo">
          <h2>Route</h2>
          {!plan && <p>Noch keine Route berechnet.</p>}
          {plan && (
            <>
              <p>{plan.explanation}</p>
              <p>
                {plan.totals.distance_km} km | {plan.totals.walk_minutes} min Gehzeit
              </p>
              <div className="routeActions">
                <button type="button" onClick={shareRoute}>
                  Link teilen
                </button>
                <button type="button" onClick={exportRoutePdf}>
                  PDF teilen
                </button>
                <button type="button" onClick={openInGoogleMaps}>
                  In Google Maps öffnen
                </button>
                {shareFeedback && <span>{shareFeedback}</span>}
              </div>
              <ol className="routeStopList">
                {plan.ordered_stops.map((stop, index) => (
                  <li
                    key={stop.poi.id}
                    draggable
                    onClick={() => focusPoi(stop.poi.id, true)}
                    onDragStart={() => setDraggedStopIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggedStopIndex !== null) moveRouteStop(draggedStopIndex, index);
                      setDraggedStopIndex(null);
                    }}
                  >
                    <span className="dragHandle" aria-hidden="true">
                      ⋮⋮
                    </span>
                    <span className="routeStopNumber" aria-label={`Stopp ${index + 1}`}>
                      {index + 1}
                    </span>
                    <span>
                      {stop.poi.name} ({stop.walkMinutesFromPrev} min, ETA +{stop.etaMinutesFromStart})
                    </span>
                    <span className="routeMoveButtons">
                      <button type="button" onClick={() => moveRouteStop(index, index - 1)} disabled={index === 0 || isPlanning}>
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveRouteStop(index, index + 1)}
                        disabled={index === plan.ordered_stops.length - 1 || isPlanning}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function AddressSuggestions({
  isSearching,
  suggestions,
  onSelect
}: {
  isSearching: boolean;
  suggestions: AddressSuggestion[];
  onSelect: (suggestion: AddressSuggestion) => void;
}) {
  if (!isSearching && !suggestions.length) return null;
  return (
    <div className="addressSuggestions">
      {isSearching && <div className="addressSuggestion muted">Suche...</div>}
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.label}-${suggestion.location.lat}-${suggestion.location.lon}`}
          type="button"
          className="addressSuggestion"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(suggestion)}
        >
          <strong>{displayNameFromAddress(suggestion.label)}</strong>
          <span>{suggestion.label}</span>
        </button>
      ))}
    </div>
  );
}

function MapViewSync({
  activePoi,
  city,
  pois,
  plan
}: {
  activePoi: Poi | null;
  city: CitySuggestion | null;
  pois: Poi[];
  plan: PlanResult | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (plan?.polyline.length) {
      map.fitBounds(plan.polyline, { padding: [36, 36], maxZoom: 15 });
      return;
    }
    if (pois.length) {
      const bounds = L.latLngBounds(pois.map((poi) => [poi.location.lat, poi.location.lon]));
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
      return;
    }
    if (city) map.setView([city.location.lat, city.location.lon], 13);
  }, [city, map, plan, pois]);

  useEffect(() => {
    if (!activePoi) return;
    map.setView([activePoi.location.lat, activePoi.location.lon], Math.max(map.getZoom(), 15), { animate: true });
  }, [activePoi, map]);

  return null;
}

function createPoiIcon(color: "blue" | "green", variant = "") {
  return L.divIcon({
    className: "",
    html: `<span class="poiMarker ${color} ${variant}"><span></span></span>`,
    iconSize: [28, 40],
    iconAnchor: [14, 39],
    popupAnchor: [0, -36]
  });
}

function createNumberedPoiIcon(number: number, isActive: boolean) {
  return L.divIcon({
    className: "",
    html: `<span class="routeNumberMarker ${isActive ? "active" : ""}"><span>${number}</span></span>`,
    iconSize: [30, 38],
    iconAnchor: [15, 37],
    popupAnchor: [0, -34]
  });
}

function createEndpointIcon(label: string, kind: "start" | "end") {
  return L.divIcon({
    className: "",
    html: `<span class="endpointMarker ${kind}">${label}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
  });
}

function routeEndpoint(plan: PlanResult, explicitPoint: LatLon | null, kind: "start" | "end"): [number, number] | null {
  if (explicitPoint) return [explicitPoint.lat, explicitPoint.lon];
  if (kind === "start") {
    const first = plan.ordered_stops[0]?.poi.location;
    return first ? [first.lat, first.lon] : null;
  }
  const last = plan.ordered_stops[plan.ordered_stops.length - 1]?.poi.location;
  return last ? [last.lat, last.lon] : null;
}

function buildShareState(
  city: string,
  selectedCity: CitySuggestion | null,
  startText: string,
  endText: string,
  routeStart: LatLon | null,
  routeEnd: LatLon | null,
  routePreference: RoutePreference,
  selectedPois: Poi[],
  plan: PlanResult | null
): SharedRouteState | null {
  const orderedPois = plan?.ordered_stops.map((stop) => stop.poi);
  const poisToShare = orderedPois?.length ? orderedPois : selectedPois;
  if (!poisToShare.length) return null;
  return {
    city,
    selectedCity,
    startText,
    endText,
    routeStart,
    routeEnd,
    routePreference,
    pois: poisToShare,
    orderedPois
  };
}

function readSharedRouteState(): SharedRouteState | null {
  const compactMatch = window.location.hash.match(/^#r=(.+)$/);
  const legacyMatch = window.location.hash.match(/^#route=(.+)$/);
  const match = compactMatch ?? legacyMatch;
  if (!match) return null;
  try {
    return compactMatch ? decodeCompactShareState(match[1]) : decodeLegacyShareState(match[1]);
  } catch {
    return null;
  }
}

function encodeShareState(state: SharedRouteState): string {
  const json = JSON.stringify(toThinShareState(state));
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCompactShareState(value: string): SharedRouteState {
  const compact = decodeBase64Json(value);
  if (isThinSharedRouteState(compact)) return fromThinShareState(compact);
  return fromCompactShareState(compact as CompactSharedRouteState);
}

function fromCompactShareState(compact: CompactSharedRouteState): SharedRouteState {
  return {
    city: compact.c,
    selectedCity: compact.sc,
    startText: compact.st,
    endText: compact.et,
    routeStart: compact.rs,
    routeEnd: compact.re,
    routePreference: compact.rp,
    pois: compact.p.map(fromCompactPoi),
    orderedPois: compact.o?.map(fromCompactPoi)
  };
}

function fromThinShareState(compact: ThinSharedRouteState): SharedRouteState {
  const fallbackPois = compact.f?.map(fromCompactPoi) ?? [];
  return {
    city: compact.c,
    selectedCity: fromCompactCity(compact.sc, compact.c),
    startText: compact.st ?? "",
    endText: compact.et ?? "",
    routeStart: fromCompactLatLon(compact.rs),
    routeEnd: fromCompactLatLon(compact.re),
    routePreference: compact.rp ?? "fastest",
    pois: fallbackPois,
    poiIds: compact.ids.map(fromCompactPoiId),
    fallbackPois
  };
}

function decodeLegacyShareState(value: string): SharedRouteState {
  return decodeBase64Json(value) as SharedRouteState;
}

function decodeBase64Json(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isThinSharedRouteState(value: unknown): value is ThinSharedRouteState {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 2 && Array.isArray((value as { ids?: unknown }).ids);
}

function toThinShareState(state: SharedRouteState): ThinSharedRouteState {
  const orderedPois = state.orderedPois?.length ? state.orderedPois : state.pois;
  const fallbackPois = orderedPois.filter(shouldInlineSharedPoi);
  return {
    v: 2,
    c: state.city,
    sc: toCompactCity(state.selectedCity),
    st: state.routeStart ? undefined : state.startText || undefined,
    et: state.routeEnd ? undefined : state.endText || undefined,
    rs: toCompactLatLon(state.routeStart),
    re: toCompactLatLon(state.routeEnd),
    rp: state.routePreference === "fastest" ? undefined : state.routePreference,
    ids: orderedPois.map((poi) => toCompactPoiId(poi.id)),
    f: fallbackPois.length ? fallbackPois.map(toCompactPoi) : undefined
  };
}

function toCompactCity(city: CitySuggestion | null): CompactSharedCity | null {
  if (!city) return null;
  return {
    y: city.country,
    a: roundCoordinate(city.location.lat),
    o: roundCoordinate(city.location.lon),
    t: toCompactOsmType(city.osmType),
    x: city.osmId
  };
}

function fromCompactCity(city: CompactSharedCity | CitySuggestion | null, fallbackName = ""): CitySuggestion | null {
  if (!city) return null;
  if ("location" in city) return city;
  const osmType = fromCompactOsmType(city.t);
  const name = "n" in city && typeof city.n === "string" ? city.n : fallbackName;
  const displayName = city.d ?? [name, city.y].filter(Boolean).join(", ") ?? name;
  return {
    id: "i" in city && typeof city.i === "string" ? city.i : `${osmType}/${city.x}`,
    name,
    displayName,
    country: city.y,
    location: { lat: city.a, lon: city.o },
    osmType,
    osmId: city.x
  };
}

function toCompactPoi(poi: Poi): CompactSharedPoi {
  return {
    i: poi.id,
    n: poi.name,
    c: poi.category,
    d: compactDescription(poi.description),
    a: roundCoordinate(poi.location.lat),
    o: roundCoordinate(poi.location.lon),
    p: poi.priority
  };
}

async function hydrateSharedRoutePois(state: SharedRouteState): Promise<Poi[]> {
  const importedPois = state.orderedPois ?? state.pois;
  if (!state.poiIds?.length) return importedPois;

  const fallbackById = new Map((state.fallbackPois ?? importedPois).map((poi) => [poi.id, poi]));
  const result = await getPois(state.city, [], state.selectedCity);
  const fetchedById = new Map(result.pois.map((poi) => [poi.id, poi]));
  const orderedPois = state.poiIds
    .map((id) => fetchedById.get(id) ?? fallbackById.get(id))
    .filter((poi): poi is Poi => Boolean(poi));

  if (!orderedPois.length) throw new Error("No POIs found for shared route.");
  return orderedPois;
}

function shouldInlineSharedPoi(poi: Poi): boolean {
  return poi.id.startsWith("manual/");
}

function fromCompactPoi(poi: CompactSharedPoi): Poi {
  return {
    id: poi.i,
    name: poi.n,
    category: poi.c,
    description: poi.d ?? "Interessanter Stopp fuer deine Walking-Route.",
    imageUrl: `https://placehold.co/360x220/e2e8f0/334155?text=${encodeURIComponent(poi.n.slice(0, 28))}`,
    location: { lat: poi.a, lon: poi.o },
    priority: poi.p
  };
}

function compactDescription(description: string): string | undefined {
  const clean = description.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length <= 120 ? clean : `${clean.slice(0, 117).trim()}...`;
}

function toCompactLatLon(point: LatLon | null): CompactLatLon | undefined {
  return point ? [roundCoordinate(point.lat), roundCoordinate(point.lon)] : undefined;
}

function fromCompactLatLon(point: ThinSharedRouteState["rs"]): LatLon | null {
  if (!point) return null;
  if (Array.isArray(point)) return { lat: point[0], lon: point[1] };
  return point;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 100000) / 100000;
}

function toCompactPoiId(id: string): string {
  const wikidata = id.match(/^wikidata\/Q(\d+)$/);
  if (wikidata) return `q${wikidata[1]}`;
  const wikipedia = id.match(/^wikipedia\/(\d+)$/);
  if (wikipedia) return `p${wikipedia[1]}`;
  const node = id.match(/^node\/(\d+)$/);
  if (node) return `n${node[1]}`;
  const way = id.match(/^way\/(\d+)$/);
  if (way) return `w${way[1]}`;
  const relation = id.match(/^relation\/(\d+)$/);
  if (relation) return `r${relation[1]}`;
  return id;
}

function fromCompactPoiId(id: string): string {
  if (/^q\d+$/.test(id)) return `wikidata/Q${id.slice(1)}`;
  if (/^p\d+$/.test(id)) return `wikipedia/${id.slice(1)}`;
  if (/^n\d+$/.test(id)) return `node/${id.slice(1)}`;
  if (/^w\d+$/.test(id)) return `way/${id.slice(1)}`;
  if (/^r\d+$/.test(id)) return `relation/${id.slice(1)}`;
  return id;
}

function toCompactOsmType(type: CitySuggestion["osmType"]): CompactOsmType {
  if (type === "relation") return "r";
  if (type === "way") return "w";
  return "n";
}

function fromCompactOsmType(type: CompactOsmType | CitySuggestion["osmType"]): CitySuggestion["osmType"] {
  if (type === "r") return "relation";
  if (type === "w") return "way";
  if (type === "n") return "node";
  return type;
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function buildGoogleMapsUrl(plan: PlanResult, routeStart: LatLon | null, routeEnd: LatLon | null): string {
  const stops = plan.ordered_stops.map((stop) => stop.poi.location);
  const origin = routeStart ?? stops[0];
  const destination = routeEnd ?? stops[stops.length - 1];
  if (!origin || !destination || stops.length <= 1) {
    const point = origin ?? destination;
    return `https://www.google.com/maps/search/?api=1&query=${point ? formatLatLon(point) : ""}`;
  }

  let waypoints = routeStart ? [...stops] : stops.slice(1);
  if (!routeEnd) waypoints = waypoints.slice(0, -1);
  waypoints = waypoints.slice(0, 8);

  const params = new URLSearchParams({
    api: "1",
    travelmode: "walking",
    origin: formatLatLon(origin),
    destination: formatLatLon(destination)
  });
  if (waypoints.length) params.set("waypoints", waypoints.map(formatLatLon).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function formatLatLon(point: LatLon): string {
  return `${point.lat},${point.lon}`;
}

function poiCardId(id: string): string {
  return `poi-card-${encodeURIComponent(id)}`;
}

function selectedCityCenter(city: CitySuggestion | null): [number, number] | null {
  if (!city) return null;
  return [city.location.lat, city.location.lon];
}

function displayNameFromAddress(label: string): string {
  return label.split(",")[0]?.trim() || "Eigener Stopp";
}

function formatCategory(category: string): string {
  const found = CATEGORIES.find((item) => item.key === category);
  return found?.label ?? category.charAt(0).toUpperCase() + category.slice(1);
}

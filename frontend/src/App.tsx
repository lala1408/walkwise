import { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import { geocodeAddress, getPois, planRoute, searchCities } from "./api";
import type { AddressSuggestion, CitySuggestion, PlanResult, Poi, RoutePreference } from "./types";
import "./App.css";

const CITY_DEFAULT = "Berlin";
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
};

function parseLatLon(value: string): LatLon | null {
  const [lat, lon] = value.split(",").map((x) => Number(x.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
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

    const importedPois = sharedRoute.orderedPois ?? sharedRoute.pois;
    setCity(sharedRoute.city);
    setSelectedCity(sharedRoute.selectedCity);
    setStartText(sharedRoute.startText);
    setEndText(sharedRoute.endText);
    setRouteStart(sharedRoute.routeStart);
    setRouteEnd(sharedRoute.routeEnd);
    setRoutePreference(sharedRoute.routePreference === "manual" ? "fastest" : sharedRoute.routePreference);
    setPois(importedPois);
    setSelectedIds(new Set(importedPois.map((poi) => poi.id)));
    setIsPlanning(true);
    planRoute({
      city: sharedRoute.city,
      start: sharedRoute.routeStart ?? undefined,
      end: sharedRoute.routeEnd ?? undefined,
      route_preference: "manual",
      selected_pois: importedPois
    })
      .then(setPlan)
      .catch(() => setError("Geteilte Route konnte nicht geladen werden."))
      .finally(() => setIsPlanning(false));
  }, []);

  useEffect(() => {
    if (city.trim().length < 2 || selectedCity?.name === city.trim()) {
      setIsSearchingCities(false);
      setCitySuggestions([]);
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

  useEffect(() => searchAddressesForField(startText, setStartSuggestions, setIsSearchingStart, selectedStartLabel), [
    city,
    selectedCity,
    startText,
    selectedStartLabel
  ]);
  useEffect(() => searchAddressesForField(endText, setEndSuggestions, setIsSearchingEnd, selectedEndLabel), [
    city,
    selectedCity,
    endText,
    selectedEndLabel
  ]);
  useEffect(
    () => searchAddressesForField(manualPoiText, setManualPoiSuggestions, setIsSearchingManualPoi, selectedManualPoiLabel),
    [city, selectedCity, manualPoiText, selectedManualPoiLabel]
  );

  function searchAddressesForField(
    value: string,
    setSuggestions: (suggestions: AddressSuggestion[]) => void,
    setSearching: (value: boolean) => void,
    selectedLabel = ""
  ) {
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
  }

  async function loadPois() {
    setError("");
    setIsLoadingPois(true);
    try {
      const resolvedCity = selectedCity ?? (await resolveTypedCity());
      const data = await getPois(city, [], resolvedCity);
      setPois(data);
      setSelectedIds(new Set(data.slice(0, 8).map((x) => x.id)));
      setPlan(null);
      if (!data.length) setError("Keine Sehenswürdigkeiten gefunden. Bitte eine andere Stadt wählen.");
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
    const url = `${window.location.origin}${window.location.pathname}#route=${encodeShareState(state)}`;
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
        {pois.length > 0 && !isLoadingPois && <p className="resultMeta">{pois.length} Vorschläge, sortiert nach Beliebtheit</p>}
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
  const match = window.location.hash.match(/^#route=(.+)$/);
  if (!match) return null;
  try {
    return decodeShareState(match[1]);
  } catch {
    return null;
  }
}

function encodeShareState(state: SharedRouteState): string {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeShareState(value: string): SharedRouteState {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as SharedRouteState;
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

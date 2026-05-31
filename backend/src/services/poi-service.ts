import axios from "axios";
import { LRUCache } from "lru-cache";
import type { LatLng, Poi } from "../types.js";
import { OPEN_DATA_HEADERS } from "./open-data-headers.js";

const POI_CACHE = new LRUCache<string, Poi[]>({ max: 100, ttl: 1000 * 60 * 30 });
const POI_CACHE_VERSION = "wikidata-auto-v11";
type InternalPoi = Poi & { wikidataId?: string; hasCustomDescription: boolean; popularityScore: number };
type WikidataTypeCategory = { id: string; category: string };

const CATEGORY_TAGS: Record<string, string[]> = {
  museum: ['tourism="museum"'],
  gallery: ['tourism="gallery"'],
  landmark: ['tourism="attraction"'],
  viewpoint: ['tourism="viewpoint"'],
  monument: ['historic="monument"'],
  memorial: ['historic="memorial"'],
  castle: ['historic="castle"'],
  church: ['building="cathedral"', 'building="church"', 'amenity="place_of_worship"'],
  square: ['place="square"'],
  park: ['leisure="park"', 'leisure="garden"'],
  architecture: ['historic="building"', 'building="cathedral"', 'building="church"']
};
const ALL_CATEGORY_KEYS = [
  "museum",
  "gallery",
  "landmark",
  "viewpoint",
  "monument",
  "memorial",
  "castle",
  "church",
  "square",
  "park",
  "architecture"
];
const WIKIDATA_TYPES: WikidataTypeCategory[] = [
  { id: "Q570116", category: "landmark" },
  { id: "Q33506", category: "museum" },
  { id: "Q207694", category: "museum" },
  { id: "Q1970365", category: "museum" },
  { id: "Q1329623", category: "museum" },
  { id: "Q1497375", category: "architecture" },
  { id: "Q4989906", category: "monument" },
  { id: "Q1516079", category: "monument" },
  { id: "Q16560", category: "castle" },
  { id: "Q751876", category: "castle" },
  { id: "Q23413", category: "castle" },
  { id: "Q153562", category: "architecture" },
  { id: "Q543654", category: "architecture" },
  { id: "Q16970", category: "church" },
  { id: "Q163687", category: "church" },
  { id: "Q2977", category: "church" },
  { id: "Q56242215", category: "church" },
  { id: "Q120560", category: "church" },
  { id: "Q22698", category: "park" },
  { id: "Q338112", category: "park" },
  { id: "Q174782", category: "memorial" },
  { id: "Q13033698", category: "square" },
  { id: "Q202570", category: "landmark" },
  { id: "Q2319498", category: "landmark" },
  { id: "Q839954", category: "landmark" }
];

export async function fetchPois(city: string, _categories: string[], osmType?: string, osmId?: number, center?: LatLng): Promise<Poi[]> {
  const categories: string[] = [];
  const cacheKey = `${POI_CACHE_VERSION}::${city.toLowerCase()}::${osmType ?? "name"}:${osmId ?? ""}::${center?.lat ?? ""},${center?.lon ?? ""}`;
  const cached = POI_CACHE.get(cacheKey);
  if (cached) return cached;

  const selectors = buildSelectors(categories);
  const areaSelector = buildAreaSelector(city, osmType, osmId);
  const query = `
  [out:json][timeout:25];
  ${areaSelector}->.searchArea;
  (
    ${selectors.map((s) => `node[${s}](area.searchArea);`).join("\n")}
    ${selectors.map((s) => `way[${s}](area.searchArea);`).join("\n")}
    ${shouldFetchRelations(categories) ? selectors.map((s) => `relation[${s}](area.searchArea);`).join("\n") : ""}
  );
  out center tags;
  `;

  const [osmResult, wikidataResult] = await Promise.allSettled([
    fetchOverpassPois(query),
    center ? fetchWikidataCandidates(center, categories) : Promise.resolve([])
  ]);
  const osmPois = osmResult.status === "fulfilled" ? osmResult.value : [];
  const wikidataPois = wikidataResult.status === "fulfilled" ? wikidataResult.value : [];
  const merged = mergePois([...wikidataPois, ...osmPois]).sort(sortByPopularity).slice(0, 50);
  const needsEnrichment = merged.some((poi) => poi.wikidataId && (isPlaceholderImage(poi.imageUrl) || !poi.hasCustomDescription));
  const pois = stripInternalPoiFields(needsEnrichment ? await enrichWikidataImages(merged) : merged);
  if (pois.length) POI_CACHE.set(cacheKey, pois);
  return pois;
}

async function fetchOverpassPois(query: string): Promise<InternalPoi[]> {
  try {
    const response = await axios.post("https://overpass-api.de/api/interpreter", new URLSearchParams({ data: query }), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...OPEN_DATA_HEADERS
      },
      timeout: 5000
    });
    return normalizePois(response.data?.elements ?? []);
  } catch {
    return [];
  }
}

function buildAreaSelector(city: string, osmType?: string, osmId?: number): string {
  const areaId = toOverpassAreaId(osmType, osmId);
  if (areaId) return `area(${areaId})`;
  return `area["name"="${escapeOverpassString(city)}"]["boundary"="administrative"]`;
}

function toOverpassAreaId(osmType?: string, osmId?: number): number | null {
  if (!osmId) return null;
  if (osmType === "relation") return 3600000000 + osmId;
  if (osmType === "way") return 2400000000 + osmId;
  return null;
}

function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizePois(elements: any[]): InternalPoi[] {
  const seen = new Set<string>();
  const pois: InternalPoi[] = [];
  for (const el of elements) {
    const lat = Number(el.lat ?? el.center?.lat);
    const lon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = String(el.tags?.name ?? "").trim();
    if (!name) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = el.tags ?? {};
    pois.push({
      id,
      name,
      category: deriveCategory(tags),
      description: buildDescription(tags, name),
      imageUrl: buildImageUrl(tags, name),
      wikidataId: tags.wikidata,
      hasCustomDescription: hasCustomDescription(tags),
      popularityScore: derivePopularityScore(tags),
      location: { lat, lon },
      priority: derivePriority(tags)
    });
  }
  return pois;
}

function curatedHighlights(city: string, categories: string[]): InternalPoi[] {
  const normalizedCity = city.trim().toLowerCase();
  const allCategories = categories.length === 0;
  const matchesCategory = (category: string) => allCategories || categories.includes(category);

  if (!["barcelona", "barcelone", "barcelon"].includes(normalizedCity)) return [];

  const highlights: InternalPoi[] = [
    {
      id: "curated/barcelona/sagrada-familia",
      name: "Sagrada Família",
      category: "church",
      description: "Weltberühmte Basilika von Antoni Gaudí und eines der wichtigsten Wahrzeichen Barcelonas.",
      imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Sagrada%20Familia%2001.jpg?width=360",
      wikidataId: "Q48435",
      hasCustomDescription: true,
      popularityScore: 1000,
      location: { lat: 41.40363, lon: 2.17436 },
      priority: 5
    },
    {
      id: "curated/barcelona/casa-batllo",
      name: "Casa Batlló",
      category: "architecture",
      description: "Ikonisches Modernisme-Haus von Antoni Gaudí am Passeig de Gràcia.",
      imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Casa%20Batllo%20Overview%20Barcelona%20Spain%20cut.jpg?width=360",
      wikidataId: "Q174426",
      hasCustomDescription: true,
      popularityScore: 900,
      location: { lat: 41.39167, lon: 2.16495 },
      priority: 5
    },
    {
      id: "curated/barcelona/casa-mila",
      name: "Casa Milà",
      category: "architecture",
      description: "Auch La Pedrera genannt: ein berühmtes Gaudí-Gebäude mit markanter Stein-Fassade.",
      imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Casa%20Mila%20Barcelona%202013.jpg?width=360",
      wikidataId: "Q222257",
      hasCustomDescription: true,
      popularityScore: 860,
      location: { lat: 41.39539, lon: 2.16196 },
      priority: 5
    }
  ];

  return highlights.filter((poi) => matchesCategory(poi.category));
}

async function fetchWikidataCandidates(center: LatLng, categories: string[]): Promise<InternalPoi[]> {
  const selectedTypes = wikidataTypesForCategories(categories);
  if (!selectedTypes.length) return [];

  const values = selectedTypes.map((type) => `wd:${type.id}`).join(" ");
  const query = `
    SELECT ?item ?itemLabel ?type ?coord ?image ?description ?sitelinks WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord.
        bd:serviceParam wikibase:center "Point(${center.lon} ${center.lat})"^^geo:wktLiteral.
        bd:serviceParam wikibase:radius "12".
      }
      ?item wdt:P31 ?type.
      VALUES ?type { ${values} }
      ?item wikibase:sitelinks ?sitelinks.
      FILTER(?sitelinks >= 8)
      OPTIONAL { ?item wdt:P18 ?image. }
      OPTIONAL {
        ?item schema:description ?description.
        FILTER(LANG(?description) IN ("de", "en"))
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }
    }
    ORDER BY DESC(?sitelinks)
    LIMIT 260
  `;

  try {
    const response = await requestWikidata(query, 15000);
    return normalizeWikidataPois(response.data?.results?.bindings ?? []);
  } catch {
    return [];
  }
}

function normalizeWikidataPois(bindings: any[]): InternalPoi[] {
  const byId = new Map<string, InternalPoi>();
  for (const binding of bindings) {
    const wikidataId = String(binding.item?.value ?? "").split("/").pop();
    const name = String(binding.itemLabel?.value ?? "").trim();
    const coord = parseWikidataPoint(String(binding.coord?.value ?? ""));
    if (!wikidataId || !name || !coord) continue;
    if (isExcludedSightseeingName(name)) continue;

    const typeId = String(binding.type?.value ?? "").split("/").pop() ?? "";
    const category = categoryForWikidataType(typeId);
    const sitelinks = Number(binding.sitelinks?.value ?? 0);
    const description = String(binding.description?.value ?? "");
    const image = String(binding.image?.value ?? "");
    const candidate: InternalPoi = {
      id: `wikidata/${wikidataId}`,
      name,
      category,
      description: buildPoiSummary(name, category, description),
      imageUrl: image || buildImageUrl({}, name),
      wikidataId,
      hasCustomDescription: isUsefulDescription(description),
      popularityScore: 120 + Math.min(sitelinks, 1000) / 3 + (image ? 30 : 0),
      location: coord,
      priority: sitelinks > 150 ? 5 : sitelinks > 50 ? 4 : 3
    };

    const existing = byId.get(wikidataId);
    if (!existing || candidate.popularityScore > existing.popularityScore) byId.set(wikidataId, candidate);
  }
  return [...byId.values()];
}

function mergePois(pois: InternalPoi[]): InternalPoi[] {
  const byKey = new Map<string, InternalPoi>();
  for (const poi of pois) {
    const key = poi.wikidataId ? `wikidata:${poi.wikidataId}` : `name:${normalizeName(poi.name)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, poi);
      continue;
    }
    const base = poi.popularityScore > existing.popularityScore ? poi : existing;
    const fallback = base === existing ? poi : existing;
    byKey.set(key, {
      ...base,
      imageUrl: chooseBestImage(base.imageUrl, fallback.imageUrl),
      description: chooseBestDescription(base, fallback),
      hasCustomDescription: existing.hasCustomDescription || poi.hasCustomDescription,
      popularityScore: Math.max(existing.popularityScore, poi.popularityScore),
      priority: Math.max(existing.priority, poi.priority)
    });
  }
  return [...byKey.values()];
}

function chooseBestImage(primary: string, secondary: string): string {
  if (isPlaceholderImage(primary) && !isPlaceholderImage(secondary)) return secondary;
  return primary;
}

function chooseBestDescription(primary: InternalPoi, secondary: InternalPoi): string {
  if (primary.hasCustomDescription) return primary.description;
  if (secondary.hasCustomDescription) return secondary.description;
  return primary.description.length >= secondary.description.length ? primary.description : secondary.description;
}

async function enrichWikidataImages(pois: InternalPoi[]): Promise<InternalPoi[]> {
  const ids = [...new Set(pois.map((poi) => poi.wikidataId).filter(Boolean))];
  if (!ids.length) return pois;

  try {
    const values = ids.map((id) => `wd:${id}`).join(" ");
    const query = `
      SELECT ?item ?image ?description ?sitelinks WHERE {
        VALUES ?item { ${values} }
        ?item wikibase:sitelinks ?sitelinks.
        OPTIONAL { ?item wdt:P18 ?image. }
        OPTIONAL {
          ?item schema:description ?description.
          FILTER(LANG(?description) IN ("de", "en"))
        }
      }
    `;
    const response = await requestWikidata(query, 4000);
    const imageById = new Map<string, string>();
    const descriptionById = new Map<string, string>();
    const sitelinksById = new Map<string, number>();
    for (const binding of response.data?.results?.bindings ?? []) {
      const id = String(binding.item?.value ?? "").split("/").pop();
      const image = String(binding.image?.value ?? "");
      const description = String(binding.description?.value ?? "");
      const lang = String(binding.description?.["xml:lang"] ?? "");
      const sitelinks = Number(binding.sitelinks?.value ?? 0);
      if (id && image) imageById.set(id, image);
      if (id && Number.isFinite(sitelinks)) sitelinksById.set(id, Math.max(sitelinksById.get(id) ?? 0, sitelinks));
      if (id && isUsefulDescription(description) && (!descriptionById.has(id) || lang === "de")) {
        descriptionById.set(id, shortenDescription(sentenceCase(description)));
      }
    }

    return pois.map((poi) => {
      const image = poi.wikidataId ? imageById.get(poi.wikidataId) : null;
      const description = poi.wikidataId ? descriptionById.get(poi.wikidataId) : null;
      const sitelinks = poi.wikidataId ? sitelinksById.get(poi.wikidataId) ?? 0 : 0;
      return {
        ...poi,
        imageUrl: image ?? poi.imageUrl,
        description: description && !poi.hasCustomDescription ? buildPoiSummary(poi.name, poi.category, description) : poi.description,
        popularityScore: poi.popularityScore + Math.min(sitelinks, 500) / 4
      };
    });
  } catch {
    return pois;
  }
}

async function requestWikidata(query: string, timeout: number) {
  try {
    return await axios.get("https://query.wikidata.org/sparql", {
      params: { query, format: "json" },
      headers: {
        Accept: "application/sparql-results+json",
        ...OPEN_DATA_HEADERS
      },
      timeout
    });
  } catch (getError) {
    try {
      return await axios.post("https://query.wikidata.org/sparql", new URLSearchParams({ query, format: "json" }), {
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
          ...OPEN_DATA_HEADERS
        },
        timeout
      });
    } catch {
      throw getError;
    }
  }
}

function stripInternalPoiFields(pois: InternalPoi[]): Poi[] {
  return pois.map((poi) => {
    const {
      wikidataId: _wikidataId,
      hasCustomDescription: _hasCustomDescription,
      popularityScore: _popularityScore,
      ...publicPoi
    } = poi;
    return publicPoi;
  });
}

function deriveCategory(tags: Record<string, string>): string {
  if (tags.tourism === "museum") return "museum";
  if (tags.tourism === "gallery") return "gallery";
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.historic === "monument") return "monument";
  if (tags.historic === "memorial") return "memorial";
  if (tags.historic === "castle") return "castle";
  if (tags.amenity === "place_of_worship" || tags.building === "cathedral" || tags.building === "church") return "church";
  if (tags.place === "square") return "square";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.historic || tags.building) return "architecture";
  return "landmark";
}

function buildDescription(tags: Record<string, string>, name: string): string {
  if (tags["description:de"]) return shortenDescription(tags["description:de"]);
  if (tags["description:en"]) return shortenDescription(tags["description:en"]);
  if (tags.description) return shortenDescription(tags.description);
  const category = deriveCategory(tags);
  if (tags.architect) return shortenDescription(`${name} ist ein ${formatCategoryForSentence(category)} mit Bezug zu ${tags.architect}.`);
  if (tags.artist_name) return shortenDescription(`${name} ist ein ${formatCategoryForSentence(category)} von ${tags.artist_name}.`);
  if (tags.start_date) return shortenDescription(`${name} ist ein ${formatCategoryForSentence(category)} aus dem Jahr ${tags.start_date}.`);
  if (tags.website) return shortenDescription(`${name} ist ein ${formatCategoryForSentence(category)} mit eigenen Besucherinformationen.`);
  const categoryText: Record<string, string> = {
    museum: "Museum mit kulturellen oder historischen Ausstellungen.",
    gallery: "Galerie oder Ausstellungsort fuer Kunst und Design.",
    landmark: "Markanter Ort, der sich gut als Stopp auf einer Stadtroute eignet.",
    viewpoint: "Aussichtspunkt mit Blick ueber die Umgebung.",
    monument: "Denkmal oder historischer Bezugspunkt im Stadtbild.",
    memorial: "Gedenkort mit lokaler oder historischer Bedeutung.",
    castle: "Historische Burg- oder Schlossanlage.",
    church: "Kirche oder sakraler Ort mit architektonischem Interesse.",
    square: "Oeffentlicher Platz und guter Orientierungspunkt.",
    park: "Gruene Pause fuer eine ruhigere Etappe der Route.",
    architecture: "Architektonisch interessanter Bau oder historisches Gebaeude."
  };
  return shortenDescription(categoryText[category] ?? categoryText.landmark);
}

function hasCustomDescription(tags: Record<string, string>): boolean {
  return Boolean(tags.description || tags["description:de"] || tags["description:en"]);
}

function formatCategoryForSentence(category: string): string {
  const text: Record<string, string> = {
    museum: "Museum",
    gallery: "Ausstellungsort",
    landmark: "markanter Ort",
    viewpoint: "Aussichtspunkt",
    monument: "Denkmal",
    memorial: "Gedenkort",
    castle: "historischer Ort",
    church: "sakraler Ort",
    square: "oeffentlicher Platz",
    park: "Park",
    architecture: "architektonisch interessanter Ort"
  };
  return text[category] ?? "interessanter Ort";
}

function buildImageUrl(tags: Record<string, string>, name: string): string {
  const file = extractCommonsFile(tags.image ?? tags.wikimedia_commons);
  if (file) return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=360`;
  const text = encodeURIComponent(name.slice(0, 28));
  return `https://placehold.co/360x220/e2e8f0/334155?text=${text}`;
}

function extractCommonsFile(value?: string): string | null {
  if (!value) return null;
  if (value.startsWith("File:")) return value.replace(/^File:/, "");
  if (value.startsWith("Category:")) return null;
  if (/^https?:\/\//.test(value)) {
    const match = value.match(/\/(?:File|Special:FilePath)[:/](.+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
  return value.includes(".") ? value : null;
}

function derivePriority(tags: Record<string, string>): number {
  let score = 1;
  if (tags.wikipedia) score += 1;
  if (tags.wikidata) score += 1;
  if (tags.tourism === "museum") score += 1;
  return score;
}

function derivePopularityScore(tags: Record<string, string>): number {
  let score = 0;
  if (tags.wikidata) score += 40;
  if (tags.wikipedia) score += 35;
  if (tags.image || tags.wikimedia_commons) score += 25;
  if (tags.website) score += 15;
  if (tags.tourism === "museum" || tags.tourism === "attraction") score += 14;
  if (tags.historic === "monument" || tags.historic === "castle") score += 12;
  if (tags.tourism === "viewpoint") score += 10;
  if (tags.heritage) score += 10;
  if (tags.name) score += Math.min(String(tags.name).length, 30) / 10;
  return score;
}

function sortByPopularity(a: InternalPoi, b: InternalPoi): number {
  if (b.popularityScore !== a.popularityScore) return b.popularityScore - a.popularityScore;
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.name.localeCompare(b.name);
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isUsefulDescription(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("wikimedia-kategorie") || normalized.includes("wikimedia category")) return false;
  return normalized.length > 8;
}

function buildPoiSummary(name: string, category: string, rawDescription: string): string {
  const detail = isUsefulDescription(rawDescription) ? sentenceCase(rawDescription) : "";
  const categoryDetail = buildDescriptionForCategory(category);
  if (!detail) return categoryDetail;

  const normalizedDetail = detail.toLowerCase();
  const categorySentence = categoryDetail.endsWith(".") ? categoryDetail.slice(0, -1) : categoryDetail;
  if (normalizedDetail.includes("museum") && category === "museum") return shortenDescription(`${detail}. Gut geeignet als kultureller Schwerpunkt einer Tagesroute.`);
  if (normalizedDetail.includes("park") && category === "park") return shortenDescription(`${detail}. Eignet sich als ruhigere Etappe zwischen dichteren Stadtstopps.`);
  if (normalizedDetail.includes(name.toLowerCase())) return shortenDescription(`${detail}. ${categorySentence}.`);
  return shortenDescription(`${detail}. ${categorySentence}.`);
}

function shortenDescription(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= 230) return clean;
  return `${clean.slice(0, 227).trim()}...`;
}

function buildSelectors(categories: string[]): string[] {
  if (!categories.length) {
    return ALL_CATEGORY_KEYS.flatMap((key) => CATEGORY_TAGS[key] ?? []);
  }
  return [...new Set(categories.flatMap((c) => CATEGORY_TAGS[c] ?? []))];
}

function shouldFetchRelations(categories: string[]): boolean {
  return categories.length > 0;
}

function wikidataTypesForCategories(categories: string[]): WikidataTypeCategory[] {
  if (!categories.length) return WIKIDATA_TYPES;
  return WIKIDATA_TYPES.filter((type) => categories.includes(type.category));
}

function categoryForWikidataType(typeId: string): string {
  return WIKIDATA_TYPES.find((type) => type.id === typeId)?.category ?? "landmark";
}

function parseWikidataPoint(value: string): LatLng | null {
  const match = value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPlaceholderImage(value: string): boolean {
  return value.includes("placehold.co");
}

function isExcludedSightseeingName(name: string): boolean {
  return /\b(airport|flughafen|aeroport|aeropuerto|station|bahnhof)\b/i.test(name);
}

function buildDescriptionForCategory(category: string): string {
  const descriptions: Record<string, string> = {
    museum: "Museum mit kulturellen oder historischen Ausstellungen.",
    gallery: "Galerie oder Ausstellungsort fuer Kunst und Design.",
    landmark: "Bekannte Sehenswuerdigkeit und wichtiger Orientierungspunkt.",
    viewpoint: "Aussichtspunkt mit Blick ueber die Umgebung.",
    monument: "Denkmal oder historischer Bezugspunkt im Stadtbild.",
    memorial: "Gedenkort mit lokaler oder historischer Bedeutung.",
    castle: "Historische Burg- oder Schlossanlage.",
    church: "Kirche oder sakraler Ort mit architektonischem Interesse.",
    square: "Oeffentlicher Platz und guter Orientierungspunkt.",
    park: "Gruene Pause fuer eine ruhigere Etappe der Route.",
    architecture: "Architektonisch interessanter Bau oder historisches Gebaeude."
  };
  return descriptions[category] ?? descriptions.landmark;
}

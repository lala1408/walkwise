import crypto from "node:crypto";
import axios from "axios";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { LatLng, Poi } from "../types.js";
import { OPEN_DATA_HEADERS } from "./open-data-headers.js";

export type PoiEnhancementStatus = "open-data" | "llm" | "llm-fallback" | "llm-unauthorized";

export type PoiEnhancementResult = {
  pois: Poi[];
  enhancement: PoiEnhancementStatus;
  message?: string;
  model?: string;
};

const LLM_POI_CACHE = new LRUCache<string, PoiEnhancementResult>({ max: 100, ttl: 1000 * 60 * 60 * 24 * 14 });
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const MAX_LLM_CANDIDATES = 80;
const MAX_DESCRIPTION_LENGTH = 230;
const ALLOWED_CATEGORIES = new Set([
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
]);

const llmPoiItemSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(100).optional(),
  category: z.string().optional(),
  description: z.string().optional()
});

const llmPoiResponseSchema = z.object({
  pois: z.array(llmPoiItemSchema).min(1).max(80)
});

export function canUseLlmEnhancement(requested: boolean, token: string | undefined): boolean {
  if (!requested) return false;
  const expectedToken = process.env.WALKWISE_LLM_TOKEN?.trim();
  if (!expectedToken || !token) return false;
  return safeTokenEqual(token.trim(), expectedToken);
}

export async function enhancePoisWithLlm(city: string, pois: Poi[], center?: LatLng): Promise<PoiEnhancementResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_POI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  if (!apiKey) {
    return {
      pois,
      enhancement: "llm-fallback",
      message: "KI-Modus angefragt, aber OPENAI_API_KEY ist nicht gesetzt."
    };
  }
  if (pois.length < 3) {
    return { pois, enhancement: "llm-fallback", message: "Zu wenige Kandidaten fuer eine KI-Veredelung." };
  }

  const cacheKey = buildLlmCacheKey(city, model, pois, center);
  const cached = LLM_POI_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const candidates = pois.slice(0, MAX_LLM_CANDIDATES).map((poi, index) => ({
      id: poi.id,
      rank: index + 1,
      name: poi.name,
      category: poi.category,
      description: poi.description,
      priority: poi.priority,
      lat: Number(poi.location.lat.toFixed(5)),
      lon: Number(poi.location.lon.toFixed(5))
    }));

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Du bist ein strenger Reise-Kurator fuer Walking-Routen. Du darfst nur IDs aus der Kandidatenliste verwenden. Sortiere nach touristischer Relevanz, Bekanntheit, Besuchswert und Eignung als Stadtrouten-Stopp. Entferne klare Dubletten oder Orte, die keine sinnvolle Sehenswuerdigkeit sind, aber erfinde keine neuen Orte. Schreibe konkrete deutsche Kurztexte mit maximal 2 Saetzen und ohne unsichere Behauptungen. Antworte nur als JSON: {\"pois\":[{\"id\":\"...\",\"score\":0-100,\"category\":\"...\",\"description\":\"...\"}]}."
          },
          {
            role: "user",
            content: JSON.stringify({
              city,
              allowedCategories: [...ALLOWED_CATEGORIES],
              candidates
            })
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...OPEN_DATA_HEADERS
        },
        timeout: 16000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    const parsed = parseLlmPoiResponse(content);
    const enhancedPois = applyLlmPoiRanking(pois, parsed.pois);
    if (enhancedPois.length < Math.min(8, pois.length)) throw new Error("LLM returned too few usable POIs");

    const result: PoiEnhancementResult = {
      pois: enhancedPois.slice(0, 50),
      enhancement: "llm",
      message: "KI-Veredelung aktiv.",
      model
    };
    LLM_POI_CACHE.set(cacheKey, result);
    return result;
  } catch (error) {
    console.warn("LLM POI enhancement failed", error);
    return {
      pois,
      enhancement: "llm-fallback",
      message: "KI-Veredelung nicht verfuegbar, Open-Data-Ranking wird genutzt."
    };
  }
}

function parseLlmPoiResponse(content: unknown): z.infer<typeof llmPoiResponseSchema> {
  const json = JSON.parse(String(content ?? "{}"));
  return llmPoiResponseSchema.parse(json);
}

function applyLlmPoiRanking(pois: Poi[], rankedItems: z.infer<typeof llmPoiItemSchema>[]): Poi[] {
  const poiById = new Map(pois.map((poi) => [poi.id, poi]));
  const seen = new Set<string>();
  const rankedPois: Poi[] = [];

  for (const item of rankedItems) {
    const poi = poiById.get(item.id);
    if (!poi || seen.has(item.id)) continue;
    seen.add(item.id);
    rankedPois.push({
      ...poi,
      category: item.category && ALLOWED_CATEGORIES.has(item.category) ? item.category : poi.category,
      description: sanitizeLlmDescription(item.description) ?? poi.description,
      priority: priorityFromLlmScore(item.score, poi.priority)
    });
  }

  return [...rankedPois, ...pois.filter((poi) => !seen.has(poi.id))];
}

function sanitizeLlmDescription(description?: string): string | null {
  const clean = description?.replace(/\s+/g, " ").trim();
  if (!clean || clean.length < 20) return null;
  return clean.length <= MAX_DESCRIPTION_LENGTH ? clean : `${clean.slice(0, MAX_DESCRIPTION_LENGTH - 3).trim()}...`;
}

function priorityFromLlmScore(score: number | undefined, fallback: number): number {
  if (!Number.isFinite(score)) return fallback;
  if ((score as number) >= 85) return 5;
  if ((score as number) >= 70) return 4;
  if ((score as number) >= 50) return 3;
  return Math.max(1, Math.min(fallback, 2));
}

function buildLlmCacheKey(city: string, model: string, pois: Poi[], center?: LatLng): string {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ city: city.toLowerCase(), model, center, ids: pois.map((poi) => poi.id) }))
    .digest("hex")
    .slice(0, 32);
  return `llm-pois-v1::${hash}`;
}

function safeTokenEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

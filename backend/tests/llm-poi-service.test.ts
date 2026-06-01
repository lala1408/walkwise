import { afterEach, describe, expect, it } from "vitest";
import { canUseLlmEnhancement, enhancePoisWithLlm } from "../src/services/llm-poi-service.js";
import type { Poi } from "../src/types.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("llm poi service", () => {
  it("requires an explicit matching private token", () => {
    process.env.WALKWISE_LLM_TOKEN = "private-token";

    expect(canUseLlmEnhancement(false, "private-token")).toBe(false);
    expect(canUseLlmEnhancement(true, undefined)).toBe(false);
    expect(canUseLlmEnhancement(true, "wrong-token")).toBe(false);
    expect(canUseLlmEnhancement(true, "private-token")).toBe(true);
  });

  it("falls back without an OpenAI API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const pois: Poi[] = [
      buildPoi("1", "Central Park"),
      buildPoi("2", "Metropolitan Museum of Art"),
      buildPoi("3", "Brooklyn Bridge")
    ];

    const result = await enhancePoisWithLlm("New York", pois);

    expect(result.enhancement).toBe("llm-fallback");
    expect(result.pois).toEqual(pois);
  });
});

function buildPoi(id: string, name: string): Poi {
  return {
    id,
    name,
    category: "landmark",
    description: `${name} ist ein bekannter Ort fuer eine Stadtroute.`,
    imageUrl: "https://placehold.co/360x220",
    location: { lat: 40.7, lon: -74 },
    priority: 3
  };
}

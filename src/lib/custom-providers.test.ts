import { describe, it, expect } from "vitest";
import { customProvidersFromKeys } from "./custom-providers";

describe("customProvidersFromKeys", () => {
  it("synthesizes catalog entries for named custom keys", () => {
    const out = customProvidersFromKeys(
      [
        {
          provider: "custom:Ollama Local",
          baseUrl: "http://localhost:11434/v1",
          models: JSON.stringify([
            { id: "llama3", enabled: true, thinkingLevel: "default" },
          ]),
        },
      ],
      new Set(["openai", "custom"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("custom:Ollama Local");
    expect(out[0].name).toBe("Ollama Local");
    expect(out[0].baseUrl).toBe("http://localhost:11434/v1");
    expect(out[0].requiresKey).toBe(true);
    expect(out[0].models.map((m) => m.id)).toEqual(["llama3"]);
  });

  it("still lists providers with no stored models (picker shows, not drops)", () => {
    const out = customProvidersFromKeys(
      [{ provider: "custom:Empty", baseUrl: "https://x.example/v1", models: null }],
      new Set(["custom"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].models).toEqual([]);
  });

  it("skips the bare custom template, known ids, non-custom rows and dupes", () => {
    const out = customProvidersFromKeys(
      [
        { provider: "custom", baseUrl: "", models: null },
        { provider: "openai", baseUrl: null, models: null },
        { provider: "custom:Dupe", baseUrl: "https://a.example", models: null },
        { provider: "custom:Dupe", baseUrl: "https://a.example", models: null },
        { provider: "custom:Known", baseUrl: null, models: null },
      ],
      new Set(["custom", "openai", "custom:Known"]),
    );
    expect(out.map((p) => p.id)).toEqual(["custom:Dupe"]);
  });

  it("falls back to a generic label without a colon suffix", () => {
    const out = customProvidersFromKeys(
      [{ provider: "custom-legacy1", baseUrl: null, models: null }],
      new Set(["custom"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Custom OpenAI-compatible");
  });
});

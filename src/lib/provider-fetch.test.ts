import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  fetchWithSsrf: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    providerKey: {
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
    },
  },
}));

vi.mock("@/lib/ai/ssrf-fetch", () => ({
  fetchWithSsrf: (...args: unknown[]) => mocks.fetchWithSsrf(...args),
}));

vi.mock("@/lib/models-dev", () => ({
  lookupModelInRegistry: vi.fn(async () => ({})),
}));

import { extractOllamaContextLength, refreshProviderModels, resolveOllamaContextWindows } from "@/lib/provider-fetch";

function modelsResponse(ids: string[]) {
  return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
}

describe("refreshProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  it("fetches a keyless local provider without a saved row and stores the list", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({});
    mocks.fetchWithSsrf.mockResolvedValue(modelsResponse(["llama3.2"]));

    const models = await refreshProviderModels("user-1", "ollama");

    expect(models?.map((m) => m.id)).toEqual(["llama3.2"]);
    const [url, init] = mocks.fetchWithSsrf.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/models");
    expect(init.headers.Authorization).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "ollama", isActive: true }),
      }),
    );
  });

  it("keeps the fetched list when a concurrent connect won the row creation race", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockRejectedValue(new Error("Unique constraint failed"));
    mocks.fetchWithSsrf.mockResolvedValue(modelsResponse(["qwen3"]));

    const models = await refreshProviderModels("user-1", "ollama");

    expect(models?.map((m) => m.id)).toEqual(["qwen3"]);
  });

  it("returns null for a keyed provider with no saved row", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(refreshProviderModels("user-1", "openai")).resolves.toBeNull();
    expect(mocks.fetchWithSsrf).not.toHaveBeenCalled();
  });
});

describe("extractOllamaContextLength", () => {
  it("prefers num_ctx from parameters Modelfile configuration", () => {
    const show = {
      parameters: "stop <|im_end|>\nnum_ctx 32768\ntemperature 0.7",
      model_info: {
        "llama.block_count": 32,
        "llama.context_length": 131072,
      },
    };
    expect(extractOllamaContextLength(show)).toBe(32768);
  });

  it("extracts context_length from model_info without being fooled by block_count or head_count", () => {
    const show = {
      parameters: "temperature 0.7",
      model_info: {
        "llama.block_count": 32,
        "llama.attention.head_count": 32,
        "llama.embedding_length": 4096,
        "llama.context_length": 65536,
      },
    };
    expect(extractOllamaContextLength(show)).toBe(65536);
  });

  it("falls back to topLevel context_length", () => {
    expect(extractOllamaContextLength({ context_length: 8192 })).toBe(8192);
  });

  it("returns undefined when payload has no context length info", () => {
    expect(extractOllamaContextLength({})).toBeUndefined();
    expect(extractOllamaContextLength(null)).toBeUndefined();
    expect(extractOllamaContextLength({ model_info: { "llama.block_count": 32 } })).toBeUndefined();
  });
});

describe("resolveOllamaContextWindows", () => {
  it("probes /api/show and populates context window map", async () => {
    mocks.fetchWithSsrf.mockResolvedValue({
      ok: true,
      json: async () => ({
        parameters: "num_ctx 16384",
      }),
    });

    const res = await resolveOllamaContextWindows("http://localhost:11434/v1", ["qwen2.5:7b"]);
    expect(res.get("qwen2.5:7b")).toBe(16384);
    expect(mocks.fetchWithSsrf).toHaveBeenCalledWith(
      "http://localhost:11434/api/show",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "qwen2.5:7b" }),
      }),
    );
  });
});

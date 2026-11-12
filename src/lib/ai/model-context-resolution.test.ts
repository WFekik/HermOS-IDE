import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  resolveOllamaContextWindows: vi.fn(),
  peekModelInRegistry: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    providerKey: {
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      updateMany: (...args: unknown[]) => mocks.updateMany(...args),
    },
  },
}));

vi.mock("@/lib/provider-fetch", () => ({
  refreshProviderModels: vi.fn(),
  resolveOllamaContextWindows: (...args: unknown[]) => mocks.resolveOllamaContextWindows(...args),
}));

vi.mock("@/lib/models-dev", () => ({
  peekModelInRegistry: (...args: unknown[]) => mocks.peekModelInRegistry(...args),
  lookupModelInRegistry: vi.fn(async () => ({})),
}));

import { getModelContextWindow } from "./executor";

describe("getModelContextWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prioritizes user-provided/stored contextWindow over static catalog for online models", async () => {
    // OpenAI has static context window for gpt-4o (128000).
    // If the user configured 32768 in db.providerKey, the user's config MUST win.
    mocks.findUnique.mockResolvedValue({
      models: JSON.stringify([
        { id: "gpt-4o", contextWindow: 32768, contextWindowSource: "user" },
      ]),
    });

    const win = await getModelContextWindow("user-1", "openai", "gpt-4o");
    expect(win).toBe(32768);
    expect(mocks.findUnique).toHaveBeenCalled();
  });

  it("enforces server context as max cap over user configured context", async () => {
    // If the server defines serverContextWindow as 8192, and the user configured 32768,
    // the server context MUST cap the user config at 8192.
    mocks.findUnique.mockResolvedValue({
      models: JSON.stringify([
        { id: "llama3:8b", contextWindow: 32768, serverContextWindow: 8192, contextWindowSource: "user" },
      ]),
    });

    const win = await getModelContextWindow("user-1", "ollama", "llama3:8b");
    expect(win).toBe(8192);
  });

  it("prioritizes server context as default when user has not customized", async () => {
    mocks.findUnique.mockResolvedValue({
      models: JSON.stringify([
        { id: "llama3:8b", serverContextWindow: 8192 },
      ]),
    });

    const win = await getModelContextWindow("user-1", "ollama", "llama3:8b");
    expect(win).toBe(8192);
  });

  it("prioritizes user-provided contextWindow for local models when within server cap or unconstrained", async () => {
    mocks.findUnique.mockResolvedValue({
      models: JSON.stringify([
        { id: "qwen2.5-coder:7b", contextWindow: 65536, contextWindowSource: "user" },
      ]),
    });

    const win = await getModelContextWindow("user-1", "ollama", "qwen2.5-coder:7b");
    expect(win).toBe(65536);
  });

  it("probes Ollama /api/show when contextWindow is not stored in DB", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.resolveOllamaContextWindows.mockResolvedValue(
      new Map([["deepseek-r1:8b", 32768]]),
    );

    const win = await getModelContextWindow("user-1", "ollama", "deepseek-r1:8b");
    expect(win).toBe(32768);
    expect(mocks.resolveOllamaContextWindows).toHaveBeenCalledWith(
      expect.stringContaining("11434"),
      ["deepseek-r1:8b"],
    );
  });

  it("persists a probed Ollama context length with a compare-and-swap on the models column", async () => {
    const rowModels = JSON.stringify([
      { id: "deepseek-r1:8b", enabled: true, contextWindow: 131072, contextWindowSource: "user" },
    ]);
    mocks.findUnique.mockResolvedValue({ id: "pk-1", models: rowModels, baseUrl: null });
    mocks.resolveOllamaContextWindows.mockResolvedValue(new Map([["deepseek-r1:8b", 32768]]));
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const win = await getModelContextWindow("user-1", "ollama", "deepseek-r1:8b");
    expect(win).toBe(32768);

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    const arg = mocks.updateMany.mock.calls[0][0] as {
      where: { id: string; models: string };
      data: { models: string };
    };
    // CAS guard: the write only lands if the row still holds the string we read,
    // so a concurrent settings save is never clobbered.
    expect(arg.where).toEqual({ id: "pk-1", models: rowModels });
    expect(JSON.parse(arg.data.models)).toEqual([
      { id: "deepseek-r1:8b", enabled: true, contextWindow: 32768, contextWindowSource: "user", serverContextWindow: 32768 },
    ]);
  });

  it("keeps the probed cap for the current run when a concurrent save wins the CAS", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "pk-1",
      models: JSON.stringify([{ id: "llama3:8b", enabled: true }]),
      baseUrl: null,
    });
    mocks.resolveOllamaContextWindows.mockResolvedValue(new Map([["llama3:8b", 8192]]));
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const win = await getModelContextWindow("user-1", "ollama", "llama3:8b");
    expect(win).toBe(8192);
  });

  it("falls back to registry peek when model is not stored in DB", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.peekModelInRegistry.mockResolvedValue({ contextWindow: 200000 });

    const win = await getModelContextWindow("user-1", "anthropic", "claude-3-5-sonnet");
    expect(win).toBe(200000);
    expect(mocks.peekModelInRegistry).toHaveBeenCalledWith("claude-3-5-sonnet", "anthropic", { core: true });
  });

  it("falls back to registry peek when static catalog does not list the model", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.peekModelInRegistry.mockResolvedValue({ contextWindow: 131072 });

    const win = await getModelContextWindow("user-1", "openrouter", "custom-org/model-x");
    expect(win).toBe(131072);
  });

  it("falls back to suffix heuristic when registry has no data", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.peekModelInRegistry.mockResolvedValue({});

    const win = await getModelContextWindow("user-1", "custom", "custom-model-64k");
    expect(win).toBe(64000);
  });

  it("provides safe fallback of 4096 for local providers when completely unconfigured", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.resolveOllamaContextWindows.mockResolvedValue(new Map());
    mocks.peekModelInRegistry.mockResolvedValue({});

    const winOllama = await getModelContextWindow("user-1", "ollama", "unknown-local-model");
    expect(winOllama).toBe(4096);

    const winLmStudio = await getModelContextWindow("user-1", "lmstudio", "unknown-lmstudio-model");
    expect(winLmStudio).toBe(4096);
  });

  it("returns undefined for online providers when model context cannot be determined", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.peekModelInRegistry.mockResolvedValue({});

    const win = await getModelContextWindow("user-1", "custom", "unknown-custom-model");
    expect(win).toBeUndefined();
  });
});

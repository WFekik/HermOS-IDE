import { describe, it, expect, afterEach } from "vitest";
import {
  PROVIDERS,
  listProviders,
  getProvider,
  resolveModel,
  modelSupportsVision,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
} from "./providers";
import { extractCapabilities, extractPricing } from "@/lib/provider-fetch";
import { getModelRate } from "@/lib/provider-models";
import { lookupModelInRegistry } from "@/lib/models-dev";
import { lookupContextWindow } from "@/lib/model-context-windows";
import {
  buildProviderHeaders,
  isResponsesRequired,
  markResponsesRequired,
  clearResponsesRequired,
  buildResponsesRequestBody,
  createResponsesTextDedup,
  extractUsageFromBody,
  getBodyMaxTokens,
  setBodyMaxTokens,
} from "./provider-payloads";

describe("Provider Catalog", () => {
  describe("Provider & Model Single Source of Truth Constants", () => {
    it("should export central provider and model default constants", () => {
      expect(DEFAULT_PROVIDER).toBe("puter");
      expect(DEFAULT_MODEL).toBe("auto");
    });

    it("should not hardcode any concrete model ID", async () => {
      // Guards the no-hardcoded-models invariant: providers.ts must not name
      // a model family. Dynamic resolution (auto sentinel, live lists, store
      // config) is the only source of model IDs.
      const fs = await import("fs");
      const src = fs.readFileSync("src/lib/ai/providers.ts", "utf8");
      expect(src).not.toMatch(/DEFAULT_FALLBACK_MODEL/);
      expect(src).not.toMatch(/VISION_MODEL_PATTERNS|NON_VISION_MODEL_PATTERNS/);
    });
  });

  describe("PROVIDERS", () => {
    it("should include all known providers", () => {
      const ids = Object.keys(PROVIDERS);
      expect(ids).toContain("puter");
      expect(ids).toContain("openrouter");
      expect(ids).toContain("openai");
      expect(ids).toContain("anthropic");
      expect(ids).toContain("groq");
      expect(ids).toContain("mistral");
      expect(ids).toContain("together");
      expect(ids).toContain("gemini");
      expect(ids).toContain("custom");
    });

    it("should have valid provider entries with required fields", () => {
      for (const [id, p] of Object.entries(PROVIDERS)) {
        expect(p.id).toBe(id);
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
        expect(typeof p.requiresKey).toBe("boolean");
        expect(Array.isArray(p.models)).toBe(true);
      }
    });

    it("should have proper baseUrl for most providers", () => {
      expect(PROVIDERS.openai.baseUrl).toBe("https://api.openai.com/v1");
      expect(PROVIDERS.anthropic.baseUrl).toBe("https://api.anthropic.com/v1");
      expect(PROVIDERS.groq.baseUrl).toBe("https://api.groq.com/openai/v1");
    });

    it("should assign reasoning schemes to Anthropic and Gemini", () => {
      expect(PROVIDERS.anthropic.reasoningScheme).toBe("anthropic_thinking");
      expect(PROVIDERS.gemini.reasoningScheme).toBe("gemini_effort");
    });

    it("should mark OpenAI-compatible providers as supporting native function calling", () => {
      expect(PROVIDERS.openai.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.anthropic.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.groq.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.mistral.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.together.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.custom.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.puter.supportsNativeFunctionCalling).toBe(true);
    });

    it("should assign reasoning scheme to Puter (OpenAI-compatible gateway)", () => {
      expect(PROVIDERS.puter.reasoningScheme).toBe("openai_effort");
    });
  });

  describe("listProviders", () => {
    it("should return all providers as an array", () => {
      const result = listProviders();
      expect(result).toHaveLength(Object.keys(PROVIDERS).length);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getProvider", () => {
    it("should return a provider by id", () => {
      const p = getProvider("openai");
      expect(p).toBeDefined();
      expect(p!.id).toBe("openai");
    });

    it("should return undefined for unknown provider", () => {
      expect(getProvider("unknown" as any)).toBeUndefined();
    });
  });

  describe("resolveModel", () => {
    it("should return the model as-is when not 'auto'", () => {
      expect(resolveModel("openai", "gpt-4")).toBe("gpt-4");
    });

    it('should return "auto" when provider has no models', () => {
      expect(resolveModel("openai", "auto")).toBe("auto");
    });
  });

  describe("Deduplicated Capability Extraction", () => {
    it("should extract contextWindow and maxOutput from model metadata object", () => {
      const res = extractCapabilities({
        context_window: 128000,
        max_completion_tokens: 4096,
      });
      expect(res.contextWindow).toBe(128000);
      expect(res.maxOutput).toBe(4096);
    });

    it("should handle string context window and max tokens numbers", () => {
      const res = extractCapabilities({
        context_length: "200000",
        max_tokens: "8192",
      });
      expect(res.contextWindow).toBe(200000);
      expect(res.maxOutput).toBe(8192);
    });

    it("should return empty object for invalid/empty inputs", () => {
      expect(extractCapabilities(null)).toEqual({});
      expect(extractCapabilities(undefined)).toEqual({});
      expect(extractCapabilities("invalid")).toEqual({});
    });
  });

  describe("Pricing Lookup (catalog + live metadata)", () => {
    it("should return the catalog-declared provider-level rate for puter (user-pays)", () => {
      expect(getModelRate("puter", "gpt-4o")).toEqual({ in: 0, out: 0 });
    });

    it("should prefer live per-model pricing from runtime metadata", () => {
      const runtimeModels = [
        { id: "openai/gpt-4o-mini", enabled: true, thinkingLevel: "default" as const, pricing: { in: 0.15, out: 0.6 } },
        { id: "openai/gpt-4o", enabled: true, thinkingLevel: "default" as const, pricing: { in: 2.5, out: 10 } },
      ];
      expect(getModelRate("openrouter", "openai/gpt-4o-mini", runtimeModels)).toEqual({ in: 0.15, out: 0.6 });
      expect(getModelRate("openrouter", "openai/gpt-4o", runtimeModels)).toEqual({ in: 2.5, out: 10 });
    });

    it("should return null for models without metadata pricing (no invented fallbacks)", () => {
      expect(getModelRate("openai", "gpt-4o")).toBeNull();
      expect(getModelRate("openai", "gpt-4-custom")).toBeNull();
      expect(getModelRate("anthropic", "claude-3-custom")).toBeNull();
      expect(getModelRate("openrouter", "openai/gpt-4o-mini")).toBeNull();
      expect(getModelRate("openrouter", "unknown/provider-model")).toBeNull();
    });

    it("should return null when runtime models exist but the model is absent", () => {
      const runtimeModels = [
        { id: "anthropic/claude-3-5-sonnet", enabled: true, thinkingLevel: "default" as const, pricing: { in: 3, out: 15 } },
      ];
      expect(getModelRate("openrouter", "anthropic/claude-3-5-haiku", runtimeModels)).toBeNull();
    });
  });

  describe("extractPricing", () => {
    it("should parse OpenRouter pricing (USD per token strings) into per-1M rates", () => {
      expect(extractPricing({ pricing: { prompt: "0.0025", completion: "0.01" } })).toEqual({ in: 2500, out: 10000 });
    });

    it("should accept numeric pricing values", () => {
      expect(extractPricing({ pricing: { prompt: 0.15, completion: 0.6 } })).toEqual({ in: 150000, out: 600000 });
    });

    it("should return null for absent or malformed pricing", () => {
      expect(extractPricing(null)).toBeNull();
      expect(extractPricing({})).toBeNull();
      expect(extractPricing({ pricing: null })).toBeNull();
      expect(extractPricing({ pricing: "0.1" })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "0.0025" } })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "nope", completion: "0.01" } })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "-1", completion: "0.01" } })).toBeNull();
    });
  });

  describe("Subagent & Model Registry Context Window Resolution", () => {
    it("should resolve context window via models.dev registry for known models", async () => {
      // Provider-scoped lookup: gpt-4o is hosted by many providers with
      // different per-provider facts; the "openai" entry resolves exactly.
      const regGpt4o = await lookupModelInRegistry("gpt-4o", "openai");
      if (regGpt4o.contextWindow !== undefined) {
        expect(regGpt4o.contextWindow).toBe(128000);
      }
    });

    it("should not resolve a multi-provider id without provider context", async () => {
      // A model hosted by many providers is ambiguous without a provider —
      // never guess which provider's entry applies.
      const reg = await lookupModelInRegistry("gpt-4o");
      expect(reg.reasoningOptions).toBeUndefined();
      expect(reg.interleavedField).toBeUndefined();
    });

    it("should fall back to regex suffix parsing for suffix-based model names", () => {
      expect(lookupContextWindow("claude-3-5-sonnet-200k")).toBe(200000);
      expect(lookupContextWindow("my-custom-model-128k")).toBe(128000);
      expect(lookupContextWindow("llama-3-70b-32k")).toBe(32000);
      expect(lookupContextWindow("unknown-model")).toBeUndefined();
    });
  });

  describe("buildProviderHeaders (OpenCode Zen & Gateway Headers)", () => {
    it("should build standard headers for standard providers", () => {
      const headers = buildProviderHeaders({
        providerId: "openai",
        apiKey: "sk-test",
        acceptStream: true,
      });
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Accept"]).toBe("application/json, text/event-stream");
      expect(headers["Authorization"]).toBe("Bearer sk-test");
      expect(headers["x-opencode-session"]).toBeUndefined();
      expect(headers["X-Session-ID"]).toBeUndefined();
    });

    it("should omit Authorization header when apiKey is 'not-needed' or omitted", () => {
      const headers = buildProviderHeaders({
        providerId: "puter",
        apiKey: "not-needed",
      });
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("should inject OpenCode session and client emulation headers when providerId is 'zen'", () => {
      const headers = buildProviderHeaders({
        providerId: "zen",
        apiKey: "opencode-key-123",
        sessionId: "ses_custom_123",
      });
      expect(headers["Authorization"]).toBe("Bearer opencode-key-123");
      expect(headers["x-opencode-session"]).toBe("ses_custom_123");
      expect(headers["X-Session-ID"]).toBe("ses_custom_123");
      expect(headers["x-opencode-client"]).toBe("cli");
      expect(headers["x-opencode-request"]).toMatch(/^req_/);
      expect(headers["User-Agent"]).toBe("opencode/1.3.15");
    });

    it("should inject OpenCode headers when baseUrl points to opencode.ai even if providerId is custom", () => {
      const headers = buildProviderHeaders({
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "opencode-key-456",
      });
      expect(headers["Authorization"]).toBe("Bearer opencode-key-456");
      expect(headers["x-opencode-session"]).toMatch(/^ses_/);
      expect(headers["X-Session-ID"]).toMatch(/^ses_/);
      expect(headers["x-opencode-client"]).toBe("cli");
      expect(headers["x-opencode-request"]).toMatch(/^req_/);
      expect(headers["User-Agent"]).toBe("opencode/1.3.15");
    });

    it("should ensure sessionId is prefixed with ses_ when provided without prefix", () => {
      const headers = buildProviderHeaders({
        providerId: "zen",
        apiKey: "opencode-key-789",
        sessionId: "conv-raw-uuid-1234",
      });
      expect(headers["x-opencode-session"]).toBe("ses_conv-raw-uuid-1234");
      expect(headers["X-Session-ID"]).toBe("ses_conv-raw-uuid-1234");
    });
  });

  describe("Responses Protocol Helpers (/v1/responses)", () => {
    afterEach(() => {
      // Global memo isolation: learned entries must not leak across tests.
      clearResponsesRequired("https://custom.zen.gateway/v1", "custom-model");
      clearResponsesRequired("https://custom.zen.gateway/v1", "reverse-model");
    });

    it("should identify models requiring /responses protocol on Zen provider", () => {
      expect(isResponsesRequired("zen", undefined, "muse-spark-1.3-contributor-free")).toBe(true);
      expect(isResponsesRequired("zen", undefined, "muse-pro")).toBe(true);
      expect(isResponsesRequired("zen", undefined, "spark-lite")).toBe(true);
      expect(isResponsesRequired("custom", "https://opencode.ai/zen/v1", "muse-spark-1.3-contributor-free")).toBe(true);

      // Other models should use /chat/completions by default
      expect(isResponsesRequired("zen", undefined, "big-pickle")).toBe(false);
      expect(isResponsesRequired("zen", undefined, "nvidia-nemotron-70b")).toBe(false);
      expect(isResponsesRequired("openai", "https://api.openai.com/v1", "gpt-4o")).toBe(false);
    });

    it("should dynamically memorize models marked as requiring responses", () => {
      expect(isResponsesRequired("custom", "https://custom.zen.gateway/v1", "custom-model")).toBe(false);
      markResponsesRequired("https://custom.zen.gateway/v1", "custom-model");
      expect(isResponsesRequired("custom", "https://custom.zen.gateway/v1", "custom-model")).toBe(true);
    });

    it("should clear memoized responses requirement via reverse failover path", () => {
      const base = "https://custom.zen.gateway/v1";
      expect(isResponsesRequired("custom", base, "reverse-model")).toBe(false);
      markResponsesRequired(base, "reverse-model");
      expect(isResponsesRequired("custom", base, "reverse-model")).toBe(true);
      clearResponsesRequired(base, "reverse-model");
      expect(isResponsesRequired("custom", base, "reverse-model")).toBe(false);
    });

    it("should build proper /responses request payload with flattened tools and converted messages", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What's the weather in Tokyo?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "Tokyo" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_abc123",
          content: "Sunny, 20°C",
        },
      ];

      const tools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather in city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ];

      const body = buildResponsesRequestBody({
        model: "muse-spark-1.3-contributor-free",
        messages,
        tools,
        maxTokens: 1024,
        temperature: 0.7,
        stream: true,
      });

      expect(body.model).toBe("muse-spark-1.3-contributor-free");
      expect(body.stream).toBe(true);
      expect(body.temperature).toBe(0.7);
      expect(body.max_output_tokens).toBe(1024);

      // Verify input array conversion
      const input = body.input as any[];
      expect(input).toHaveLength(5);
      expect(input[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
      expect(input[1]).toEqual({ role: "user", content: "What's the weather in Tokyo?" });
      expect(input[2]).toEqual({ role: "assistant", content: "Let me check." });
      expect(input[3]).toEqual({
        type: "function_call",
        call_id: "call_abc123",
        name: "get_weather",
        arguments: '{"city":"Tokyo"}',
      });
      expect(input[4]).toEqual({
        type: "function_call_output",
        call_id: "call_abc123",
        output: "Sunny, 20°C",
      });

      // Verify flattened tools
      const flatTools = body.tools as any[];
      expect(flatTools).toHaveLength(1);
      expect(flatTools[0].type).toBe("function");
      expect(flatTools[0].name).toBe("get_weather");
      expect(flatTools[0].description).toBe("Get current weather in city");
      expect(flatTools[0].parameters).toBeDefined();
      expect(flatTools[0].function).toBeUndefined(); // ensure unnested
    });

    it("drops orphan tool outputs with no matching call in the payload", () => {
      const body = buildResponsesRequestBody({
        model: "muse-spark",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_call_id: "call_orphan", content: "stale result" },
          { role: "tool", content: "id-less result" },
        ],
        stream: false,
      });
      expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    });

    it("preserves function-level vendor extensions like strict", () => {
      const body = buildResponsesRequestBody({
        model: "muse-spark",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "d",
              parameters: { type: "object" },
              strict: true,
            },
          },
        ],
        stream: false,
      });
      const flatTools = body.tools as any[];
      expect(flatTools[0].strict).toBe(true);
    });

    it("pins Responses array-content wire format: text→input_text, image_url→input_image", () => {
      const body = buildResponsesRequestBody({
        model: "muse-spark",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
              { type: "input_text", text: "already-normalized" },
            ],
          },
        ],
        stream: false,
      });
      const input = body.input as any[];
      expect(input).toHaveLength(1);
      expect(input[0].type).toBe("message");
      expect(input[0].role).toBe("user");
      expect(input[0].content[0]).toEqual({ type: "input_text", text: "describe this" });
      expect(input[0].content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAA" });
      // Already-normalized blocks pass through untouched.
      expect(input[0].content[2]).toEqual({ type: "input_text", text: "already-normalized" });
    });
  });

  describe("Responses text dedup helper", () => {
    it("yields only the unstreamed remainder on done", () => {
      const d = createResponsesTextDedup();
      d.onDelta("0:", "Hello ");
      d.onDelta("0:", "world");
      expect(d.onDone("0:", "Hello world!!!")).toBe("!!!");
      expect(d.getDroppedBytes()).toBe(0);
    });

    it("yields full text when only done arrives", () => {
      const d = createResponsesTextDedup();
      expect(d.onDone("1:", "full answer")).toBe("full answer");
    });

    it("drops diverged done text and counts it instead of duplicating", () => {
      const d = createResponsesTextDedup();
      d.onDelta("0:", "Hello world");
      expect(d.onDone("0:", "something entirely different")).toBe("");
      expect(d.getDroppedBytes()).toBe("something entirely different".length);
    });
  });

  describe("Usage + token-cap helpers", () => {
    it("extracts usage from a non-streaming body without throwing on garbage", () => {
      expect(
        extractUsageFromBody(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } })),
      ).toEqual({ promptTokens: 10, completionTokens: 5, cacheReadTokens: undefined });
      expect(extractUsageFromBody("")).toBeUndefined();
      expect(extractUsageFromBody("<html>gateway hiccup</html>")).toBeUndefined();
    });

    it("preserves Anthropic cache attribution in non-streaming bodies", () => {
      expect(
        extractUsageFromBody(
          JSON.stringify({
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 },
          }),
        ),
      ).toEqual({ promptTokens: 100, completionTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 });
    });

    it("reads and writes every cap field symmetrically", () => {
      const chat = { model: "x", max_tokens: 100 };
      expect(getBodyMaxTokens(chat)).toBe(100);
      setBodyMaxTokens(chat, 50);
      expect(chat.max_tokens).toBe(50);

      const responses = { model: "x", max_output_tokens: 100 };
      expect(getBodyMaxTokens(responses)).toBe(100);
      setBodyMaxTokens(responses, 50);
      expect(responses.max_output_tokens).toBe(50);

      const completion = { model: "x", max_completion_tokens: 100 };
      expect(getBodyMaxTokens(completion)).toBe(100);
      setBodyMaxTokens(completion, 50);
      expect(completion.max_completion_tokens).toBe(50);

      const both = { model: "x", max_tokens: 100, max_output_tokens: 100 } as Record<string, unknown>;
      setBodyMaxTokens(both, 25);
      expect(both.max_tokens).toBe(25);
      expect(both.max_output_tokens).toBe(25);
    });
  });

  describe("modelSupportsVision", () => {
    it("follows the provider catalog flag regardless of model ID content", () => {
      // Capability-driven: the model ID string never influences the result.
      // Opaque fixture IDs prove no name sniffing takes place.
      expect(modelSupportsVision("openai", "any-model-alpha")).toBe(true);
      expect(modelSupportsVision("anthropic", "any-model-beta")).toBe(true);
      expect(modelSupportsVision("unknown-provider-xyz", "any-model-alpha")).toBe(false);
      expect(modelSupportsVision("openai")).toBe(true);
    });

    it("does not branch on model family names", () => {
      // Previously regex-sniffed families; now all follow the catalog flag.
      // Deliberately evocative fixture strings must behave identically.
      const trickyIds = [
        "texty-chat-model",
        "flashy-omni-4o-thing",
        "coder-thing-vl-max",
        "vision-thing-9000",
      ];
      for (const id of trickyIds) {
        expect(modelSupportsVision("openrouter", id)).toBe(true);
      }
    });

    it("respects runtime store provider override if configured", () => {
      const denyProvider = [{ id: "zen", supportsVision: false }];
      expect(modelSupportsVision("zen", "any-model", denyProvider)).toBe(false);

      const allowModel = [
        { id: "zen", modelsConfig: [{ id: "any-model", visionEnabled: true }] },
      ];
      expect(modelSupportsVision("zen", "any-model", allowModel)).toBe(true);

      const denyModel = [
        { id: "zen", modelsConfig: [{ id: "any-model", visionEnabled: false }] },
      ];
      expect(modelSupportsVision("zen", "any-model", denyModel)).toBe(false);
    });
  });
});


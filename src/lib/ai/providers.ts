import type { ProviderInfo, ProviderId } from "@/lib/types";
import type { ModelRate } from "@/lib/provider-models";
import type { ReasoningSchemeId } from "@/lib/reasoning";

export const DEFAULT_PROVIDER = "puter";
export const DEFAULT_MODEL = "auto";
export const DEFAULT_FALLBACK_MODEL = "claude-3-5-sonnet";
export const DEFAULT_OPENAI_FALLBACK_MODEL = "gpt-4o";

/**
 * Static registry of AI providers annotated with capability flags:
 * native function calling, reasoning parameter scheme, vision support, and pricing defaults.
 */
type ProviderInfoWithFlags = ProviderInfo & {
  supportsNativeFunctionCalling?: boolean;
  reasoningScheme?: ReasoningSchemeId;
  supportsVision?: boolean;
  /**
   * Provider-level billing rate (USD per 1M tokens) for providers with a
   * uniform, documented cost model. Per-model rates are preferred and are
   * captured at runtime from provider `/models` metadata when available.
   */
  pricing?: ModelRate;
};

export const PROVIDERS: Record<ProviderId, ProviderInfoWithFlags> = {
  puter: {
    id: "puter",
    name: "Puter",
    description:
      "Puter: 400+ models (OpenAI, Claude, Gemini, Grok, etc.) via a single OpenAI-compatible endpoint. Paste your auth token from puter.com/dashboard → Account → Create token.",
    baseUrl: "https://api.puter.com/puterai/openai/v1/",
    docsUrl: "https://developer.puter.com",
    free: true,
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "openai_effort",
    supportsVision: true,
    // Puter's user-pays model: users authenticate via Puter.js and cover
    // their own AI usage costs — the app is never billed.
    pricing: { in: 0, out: 0 },
    models: [], // Models are fetched live from Puter's API after auth
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    description: "Bring your own OpenRouter key. Access 300+ models through one API.",
    docsUrl: "https://openrouter.ai/docs",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "openrouter_reasoning",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    description: "Bring your own OpenAI API key.",
    docsUrl: "https://platform.openai.com/docs",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "openai_effort",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    description: "Bring your own Anthropic API key.",
    docsUrl: "https://docs.anthropic.com",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "anthropic_thinking",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  groq: {
    id: "groq",
    name: "Groq",
    description: "Ultra-fast inference. Bring your own Groq key.",
    docsUrl: "https://console.groq.com/docs",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "groq_effort",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    description: "Bring your own NVIDIA NIM API key. OpenAI-compatible endpoints for open models.",
    docsUrl: "https://docs.api.nvidia.com",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "custom_effort", // Same path as the verified `custom` endpoint — never guess
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    description: "Bring your own Mistral API key.",
    docsUrl: "https://docs.mistral.ai",
    baseUrl: "https://api.mistral.ai/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "none",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  together: {
    id: "together",
    name: "Together AI",
    description: "Bring your own Together AI key for open-model inference.",
    docsUrl: "https://docs.together.ai",
    baseUrl: "https://api.together.xyz/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "none",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    description: "Bring your own Gemini API key from Google AI Studio.",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "gemini_effort",
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  zen: {
    id: "zen",
    name: "OpenCode Zen",
    description: "OpenCode Zen API gateway. OpenAI-compatible endpoint; models are fetched live after saving a key.",
    docsUrl: "https://dev.opencode.ai/docs/zen/",
    baseUrl: "https://opencode.ai/zen/v1",
    requiresKey: true,
    supportsNativeFunctionCalling: true,
    reasoningScheme: "custom_effort", // Same path as the verified `custom` endpoint — never guess
    supportsVision: true,
    models: [], // Models are fetched live from the provider after the user saves their API key
  },
  custom: {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    description: "Any OpenAI-compatible endpoint with a custom base URL.",
    requiresKey: true,
    baseUrl: "", // User provides via SaveKeyRequest
    supportsNativeFunctionCalling: true,
    reasoningScheme: "custom_effort",
    supportsVision: true,
    models: [],
  },
};

export function listProviders(): ProviderInfoWithFlags[] {
  return Object.values(PROVIDERS);
}

export function getProvider(
  id: ProviderId,
): ProviderInfoWithFlags | undefined {
  if (PROVIDERS[id as ProviderId]) {
    return PROVIDERS[id as ProviderId];
  }
  if (typeof id === "string" && id.startsWith("custom")) {
    const label = id.includes(":") ? id.split(":")[1] : "Custom OpenAI-compatible";
    return {
      id: id as ProviderId,
      name: label,
      description: "Custom OpenAI-compatible endpoint",
      requiresKey: true,
      baseUrl: "",
      supportsNativeFunctionCalling: true,
      reasoningScheme: "custom_effort",
      supportsVision: true,
      models: [],
    };
  }
  return undefined;
}

/**
 * Process-lifetime cache of gateway hosts discovered to REQUIRE the
 * `reasoning_content` echo — the rule DeepSeek's thinking-mode API
 * enforces for tool-call turns (see
 * https://api-docs.deepseek.com/guides/thinking_mode/).
 *
 * Populated behaviorally, with NO provider-specific knowledge: when a chat
 * request is rejected with a client error (4xx) while the conversation
 * history contains assistant thinking text, the caller retries once with
 * the echo enabled; if that retry succeeds, the host is remembered here so
 * subsequent requests never fail. Learned from the provider itself.
 */
const reasoningEchoRequiredHosts = new Set<string>();

/**
 * Remember that the gateway at `baseUrl` accepts (and in practice
 * requires) `reasoning_content` on assistant messages. Only called after
 * a retry-with-echo SUCCEEDED, so hosts that forbid the field (e.g. the
 * legacy deepseek-reasoner model, whose docs forbid input
 * `reasoning_content`) are never marked.
 */
export function rememberReasoningEchoRequired(baseUrl: string): void {
  try {
    reasoningEchoRequiredHosts.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    /* ignore unparseable URLs */
  }
}

/**
 * Whether the provider's API requires the model's `reasoning_content`
 * (thinking text) to be echoed back verbatim as the `reasoning_content`
 * field on assistant messages in subsequent requests.
 *
 * Detection is fully behavioral — the provider itself proves the
 * requirement by rejecting echo-less requests and accepting the retry
 * with the echo (see {@link rememberReasoningEchoRequired}). Nothing is
 * inferred from provider ids, endpoint URLs, or model names.
 */
export function requiresReasoningEcho(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return reasoningEchoRequiredHosts.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    /* unparseable URL — no known requirement */
  }
  return false;
}

/**
 * Resolve the `"auto"` model sentinel to a concrete model ID for the given
 * provider. Falls back to the first non-`"auto"` model in the provider's
 * model list, or the raw model string if nothing is defined.
 */
export function resolveModel(provider: ProviderId, model: string): string {
  if (model !== "auto") return model;
  const info = PROVIDERS[provider];
  if (info?.models?.length) {
    const concrete = info.models.find((m) => m.id !== "auto");
    if (concrete?.id) return concrete.id;
  }
  // No static catalog available — "auto" cannot be resolved here.
  // The caller (executor) must handle this by looking up the user's
  // saved key models or emitting an error.
  return "auto";
}

export function modelSupportsVision(
  providerId: string,
  _modelId?: string,
  storeProviders?: any[],
): boolean {
  // Check static PROVIDERS catalog first
  const staticProvider = PROVIDERS[providerId as ProviderId];
  if (staticProvider?.supportsVision === false) return false;

  // Check runtime provider models from store (user-saved config may override)
  if (storeProviders && Array.isArray(storeProviders)) {
    const runtime = storeProviders.find((p: any) => p.id === providerId || p.provider === providerId);
    if (runtime?.supportsVision === false) return false;
    // Check per-model config for explicit vision toggle
    if (_modelId && runtime?.modelsConfig && Array.isArray(runtime.modelsConfig)) {
      const modelCfg = runtime.modelsConfig.find((m: any) => m.id === _modelId);
      if (modelCfg?.visionEnabled === false) return false;
      if (modelCfg?.visionEnabled === true) return true;
    }
  }

  // Default to the provider-level flag (undefined → false for vision,
  // because sending image blocks to non-vision models can cause API errors).
  return staticProvider?.supportsVision === true;
}

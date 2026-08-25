/**
 * Shared provider request payload building, parameter mapping, and SSE chunk parsing.
 * Used by executor.ts and subagent-executor.ts to ensure identical, official handling across
 * all models and providers without duplication or code drift.
 */

import { getProvider } from "./providers";
import type { ProviderId } from "@/lib/types";

// Fallback max_tokens only where a provider API REQUIRES the field.
// OpenAI-compatible providers (openai, openrouter, groq, …) treat
// `max_tokens` as optional and apply their own documented server-side
// default when omitted — so unknown models simply omit it. Anthropic's
// Messages API requires `max_tokens`; the official @anthropic-ai/sdk
// defaults it to 4096 when omitted, and both executors apply that
// documented SDK default here.
export const ANTHROPIC_SDK_DEFAULT_MAX_TOKENS = 4096;

export interface ConfigureRequestBodyOptions {
  providerId?: string;
  model: string;
  body: Record<string, any>;
  reasoningParams?: Record<string, any>;
  /**
   * Per-model provider-specific extras. Sourced from live per-model
   * metadata via `caps.extraBody`; never derived from model ids or names.
   */
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  tools?: any[];
}

/**
 * Configure request body parameters (max_tokens, reasoning params, tools)
 * adhering strictly to official provider API specifications.
 */
export function configureRequestBody({
  providerId,
  model,
  body,
  reasoningParams,
  extraBody,
  maxTokens,
  tools,
}: ConfigureRequestBodyOptions): void {
  if (maxTokens !== undefined && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  if (reasoningParams && Object.keys(reasoningParams).length > 0) {
    Object.assign(body, reasoningParams);
  }

  if (extraBody && Object.keys(extraBody).length > 0) {
    // Per-model provider-specific extras. Sourced from live per-model
    // metadata; never hardcoded. Deep-merge one level so providers that
    // nest their extras compose safely with parallel calls and don't clobber each other.
    for (const [key, value] of Object.entries(extraBody)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        body[key] && typeof body[key] === "object" && !Array.isArray(body[key])
      ) {
        Object.assign(body[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        body[key] = value;
      }
    }
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
    const provider = providerId ? getProvider(providerId as ProviderId) : undefined;
    if (provider?.supportsNativeFunctionCalling === true) {
      body.tool_choice = "auto";
    }
  }
}

/**
 * Clean up reasoning parameters if a 400 Bad Request error occurs, enabling fallback retries.
 */
export function sanitizeRejectedReasoningParams(body: Record<string, any>): void {
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinkingConfig;
  delete body.thinking_config;
}

export interface ParsedSseDelta {
  reasoningDelta?: string;
  contentDelta?: string;
}

/**
 * Extract reasoning and content deltas from an OpenAI-compatible SSE chunk delta object.
 * Automatically detects reasoning_content, reasoning, thinking, reasoning_text and
 * deduplicates content matching reasoningDelta (the duplicate content is dropped).
 */
export function parseSseReasoningChunk(delta: any): ParsedSseDelta {
  if (!delta || typeof delta !== "object") return {};

  const rawReasoning =
    delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.reasoning_text;
  const reasoningDelta = typeof rawReasoning === "string" ? rawReasoning : undefined;

  let contentDelta = typeof delta.content === "string" ? delta.content : undefined;

  if (reasoningDelta && contentDelta && contentDelta.trim() === reasoningDelta.trim()) {
    contentDelta = undefined;
  }

  return { reasoningDelta, contentDelta };
}

// Provider usage extraction (Cline-compatible measured accounting)

export interface MeasuredUsage {
  /** Provider-measured input tokens for the request (undefined = not reported). */
  promptTokens?: number;
  /** Provider-measured completion/output tokens (undefined = not reported). */
  completionTokens?: number;
  /** Prompt tokens served from the provider cache (OpenAI cached_tokens). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the cache (Anthropic cache_creation). */
  cacheWriteTokens?: number;
}

/**
 * Extract usage from an OpenAI-compatible usage object:
 * `usage.prompt_tokens`, `usage.completion_tokens`,
 * `usage.prompt_tokens_details.cached_tokens`.
 * Returns undefined when the object carries no usable token counts.
 */
export function extractOpenAIUsage(u: any): MeasuredUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const promptTokens =
    typeof u.prompt_tokens === "number" ? u.prompt_tokens : typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const completionTokens =
    typeof u.completion_tokens === "number"
      ? u.completion_tokens
      : typeof u.output_tokens === "number"
        ? u.output_tokens
        : undefined;
  const cacheReadTokens =
    typeof u.prompt_tokens_details?.cached_tokens === "number"
      ? u.prompt_tokens_details.cached_tokens
      : typeof u.cached_tokens === "number"
        ? u.cached_tokens
        : undefined;
  if (promptTokens === undefined && completionTokens === undefined && cacheReadTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, cacheReadTokens };
}

/**
 * Extract usage from an Anthropic Messages usage object:
 * `usage.input_tokens`, `usage.output_tokens`,
 * `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
 * Returns undefined when no usable token counts are present.
 */
export function extractAnthropicUsage(u: any): MeasuredUsage | undefined {
  const promptTokens = typeof u?.input_tokens === "number" ? u.input_tokens : undefined;
  const completionTokens = typeof u?.output_tokens === "number" ? u.output_tokens : undefined;
  const cacheReadTokens = typeof u?.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
  const cacheWriteTokens =
    typeof u?.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens };
}

// `stream_options: { include_usage: true }` support learning
// Not every OpenAI-compatible gateway accepts the final measured-usage SSE
// chunk; some answer with HTTP 400. Falling back by re-issuing the whole
// request costs a full extra round-trip before ANY token is streamed, so we
// remember which gateways reject it (process-global, keyed by base URL) and
// only pay that cost once per host instead of on every message.

const streamOptionsRejectedHosts = new Set<string>();

/** Memoize a gateway that 400s on `stream_options`, so later calls skip it. */
export function markStreamOptionsRejected(baseUrl: string): void {
  if (baseUrl) streamOptionsRejectedHosts.add(baseUrl.replace(/\/$/, ""));
}

/** Whether the gateway is known to reject `stream_options` (skip it entirely). */
export function isStreamOptionsRejected(baseUrl: string): boolean {
  if (!baseUrl) return true;
  return streamOptionsRejectedHosts.has(baseUrl.replace(/\/$/, ""));
}

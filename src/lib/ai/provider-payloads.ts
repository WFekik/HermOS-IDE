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

/**
 * Last-resort output cap used when a request body carries no token limit
 * field at all (unknown shape). Not a provider default — every known shape
 * is read via getBodyMaxTokens first.
 */
export const FALLBACK_OUTPUT_TOKEN_CAP = 4096;

/** Output budget for one-shot conversation-title generations. */
export const TITLE_MAX_OUTPUT_TOKENS = 20;

/** Minimal output budget for provider connectivity probes ("ping" prompts). */
export const PROVIDER_PING_MAX_OUTPUT_TOKENS = 4;

/** Output budget for one-shot inline-edit generations. */
export const INLINE_EDIT_MAX_OUTPUT_TOKENS = 4096;

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

/**
 * Deduplicates Responses-protocol `*.done` frames against already-streamed
 * `*.delta` text. Some gateways emit a trailing `*.done` frame carrying the
 * full item text after streaming it piecewise via `*.delta`; yielding it
 * verbatim would duplicate prose. `onDelta` records streamed text per item
 * key; `onDone` returns only the unstreamed remainder ("" = nothing new).
 */
export interface ResponsesTextDedup {
  onDelta(key: string, delta: string): void;
  onDone(key: string, fullText: string): string;
  /** Bytes silently dropped as diverged duplicates (observability for tests/logs). */
  getDroppedBytes(): number;
}

export function createResponsesTextDedup(): ResponsesTextDedup {
  const streamedByKey = new Map<string, string>();
  let droppedBytes = 0;
  return {
    onDelta(key: string, delta: string): void {
      streamedByKey.set(key, (streamedByKey.get(key) ?? "") + delta);
    },
    onDone(key: string, fullText: string): string {
      if (!fullText) return "";
      const streamed = streamedByKey.get(key) ?? "";
      if (streamed && fullText.startsWith(streamed)) {
        const remainder = fullText.slice(streamed.length);
        if (remainder) streamedByKey.set(key, fullText);
        return remainder;
      }
      if (!streamed) {
        streamedByKey.set(key, fullText);
        return fullText;
      }
      // Diverged from streamed text (e.g. whitespace normalization or prefix
      // re-emission by a non-conformant gateway). Drop rather than duplicate,
      // but count it so the loss is observable instead of invisible.
      droppedBytes += fullText.length;
      return "";
    },
    getDroppedBytes(): number {
      return droppedBytes;
    },
  };
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
 * Extract provider usage from a non-streaming 200 body without throwing on
 * non-JSON payloads (gateway hiccups may return empty/HTML bodies).
 * Merges OpenAI-compatible and Anthropic shapes so cache attribution
 * (`cache_read_input_tokens`/`cache_creation_input_tokens`) is not dropped
 * on Anthropic native responses.
 */
export function extractUsageFromBody(fullBody: string): MeasuredUsage | undefined {
  let usage: unknown;
  try {
    usage = (JSON.parse(fullBody) as any)?.usage;
  } catch {
    return undefined;
  }
  const openai = extractOpenAIUsage(usage);
  const anthropic = extractAnthropicUsage(usage);
  if (!openai && !anthropic) return undefined;
  return {
    promptTokens: openai?.promptTokens ?? anthropic?.promptTokens,
    completionTokens: openai?.completionTokens ?? anthropic?.completionTokens,
    cacheReadTokens: openai?.cacheReadTokens ?? anthropic?.cacheReadTokens,
    cacheWriteTokens: anthropic?.cacheWriteTokens,
  };
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
const MEMO_SET_MAX = 500;

/** Evict oldest entry when a memo Set exceeds cap (parity with toolsRejectedCache). */
function capMemoSet(set: Set<string>): void {
  if (set.size >= MEMO_SET_MAX) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

/** Memoize a gateway that 400s on `stream_options`, so later calls skip it. */
export function markStreamOptionsRejected(baseUrl: string): void {
  if (baseUrl) {
    capMemoSet(streamOptionsRejectedHosts);
    streamOptionsRejectedHosts.add(baseUrl.replace(/\/$/, ""));
  }
}

/** Whether the gateway is known to reject `stream_options` (skip it entirely). */
export function isStreamOptionsRejected(baseUrl: string): boolean {
  if (!baseUrl) return true;
  return streamOptionsRejectedHosts.has(baseUrl.replace(/\/$/, ""));
}

export interface BuildProviderHeadersOptions {
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  sessionId?: string;
  acceptStream?: boolean;
  /**
   * Include `Content-Type: application/json`. Defaults to true for POST bodies.
   * Set to false for body-less GETs (e.g. `/models`) where it is unnecessary.
   */
  includeContentType?: boolean;
}

// Client-emulation User-Agent sent to OpenCode Zen gateways.
// Keep in sync with the minimum CLI version the gateway accepts.
export const OPENCODE_EMULATION_USER_AGENT = "opencode/1.3.15";

/** crypto.randomUUID with fallback for non-secure contexts (http, older browsers). */
export function safeRandomUUID(): string {
  try {
    const fn = (globalThis as any)?.crypto?.randomUUID;
    if (typeof fn === "function") return fn.call((globalThis as any).crypto);
  } catch {
    /* fall through to Math.random fallback */
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** True for OpenCode Zen (`zen` provider or `*.opencode.ai` gateway hostname). */
export function isZenProvider(providerId?: string, baseUrl?: string): boolean {
  if (providerId === "zen") return true;
  if (typeof baseUrl === "string" && baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (host === "opencode.ai" || host.endsWith(".opencode.ai")) return true;
      return false;
    } catch {
      // Non-absolute baseUrl (relative/path-only) — fall back to substring.
      return baseUrl.includes("opencode.ai");
    }
  }
  return false;
}

/** Trim trailing slashes for stable URL concatenation. */
export function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || "").replace(/\/+$/, "");
}

/** Stable memo key for responses-required learning (slash-insensitive, case-insensitive model). */
export function normalizeResponsesKey(baseUrl?: string, model?: string): string {
  return `${normalizeBaseUrl(baseUrl)}:${(model || "").toLowerCase()}`;
}

/**
 * Derive canonical `/chat/completions` + `/responses` URLs from any configured baseUrl.
 * Handles baseUrls that already end in `/chat/completions` or `/responses`,
 * trailing slashes, or bare host roots — without producing doubled segments or `//`.
 * baseUrl must be the API root (e.g. `.../v1`); suffixed values are normalized.
 * Returns empty strings when baseUrl is empty so callers fail closed via SSRF check.
 */
export function resolveProviderUrls(baseUrl: string): { completionsUrl: string; responsesUrl: string } {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (!trimmed) return { completionsUrl: "", responsesUrl: "" };
  const root = trimmed.replace(/\/(chat\/completions|responses)$/, "");
  return {
    completionsUrl: `${root}/chat/completions`,
    responsesUrl: `${root}/responses`,
  };
}

/** Canonical `/models` URL without `//models` on trailing-slash baseUrls. */
export function resolveModelsUrl(baseUrl: string): string {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (!trimmed) return "";
  // Strip protocol suffixes like resolveProviderUrls so a baseUrl configured
  // as `.../chat/completions` or `.../responses` does not yield `.../models` 404s.
  const root = trimmed.replace(/\/(chat\/completions|responses)$/, "");
  return `${root}/models`;
}

/**
 * Builds standard HTTP headers for AI provider requests.
 * Automatically injects required session affinity and client emulation headers
 * for OpenCode Zen (`zen` provider or `opencode.ai` gateways) to ensure
 * compatibility and bypass the MissingSessionID validation.
 *
 * Session affinity: main chat passes `conversation.id`, subagents pass their
 * `sessionId`. One-shots (title, inline-edit, summarize) pass a stable derived
 * id (conversation or per-user) to avoid per-request session proliferation.
 * Omitting `sessionId` mints a random ephemeral session — intentional only for
 * stateless probes like `testProvider` / `GET /models`.
 */
export function buildProviderHeaders({
  providerId,
  baseUrl,
  apiKey,
  sessionId,
  acceptStream = true,
  includeContentType = true,
}: BuildProviderHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: acceptStream ? "application/json, text/event-stream" : "application/json",
  };
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }

  if (apiKey && apiKey !== "not-needed") {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const isZen = isZenProvider(providerId, baseUrl);

  if (isZen) {
    const sId = sessionId
      ? (sessionId.startsWith("ses_") ? sessionId : `ses_${sessionId}`)
      : `ses_${safeRandomUUID()}`;
    headers["x-opencode-session"] = sId;
    headers["X-Session-ID"] = sId;
    headers["x-opencode-client"] = "cli";
    headers["x-opencode-request"] = `req_${safeRandomUUID()}`;
    // Client-emulation string expected by the Zen gateway.
    // Bump OPENCODE_EMULATION_USER_AGENT when the gateway raises its minimum
    // supported CLI version.
    headers["User-Agent"] = OPENCODE_EMULATION_USER_AGENT;
  }

  return headers;
}

/** Mint a fresh `x-opencode-request` id for each HTTP retry (Zen observability). */
export function refreshRequestId(headers: Record<string, string>): Record<string, string> {
  if ("x-opencode-request" in headers) {
    headers["x-opencode-request"] = `req_${safeRandomUUID()}`;
  }
  return headers;
}

/** Read the active output-token cap regardless of protocol shape. */
export function getBodyMaxTokens(body: Record<string, unknown>): number | undefined {
  const b = body as Record<string, any>;
  const v = b.max_tokens ?? b.max_output_tokens ?? b.max_completion_tokens;
  return typeof v === "number" ? v : undefined;
}

/** Write the capped output-token limit to whichever field(s) the active body uses. */
export function setBodyMaxTokens(body: Record<string, unknown>, capped: number): void {
  // Update every present cap field so a body carrying two never keeps a stale one.
  const b = body as Record<string, any>;
  let wrote = false;
  for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const) {
    if (key in body) {
      b[key] = capped;
      wrote = true;
    }
  }
  if (!wrote) b.max_tokens = capped;
}

// OpenCode Zen /responses protocol support
// OpenCode Zen serves certain models (such as Muse Spark) via the Realtime/Responses protocol
// at `/v1/responses` rather than `/v1/chat/completions`. Gateways and models that require
// `/responses` are detected upfront and dynamically memorized to avoid unnecessary roundtrips.

// Word-boundary match for Zen Responses families. Prevents `music-*`/`amuse-*`
// false positives that a bare `includes("muse")` would force onto /responses.
const RESPONSES_MODEL_PATTERN = /(?:^|[^a-z0-9])(muse|spark)(?:[^a-z0-9]|$)/i;

const responsesRequiredGateways = new Set<string>();

/** Check if a provider/baseUrl/model requires the /responses protocol instead of /chat/completions */
export function isResponsesRequired(providerId?: string, baseUrl?: string, model?: string): boolean {
  if (!model) return false;
  const isZen = isZenProvider(providerId, baseUrl);
  // Word-boundary match on Zen families (muse/spark) to avoid over-matching
  // e.g. `music-*`, `amuse-*`. Learned memoization below covers future families.
  // If this still over-matches, symmetric reverse failover (responses 4xx/5xx -> chat) recovers.
  if (isZen && RESPONSES_MODEL_PATTERN.test(model)) {
    return true;
  }
  return responsesRequiredGateways.has(normalizeResponsesKey(baseUrl, model));
}

/** Dynamically memoize a model on a baseUrl that requires the /responses endpoint */
export function markResponsesRequired(baseUrl?: string, model?: string): void {
  if (model) {
    capMemoSet(responsesRequiredGateways);
    responsesRequiredGateways.add(normalizeResponsesKey(baseUrl, model));
  }
}

/** Clear a memoized responses-required entry (e.g. /responses 404/405 proved chat is correct). */
export function clearResponsesRequired(baseUrl?: string, model?: string): void {
  if (model) {
    responsesRequiredGateways.delete(normalizeResponsesKey(baseUrl, model));
  }
}

/** Statuses where a Zen endpoint mismatch should trigger protocol failover (either direction).
 * 500 is excluded: a transient outage must not trigger a second billed request
 * on the alternate protocol or mask the real error. Failover is for wrong-protocol
 * signals (400/404/405/422), applied symmetrically both directions.
 */
export const ZEN_PROTOCOL_FAILOVER_STATUSES = new Set([400, 404, 405, 422]);

export interface BuildResponsesRequestBodyOptions {
  model: string;
  messages: any[];
  tools?: any[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  providerId?: string;
  reasoningParams?: Record<string, any>;
  /**
   * Per-model provider-specific extras. Sourced from live per-model
   * metadata via `caps.extraBody`; never derived from model ids or names.
   */
  extraBody?: Record<string, unknown>;
}

/**
 * Builds the request body for the /responses protocol:
 * - Transforms messages array into the Responses input format:
 *   - role: "tool" -> type: "function_call_output", call_id, output
 *   - role: "assistant" with tool_calls -> assistant message + type: "function_call"
 *   - other messages -> preserved as { role, content }
 * - Flattens OpenAI tools array from { type: "function", function: { name, ... } }
 *   to { type: "function", name, description, parameters } at the root.
 * - Maps maxTokens to max_output_tokens.
 */
export function buildResponsesRequestBody({
  model,
  messages,
  tools,
  maxTokens,
  temperature,
  stream = true,
  providerId,
  reasoningParams,
  extraBody,
}: BuildResponsesRequestBodyOptions): Record<string, unknown> {
  const input: any[] = [];

  // Valid function_call ids emitted by assistant turns in this payload.
  // Tool outputs that link to nothing in the payload are dropped (mirrors the
  // chat path, which filters orphan `tool` messages) instead of minting an
  // unlinked random call_id that the Responses API would reject with 400.
  const validCallIds = new Set<string>();
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const id = tc?.id ?? tc?.call_id;
        if (typeof id === "string" && id) validCallIds.add(id);
      }
    }
  }

  for (const m of messages) {
    if (!m) continue;
    if (m.role === "tool") {
      const outId = m.tool_call_id ?? m.id;
      if (typeof outId !== "string" || !outId || !validCallIds.has(outId)) continue;
      input.push({
        type: "function_call_output",
        call_id: outId,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (m.content) {
        input.push({ role: "assistant", content: m.content });
      }
      for (const tc of m.tool_calls) {
        const fnName = tc.function?.name ?? tc.name;
        const fnArgs =
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : typeof tc.arguments === "string"
              ? tc.arguments
              : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {});
        input.push({
          type: "function_call",
          call_id: tc.id || tc.call_id || `call_${safeRandomUUID()}`,
          name: fnName,
          arguments: fnArgs,
        });
      }
    } else {
      if (Array.isArray(m.content)) {
        type ContentBlock = { type?: unknown; text?: unknown; image_url?: unknown };
        const blocks = (m.content as unknown[]).map((b: unknown) => {
          if (b && typeof b === "object") {
            const blk = b as ContentBlock;
            if (blk.type === "text") {
              return {
                type: "input_text",
                text: typeof blk.text === "string" ? blk.text : "",
              };
            }
            if (blk.type === "image_url") {
              const url =
                blk.image_url && typeof blk.image_url === "object"
                  ? String((blk.image_url as Record<string, unknown>).url || "")
                  : "";
              return { type: "input_image", image_url: url };
            }
            return blk;
          }
          // Non-object blocks would 400 upstream if passed through raw —
          // normalize to text instead. Wire format for valid inputs unchanged
          // (pinned by providers.test.ts: string messages stay {role, content}).
          return { type: "input_text", text: String(b ?? "") };
        });
        input.push({
          type: "message",
          role: m.role,
          content: blocks,
        });
      } else {
        input.push({
          role: m.role,
          content: m.content,
        });
      }
    }
  }

  const body: Record<string, unknown> = {
    model,
    input,
    stream,
  };

  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (maxTokens !== undefined && maxTokens > 0) {
    body.max_output_tokens = maxTokens;
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => {
      if (t.function) {
        const { function: fn, ...rest } = t as Record<string, any>;
        const { name, description, parameters, ...fnExtras } = (fn ?? {}) as Record<string, any>;
        return {
          type: "function",
          name,
          description,
          parameters,
          // Preserve vendor extensions at both levels: top-level (e.g. future
          // fields) and function-level (e.g. `strict:true`).
          ...fnExtras,
          ...rest,
        };
      }
      return t;
    });
    // Parity with the chat path: configureRequestBody sets tool_choice="auto"
    // for native function-calling providers. The Responses API honors the
    // same field, so preserve automatic tool use instead of silently dropping it.
    {
      const provider = providerId ? getProvider(providerId as ProviderId) : undefined;
      if (provider?.supportsNativeFunctionCalling === true) {
        (body as Record<string, unknown>).tool_choice = "auto";
      }
    }
  }

  // Parity with the chat path: reasoning/thinking levels and per-model
  // extraBody must not be silently dropped on /responses. Merge the same way
  // configureRequestBody does (one-level deep merge for nested extras).
  if (reasoningParams && Object.keys(reasoningParams).length > 0) {
    Object.assign(body, reasoningParams);
  }
  if (extraBody && Object.keys(extraBody).length > 0) {
    for (const [key, value] of Object.entries(extraBody)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        (body as Record<string, any>)[key] && typeof (body as Record<string, any>)[key] === "object" &&
        !Array.isArray((body as Record<string, any>)[key])
      ) {
        Object.assign((body as Record<string, any>)[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        (body as Record<string, any>)[key] = value;
      }
    }
  }

  return body;
}

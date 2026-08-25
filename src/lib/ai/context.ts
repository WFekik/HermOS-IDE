/**
 * Two-stage context window management for the agent loop:
 * Prunes older tool outputs past the protection window, then applies LLM compaction if needed.
 */

export interface ContextConfig {
  /** Protection window for recent tool outputs (in estimated tokens). @default 40_000 */
  pruneProtectTokens: number;
  /** Extra reserve buffer beyond maxOutputTokens subtracted from the context window. @default 20_000 */
  compactionBuffer: number;
  /** Cap the reserved output headroom so high-output models don't starve the input budget. @default 32_000 */
  outputTokenCap: number;
  /** Number of recent conversation turns (user+assistant pairs) to ALWAYS preserve. @default 2 */
  tailTurns: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  pruneProtectTokens: 40_000,
  compactionBuffer: 20_000,
  outputTokenCap: 32_000,
  tailTurns: 2,
};

// OpenCode-compatible constants (kept as named exports for backward compat)

/** @deprecated Use `config.compactionBuffer` from a `ContextConfig` object instead. */
export const COMPACTION_BUFFER = DEFAULT_CONTEXT_CONFIG.compactionBuffer;

/**
 * Placeholder text that replaces cleared tool output content.
 * The tool call metadata (name, args, call_id) is always preserved on the assistant turn.
 */
export const TOOL_OUTPUT_CLEARED = "[Old tool result content cleared — re-run tool if needed]";

// Effective input budget: derived from provider input limits or context window ratio.

/** Fraction of the context window treated as usable input when no input limit is declared. */
export const CONTEXT_WINDOW_INPUT_RATIO = 0.9;
/** Auto-compact fires when measured input reaches this fraction of the effective budget. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
/** Auto-compact targets this fraction of the effective budget after the cut. */
export const DEFAULT_TARGET_RATIO = 0.7;
/**
 * Minimum input tokens preserved verbatim after auto-compact (legacy floor;
 * prefer `resolvePreserveRecentBudget`).
 * @deprecated Use `resolvePreserveRecentBudget(usableBudget)` instead — the
 *             modern budget is clamped to [MIN_PRESERVE_RECENT_TOKENS,
 *             MAX_PRESERVE_RECENT_TOKENS] like opencode's `preserve_recent_tokens`.
 */
export const DEFAULT_PRESERVE_RECENT_TOKENS = 8_000;

/** OpenCode-compatible clamp for the verbatim recent tail (MIN side). */
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;
/** OpenCode-compatible clamp for the verbatim recent tail (MAX side). */
export const MAX_PRESERVE_RECENT_TOKENS = 8_000;

/** Resolves preserve-recent budget (25% of usable budget clamped between 2,000 and 8,000 tokens). */
export function resolvePreserveRecentBudget(usableBudget: number): number {
  if (!(usableBudget > 0)) return MAX_PRESERVE_RECENT_TOKENS;
  return Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.round(usableBudget * 0.25)),
  );
}

/**
 * Resolve the maximum input tokens available for a single request.
 *
 * @param spec `{ contextWindow, maxInputTokens }` — both optional; return
 *        `undefined` when neither is known (caller falls back to "usage unknown").
 */
export function resolveEffectiveMaxInputBudget(spec: {
  contextWindow?: number;
  maxInputTokens?: number;
}): number | undefined {
  const cw =
    typeof spec.contextWindow === "number" && Number.isFinite(spec.contextWindow) && spec.contextWindow > 0
      ? spec.contextWindow
      : undefined;
  const maxInput =
    typeof spec.maxInputTokens === "number" && Number.isFinite(spec.maxInputTokens) && spec.maxInputTokens > 0
      ? spec.maxInputTokens
      : undefined;
  if (maxInput !== undefined) {
    return cw === undefined ? maxInput : Math.min(maxInput, cw);
  }
  return cw === undefined ? undefined : Math.round(cw * CONTEXT_WINDOW_INPUT_RATIO);
}

export interface MessageTokenEstimateTarget {
  role?: string;
  content?: string | null;
  toolCalls?: Array<{ name?: string; arguments?: string; id?: string }> | string | null;
  thinking?: string | null;
  attachments?: Array<unknown> | string | null;
}

export interface CompactionCutMessage extends MessageTokenEstimateTarget {
  role: string;
  content: string;
}

/**
 * Accurate message token estimation accounting for multi-part payloads.
 * Measures `content`, `thinking`, `toolCalls` arguments/JSON, and `attachments`
 * to prevent token undercounting during multi-step tool execution turns.
 */
export function estimateMessageTokens(
  m: MessageTokenEstimateTarget,
  model?: string,
): number {
  if (!m) return 0;
  let tokens = estimateTokens(m.content ?? "", model);
  if (m.thinking) {
    tokens += estimateTokens(m.thinking, model);
  }
  if (m.toolCalls) {
    if (typeof m.toolCalls === "string") {
      tokens += estimateTokens(m.toolCalls, model);
    } else if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (!tc) continue;
        tokens += estimateTokens(tc.name ?? "", model) + estimateTokens(tc.arguments ?? "", model) + 8;
      }
    }
  }
  if (m.attachments) {
    if (typeof m.attachments === "string") {
      tokens += estimateTokens(m.attachments, model);
    } else {
      tokens += estimateTokens(JSON.stringify(m.attachments), model);
    }
  }
  return tokens;
}

/**
 * True when content contains a well-formed `<context_summary …>` opening tag.
 * Substring checks alone can false-positive on ordinary user/tool content.
 */
export function isCompactionMarker(content: string): boolean {
  return /<context_summary(?:\s+[^>]*)?>/i.test(content);
}

interface CompactionTurn {
  start: number;
  end: number;
}

/** Group messages into turns (user → next user), skipping compaction markers. */
function groupTurns<T extends CompactionCutMessage>(messages: T[]): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" || isCompactionMarker(m.content)) continue;
    turns.push({ start: i, end: messages.length });
  }
  for (let i = 0; i < turns.length - 1; i++) {
    turns[i].end = turns[i + 1].start;
  }
  return turns;
}

/**
 * Largest-fit split of one turn (opencode `splitTurn`): earliest index whose
 * suffix fits `budget`. Tool-role starts are skipped so tool_call/tool_result
 * pairs never straddle the cut.
 */
function splitTurn<T extends CompactionCutMessage>(
  messages: T[],
  turn: CompactionTurn,
  budget: number,
  estimate: (m: T) => number,
): number | null {
  if (budget <= 0 || turn.end - turn.start <= 1) return null;
  for (let start = turn.start + 1; start < turn.end; start++) {
    if (messages[start].role === "tool") continue;
    let size = 0;
    for (let i = start; i < turn.end; i++) size += estimate(messages[i]);
    if (size > budget) continue;
    return start;
  }
  return null;
}

/**
 * OpenCode-compatible preserved-tail planning (opencode `select()`): keeps the
 * most recent `tailTurns` whole turns while they fit `preserveTokens`,
 * splitting the boundary turn to fill the remainder. Returns the index of the
 * first message to keep verbatim, `0` when the conversation fits the budget
 * entirely (nothing to compact), or `null` when even the most recent turn
 * alone exceeds it (caller decides: compact everything).
 */
export function selectCompactionTail<T extends CompactionCutMessage>(
  messages: T[],
  preserveTokens: number,
  opts?: {
    tailTurns?: number;
    estimateMessageTokensFn?: (m: T) => number;
  },
): number | null {
  if (messages.length === 0) return null;
  const estimate = opts?.estimateMessageTokensFn ?? ((m: T) => estimateMessageTokens(m));
  const tailTurns = Math.max(1, opts?.tailTurns ?? DEFAULT_CONTEXT_CONFIG.tailTurns);
  const turns = groupTurns(messages);
  if (turns.length === 0) return null;
  const recent = turns.slice(-tailTurns);
  let total = 0;
  let tailStart: number | null = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    let size = 0;
    for (let idx = turn.start; idx < turn.end; idx++) size += estimate(messages[idx]);
    if (total + size <= preserveTokens) {
      total += size;
      tailStart = turn.start;
      continue;
    }
    const split = splitTurn(messages, turn, preserveTokens - total, estimate);
    if (split !== null) tailStart = split;
    break;
  }
  return tailStart;
}

/**
 * Find the index of the first message to keep verbatim for the given
 * preserve budget (see {@link selectCompactionTail}).
 */
export function findCompactionCutIndex<T extends CompactionCutMessage>(
  messages: T[],
  preserveRecentTokens: number,
  estimateMessageTokensFn?: (m: T) => number,
): number {
  return (
    selectCompactionTail(messages, preserveRecentTokens, {
      tailTurns: DEFAULT_CONTEXT_CONFIG.tailTurns,
      estimateMessageTokensFn,
    }) ?? 0
  );
}

export interface ContextManagementOptions {
  /** Model's total single-turn context window in tokens (Input + Output capacity). */
  contextWindow: number;
  /** Tokens already consumed by the system prompt — measured from the actual string. */
  systemTokens: number;
  /** Max output tokens the model supports in a single completion (max_tokens). */
  maxOutputTokens: number;
  /**
   * Number of trailing user+assistant turns to always keep. Defaults to DEFAULT_TAIL_TURNS (2),
   * preserving the most recent 2 exchanges so the agent has immediate context.
   */
  tailTurns?: number;
  /** Context governance overrides for retention policies. */
  contextConfig?: Partial<ContextConfig>;
  /**
   * Optional per-message token estimator (e.g. a memoized count keyed by
   * message identity). Enables O(1) re-estimation across agent iterations:
   * messages whose content is unchanged are charged the cached count instead
   * of a full BPE pass. Falls back to `estimateTokens` when omitted.
   */
  estimateToken?: (m: HistoryMessage) => number;
}

export interface HistoryMessage {
  role: string;
  content: string;
  createdAt?: Date;
}

export interface TruncatedHistory<T = HistoryMessage> {
  /** Truncated message list (system prompt NOT included — caller prepends it). */
  messages: T[];
  /** Number of messages dropped from the middle. */
  dropped: number;
  /** Estimated token count of the kept messages (NOT including system prompt). */
  keptTokens: number;
}

import { encodingForModel, getEncoding, type Tiktoken, type TiktokenModel } from "js-tiktoken";
import {
  TOOL_CALL_JSON_RE,
  TOOL_CALL_FENCE_RE,
  XML_TOOL_CALL_RE,
} from "./tool-call-parser";
import { isReadOnlyTool, isWriteTool } from "@/lib/permissions-core";

const encoderCache = new Map<string, Tiktoken>();

/**
 * The default BPE encoding to use when `estimateTokens()` is called without
 * a model argument, or when a model name does not map to any known encoder
 * (the source's own fallback). Initialization is LAZY: the first call pays
 * the BPE dictionary init cost once per process, then the encoder is cached
 * in `encoderCache` — so the first `estimateTokens()` call of the process
 * may take a moment, but every subsequent call is instant.
 *
 * Other encoders (e.g. `o200k_base` for `gpt-4o`, `cl100k_base` variants for
 * other OpenAI models) stay lazy — they're warmed on first use via the
 * encoderCache, which is the correct behavior: we don't know which models a
 * given user runs, so we shouldn't speculatively compile dictionaries for
 * models they may never call.
 */
const DEFAULT_ENCODING_NAME = "cl100k_base";

function getEncoderForModel(model?: string): Tiktoken {
  const cacheKey = model || DEFAULT_ENCODING_NAME;
  if (encoderCache.has(cacheKey)) {
    return encoderCache.get(cacheKey)!;
  }

  let encoder: Tiktoken;
  try {
    if (model) {
      encoder = encodingForModel(model as TiktokenModel);
    } else {
      encoder = getEncoding(DEFAULT_ENCODING_NAME);
    }
  } catch {
    encoder = getEncoding(DEFAULT_ENCODING_NAME);
  }

  encoderCache.set(cacheKey, encoder);
  return encoder;
}

/**
 * Token estimator powered by js-tiktoken Byte Pair Encoding (BPE).
 * Resolves exact token counts dynamically for standard BPE models.
 */
// Sized past typical message counts so a full compaction/truncation pass
// (2000+ unique content strings) stays fully cached between calls.
const TOKEN_CACHE_MAX = 5000;
const tokenCache = new Map<string, number>();

export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0;
  const cacheKey = model ? `${model}:${text}` : text;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency: the cache evicts in insertion order, so a repeated
    // hot string (system prompt, tool schemas, recurring tool outputs)
    // must be re-inserted at the tail or it gets evicted by novel strings.
    tokenCache.delete(cacheKey);
    tokenCache.set(cacheKey, cached);
    return cached;
  }

  let count = 0;
  try {
    const encoder = getEncoderForModel(model);
    count = encoder.encode(text).length;
  } catch {
    const encoder = getEncoding("cl100k_base");
    count = encoder.encode(text).length;
  }

  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
  tokenCache.set(cacheKey, count);
  return count;
}

/**
 * Check whether the current input token count overflows the usable context window.
 *
 * Formula (matches OpenCode's isOverflow / usable):
 *   usable = contextWindow - maxOutputTokens - config.compactionBuffer
 *   overflow = inputTokens > usable
 *
 * @param inputTokens   Actual input tokens for this turn (from API response or estimate).
 * @param contextWindow Model's total context window capacity.
 * @param maxOutputTokens Model's max output token limit (0 if unknown).
 * @param config        Optional context governance overrides.
 */
export function isContextOverflow(
  inputTokens: number,
  contextWindow: number,
  maxOutputTokens = 0,
  config?: Partial<ContextConfig>,
): boolean {
  if (!contextWindow) return false;
  const { compactionBuffer, outputTokenCap } = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  const reservedOutput = Math.min(maxOutputTokens, outputTokenCap);
  const usable = Math.max(0, contextWindow - reservedOutput - compactionBuffer);
  return inputTokens > usable;
}

export interface PrunableMessage {
  role: string;
  content: string;
  /** If role === "tool", the ID that links back to the assistant tool_call. */
  toolCallId?: string;
}

export interface PruneResult<T extends PrunableMessage> {
  /** History with old tool outputs replaced (same array length as input). */
  messages: T[];
  /** Estimated tokens freed by pruning. */
  tokensFreed: number;
}

/**
 * Stage 1 — Prune old tool outputs.
 *
 * Walks backward through history tracking cumulative token count.
 * Tool outputs within the last config.pruneProtectTokens are kept untouched.
 * Older tool outputs beyond that window have their content replaced with
 * TOOL_OUTPUT_CLEARED, while tool call metadata (name/args on the
 * preceding assistant turn) is preserved unchanged.
 *
 * This is a NON-DESTRUCTIVE in-memory transform — it returns new message
 * objects with content strings replaced. It does NOT delete messages from
 * storage. Only the representation sent to the model is pruned.
 *
 * Matches OpenCode: packages/opencode/src/session/compaction.ts
 *   PRUNE_PROTECT = 40_000
 */
export function pruneOldToolOutputs<T extends PrunableMessage>(
  history: T[],
  config?: Partial<ContextConfig & { contextWindow?: number }>,
  estimateToken?: (m: T) => number,
): PruneResult<T> {
  if (history.length === 0) return { messages: history, tokensFreed: 0 };

  const defaultProtect = config?.contextWindow && config.contextWindow > 0
    ? Math.max(40_000, Math.floor(config.contextWindow * 0.6))
    : DEFAULT_CONTEXT_CONFIG.pruneProtectTokens;

  const pruneProtectTokens = config?.pruneProtectTokens ?? defaultProtect;
  const tokenFor = (m: T): number => (estimateToken ? estimateToken(m) : estimateTokens(m.content));

  // Walk backward, accumulating tokens, to identify the protection window.
  // Messages within the last pruneProtectTokens are protected.
  let cumulativeTokens = 0;
  const protectedIndices = new Set<number>();

  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = tokenFor(history[i]);
    cumulativeTokens += tokens;
    if (cumulativeTokens <= pruneProtectTokens) {
      protectedIndices.add(i);
    }
    // Continue accumulating even after threshold to know full size,
    // but stop marking as protected.
  }

  let tokensFreed = 0;
  const result: T[] = history.map((msg, i) => {
    // Only clear tool role messages that are outside the protect window
    // and whose content hasn't already been cleared.
    if (
      msg.role === "tool" &&
      !protectedIndices.has(i) &&
      msg.content !== TOOL_OUTPUT_CLEARED &&
      msg.content.trim().length > 0
    ) {
      const freed = tokenFor(msg) - estimateTokens(TOOL_OUTPUT_CLEARED);
      if (freed > 0) tokensFreed += freed;
      return { ...msg, content: TOOL_OUTPUT_CLEARED } as T;
    }
    return msg;
  });

  return { messages: result, tokensFreed };
}

/**
 * Truncate conversation history to fit within the model's context window.
 *
 * Algorithm (OpenCode-compatible):
 *   1. budget = contextWindow - systemTokens - maxOutputTokens - COMPACTION_BUFFER
 *   2. Identify turns (user+assistant pairs). Preserve the last `tailTurns` turns.
 *   3. Always keep the first user message (task anchor).
 *   4. Drop middle messages oldest-first until the kept set fits the budget.
 *   5. If still over budget, shrink the tail from the front.
 *   6. Last resort: keep only the last message.
 *
 * When messages are dropped, inserts a summary as role="user" (NOT "system")
 * to be compatible with ALL providers (OpenAI, Anthropic, Gemini all reject
 * mid-conversation system messages).
 */
export function truncateHistory<T extends HistoryMessage>(
  messages: T[],
  systemPrompt: string,
  options: Partial<ContextManagementOptions> & { contextWindow?: number },
): TruncatedHistory<T> {
  if (messages.length === 0) {
    return { messages: [], dropped: 0, keptTokens: 0 };
  }

  // If contextWindow is unknown (not provided by provider), don't truncate
  // This matches OpenCode's approach - no magic fallback numbers
  const contextWindow = options.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    return {
      messages: [...messages],
      dropped: 0,
      keptTokens: messages.reduce(
        (sum, m) => sum + (options.estimateToken ? options.estimateToken(m) : estimateTokens(m.content)),
        0,
      ),
    };
  }

  const cfg = { ...DEFAULT_CONTEXT_CONFIG, ...options.contextConfig };

  const systemTokens = options.systemTokens ?? estimateTokens(systemPrompt);
  const maxOutputTokens = options.maxOutputTokens ?? 0;
  const reservedOutput = Math.min(maxOutputTokens, cfg.outputTokenCap);
  const usableBudget = Math.max(0, contextWindow - systemTokens - reservedOutput - cfg.compactionBuffer);

  // OpenCode: preserve tailTurns (default 2) of user+assistant pairs
  const tailTurns = Math.max(1, options.tailTurns ?? cfg.tailTurns);
  
  // Find turn boundaries (user -> assistant pairs)
  const turnBoundaries: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === "user") {
      const start = i;
      i++;
      // Find the matching assistant response
      while (i < messages.length && messages[i].role !== "user") {
        i++;
      }
      turnBoundaries.push({ start, end: i });
    } else {
      i++;
    }
  }

  // Determine which turns to preserve (last N turns)
  const preservedTurnIndices = new Set<number>();
  const tailStartIdx = Math.max(0, turnBoundaries.length - tailTurns);
  for (let t = tailStartIdx; t < turnBoundaries.length; t++) {
    const turn = turnBoundaries[t];
    for (let idx = turn.start; idx < turn.end; idx++) {
      preservedTurnIndices.add(idx);
    }
  }

  // Always keep first user message (task anchor)
  let firstUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) firstUserIdx = 0;
  preservedTurnIndices.add(firstUserIdx);

  // Always keep compaction summary markers — dropping them would discard the
  // compacted history they encode (the only lossless trace of older turns).
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && isCompactionMarker(messages[i].content)) {
      preservedTurnIndices.add(i);
    }
  }

  // Build kept indices — start with ALL messages, then drop from middle
  const keptIdx = new Set<number>(Array.from({ length: messages.length }, (_, i) => i));

  const tokenFor = (idx: number): number =>
    options.estimateToken ? options.estimateToken(messages[idx]) : estimateTokens(messages[idx].content);
  let currentTokens = 0;
  for (const idx of keptIdx) currentTokens += tokenFor(idx);

  // Middle indices (candidates for dropping), oldest first — exclude preserved.
  // Group assistant+tool sequences so tool call/result pairs are dropped together
  // to avoid orphaned tool messages that providers reject.
  const middleChunks: Array<number[]> = [];
  {
    let i = firstUserIdx + 1;
    while (i < messages.length) {
      if (preservedTurnIndices.has(i)) { i++; continue; }
      // Start a new chunk at this non-preserved index
      const chunk: number[] = [i];
      i++;
      // Consume consecutive non-preserved tool messages that follow an assistant
      // message (these are tool results belonging to the same tool-call batch)
      while (i < messages.length && !preservedTurnIndices.has(i) &&
        (messages[i].role === "tool" || messages[i].role === "assistant")) {
        chunk.push(i);
        i++;
      }
      middleChunks.push(chunk);
    }
  }

  let dropped = 0;
  for (const chunk of middleChunks) {
    if (currentTokens <= usableBudget) break;
    for (const idx of chunk) {
      if (currentTokens <= usableBudget) break;
      if (keptIdx.delete(idx)) {
        currentTokens -= tokenFor(idx);
        dropped++;
      }
    }
  }

  // If still over budget, drop from front of tail (but never the first user message)
  if (currentTokens > usableBudget && tailStartIdx < turnBoundaries.length) {
    for (let t = tailStartIdx; t < turnBoundaries.length && currentTokens > usableBudget; t++) {
      const turn = turnBoundaries[t];
      for (let idx = turn.start; idx < turn.end && currentTokens > usableBudget; idx++) {
        if (idx === firstUserIdx) continue;
        if (keptIdx.delete(idx)) {
          currentTokens -= tokenFor(idx);
          dropped++;
        }
      }
    }
  }

  // Last resort: keep the task anchor + the last message.
  // The function's contract is "Always keep the first user message (task
  // anchor)" — without it the agent loses the original goal of the
  // conversation. Previously this block did keptIdx.clear() and then only
  // re-added messages.length - 1, silently dropping the anchor.
  if (currentTokens > usableBudget && messages.length > 1) {
    keptIdx.clear();
    keptIdx.add(firstUserIdx);
    if (firstUserIdx !== messages.length - 1) {
      keptIdx.add(messages.length - 1);
    }
    dropped = messages.length - keptIdx.size;
  }

  // Build output in original order — return original message objects to preserve all fields
  const orderedIdx = Array.from(keptIdx).sort((a, b) => a - b);
  const out: T[] = orderedIdx.map((idx) => messages[idx]);

  // Inject summary as role="user" — NOT "system".
  if (dropped > 0) {
    const droppedIndices = Array.from(keptIdx).length < messages.length
      ? Array.from({ length: messages.length }, (_, i) => i).filter((i) => !keptIdx.has(i))
      : [];
    const droppedMsgs = droppedIndices.map((idx) => messages[idx]);
    const summary = buildStructuredSummary(droppedMsgs, "[Previous conversation — compacted]");
    if (summary) {
      const summaryMsg: T = { role: "user", content: summary, createdAt: new Date() } as T;
      const firstUserOutIdx = out.findIndex((m) => m.role === "user");
      if (firstUserOutIdx >= 0 && firstUserOutIdx < out.length - 1) {
        out.splice(firstUserOutIdx + 1, 0, summaryMsg);
      } else if (firstUserOutIdx === out.length - 1) {
        out.push(summaryMsg);
      } else {
        out.unshift(summaryMsg);
      }
    }
  }

  const keptTokens = out.reduce(
    (sum, m) => sum + (options.estimateToken ? options.estimateToken(m) : estimateTokens(m.content)),
    0,
  );
  return { messages: out, dropped, keptTokens };
}

const PATH_FIELD_RE =
  /"(?:path|filepath|file|destination|target|src|source)"\s*:\s*"([^"]+)"/g;

const COMMAND_FIELD_RE = /"(?:command|cmd)"\s*:\s*"([^"]+)"/;

interface ExtractedToolCall {
  tool: string;
  argsText: string;
  args: Record<string, unknown> | null;
}

function extractToolCalls(content: string): ExtractedToolCall[] {
  const out: ExtractedToolCall[] = [];
  const re = new RegExp(TOOL_CALL_JSON_RE.source, "gi");
  for (const m of content.matchAll(re)) {
    const tool = m[1];
    const argsText = m[2];
    let args: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch { args = null; }
    out.push({ tool, argsText, args });
  }
  return out;
}

function pathFromToolCall(tc: ExtractedToolCall): string | null {
  if (tc.args) {
    const candidates = [tc.args.path, tc.args.filepath, tc.args.file, tc.args.destination, tc.args.target, tc.args.src, tc.args.source];
    for (const v of candidates) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  PATH_FIELD_RE.lastIndex = 0;
  const m = PATH_FIELD_RE.exec(tc.argsText);
  if (m && m[1]) return m[1];
  return null;
}

function commandFromToolCall(tc: ExtractedToolCall): string | null {
  if (tc.args) {
    const v = tc.args.command ?? tc.args.cmd;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const m = tc.argsText.match(COMMAND_FIELD_RE);
  if (m && m[1]) return m[1];
  return null;
}

function stripToolCallArtifacts(content: string): string {
  return content
    .replace(new RegExp(TOOL_CALL_FENCE_RE.source, "gi"), "")
    .replace(new RegExp(XML_TOOL_CALL_RE.source, "gi"), "")
    .replace(new RegExp(TOOL_CALL_JSON_RE.source, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeGoal(content: string): string {
  const clean = content
    .replace(/--- FILE CONTENT START ---[\s\S]*?--- FILE CONTENT END ---/g, "")
    .replace(/\[File:\s*[^\]]+\][\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return content.slice(0, 200).trim();
  return clean.slice(0, 240).trim();
}

/**
 * Structured summary template for the compaction call. Aligned with opencode's
 * compaction template (packages/core/src/session/compaction.ts): continuation
 *-oriented sections the agent actually needs to resume work — what's done,
 * what's active, what's blocked, what to do next, which files matter.
 */
export const COMPACTION_SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown below and keep the section order unchanged. Do not add or remove sections.

## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints, preferences, decisions and why, key facts/assumptions, exact context needed to continue; "(none)" if none]

## Work State
### Completed
- [finished work, verified facts, or changes made; "(none)" if none]

### Active
- [current work, partial changes, or investigation state; "(none)" if none]

### Blocked
- [blockers, failing commands, or unknowns; "(none)" if none]

## Next Steps
1. [immediate concrete action, or "(none)"]
2. [next action if known, or delete the line]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/**
 * Build the compaction prompt shared by auto-compact and `/compact`.
 *
 * When a previous summary exists, the prompt anchors on it — opencode's
 * incremental model: "update the anchored summary, keep still-true details,
 * drop stale ones" — so each compaction only folds in the delta since the
 * last one instead of re-summarizing the full history from scratch.
 */
export function buildCompactionPrompt(input: {
  transcript: string;
  /** Inline text of the most recent prior `<context_summary>` marker, if any. */
  previousSummary?: string;
}): string {
  const preamble = input.previousSummary
    ? `You are a context-compression assistant for an AI coding IDE.
Update the anchored summary below using the conversation history.
Preserve still-true details, remove stale details, and merge in the new facts.
<previous-summary>
${input.previousSummary}
</previous-summary>`
    : "You are a context-compression assistant for an AI coding IDE. Create a new anchored summary from the conversation history.";
  return `${preamble}

${COMPACTION_SUMMARY_TEMPLATE}

The following is the conversation history:

${input.transcript}`;
}

/**
 * Build a local structured summary of a set of messages.
 * Used as fallback when the model-based compact call fails.
 * No model call — pure regex/JSON extraction.
 * Sections match the OpenCode compaction template (see
 * {@link COMPACTION_SUMMARY_TEMPLATE}): Objective, Important Details,
 * Work State (Completed / Active / Blocked), Next Steps, Relevant Files.
 */
function buildStructuredSummary(msgs: HistoryMessage[], header: string): string {
  if (msgs.length === 0) return "";

  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const commandsRun: string[] = [];
  const errors: string[] = [];
  const decisions: string[] = [];
  let originalRequest = "";
  let lastAssistantText = "";

  for (const m of msgs) {
    if (m.role === "user" && m.content.trim() && !originalRequest) {
      originalRequest = sanitizeGoal(m.content);
    }
    if (m.role === "assistant") {
      const calls = extractToolCalls(m.content);
      for (const c of calls) {
        if (c.tool === "run_command") { const cmd = commandFromToolCall(c); if (cmd) commandsRun.push(cmd.slice(0, 120)); }
        else if (isWriteTool(c.tool)) { const p = pathFromToolCall(c); if (p) filesModified.add(p); }
        else if (isReadOnlyTool(c.tool)) { const p = pathFromToolCall(c); if (p) filesRead.add(p); }
      }
      const narration = stripToolCallArtifacts(m.content);
      if (narration) {
        const sentenceEnd = narration.search(/[.!?]\s/);
        const snippet = sentenceEnd > 0
          ? narration.slice(0, Math.min(sentenceEnd + 1, 200))
          : narration.slice(0, 200);
        if (snippet.length > 15) decisions.push(snippet.trim());
        lastAssistantText = narration.slice(0, 280);
      }
    }
    if (m.role === "tool") {
      const lower = m.content.toLowerCase();
      if (lower.includes("failed") || lower.includes("denied") || lower.includes("error") || lower.includes("exception")) {
        const snippet = m.content.trim().slice(0, 200);
        if (snippet) errors.push(snippet);
      }
    }
  }

  // Deduplicate: remove modified files from the read-only set.
  const pureReadFiles = Array.from(filesRead).filter((f) => !filesModified.has(f));

  const relevant: string[] = [];
  for (const f of pureReadFiles.slice(0, 15)) relevant.push(`- \`${f}\` (read)`);
  for (const f of Array.from(filesModified).slice(0, 15)) relevant.push(`- \`${f}\` (modified)`);
  const relevantText = relevant.length > 0 ? relevant.join("\n") : "- (none)";

  const completed: string[] = [];
  for (const f of Array.from(filesModified).slice(0, 15)) completed.push(`${f} modified`);
  for (const c of Array.from(new Set(commandsRun)).slice(0, 8)) completed.push(String(c));
  const completedText = completed.length > 0 ? completed.map((c) => `- ${c}`).join("\n") : "- (none)";

  const activeText = lastAssistantText ? lastAssistantText.slice(0, 280) : "(none)";
  const blockedText =
    errors.length > 0 ? errors.slice(-3).map((e) => `- ${e}`).join("\n") : "- (none)";

  const lines: string[] = [header];
  if (originalRequest) lines.push(`## Objective\n- ${originalRequest}`);
  const keyDetails = decisions.slice(-5).filter(Boolean);
  lines.push(
    `## Important Details\n${keyDetails.length > 0 ? keyDetails.map((d) => `- ${d}`).join("\n") : "- (none)"}`,
  );
  lines.push(
    `## Work State\n### Completed\n${completedText}\n\n### Active\n- ${activeText}\n\n### Blocked\n${blockedText}`,
  );
  lines.push(`## Next Steps\n1. ${activeText === "(none)" ? "(none)" : activeText.slice(0, 160)}`);
  lines.push(`## Relevant Files\n${relevantText}`);

  let out = lines.join("\n\n");
  // Cap the fallback summary so it never eats the budget it's saving: 20k
  // chars ≈ 5k tokens (cl100k) — matches opencode's 4,096-token
  // SUMMARY_OUTPUT_TOKENS with margin.
  const MAX_FALLBACK_SUMMARY_CHARS = 20_000;
  if (out.length > MAX_FALLBACK_SUMMARY_CHARS) {
    out = out.slice(0, MAX_FALLBACK_SUMMARY_CHARS - 3) + "...";
  }
  return out;
}

/**
 * Compact an entire conversation into a single structured summary string.
 *
 * Used as fallback by `/compact` and auto-compact when the AI model call fails.
 * Returns an empty string if `messages` is empty.
 */
export function compactConversation(messages: HistoryMessage[]): string {
  return buildStructuredSummary(messages, "[Conversation summary — full history compacted]");
}

/**
 * Max messages to send to the compaction model. Beyond this, older messages
 * are dropped to avoid overwhelming the compaction call with context that
 * would itself trigger a 413 overflow error.
 *
 * Aligned with opencode: compaction covers the whole window except the
 * verbatim recent tail (see `resolvePreserveRecentBudget`), so a cap on the
 * payload is what keeps the summarizer call from overflowing.
 */
const MAX_COMPACTION_MESSAGES = 40;

/**
 * Max chars for a completed tool output sent to the compaction model.
 * Large outputs (e.g., file reads, command results) are truncated to this
 * to keep the compaction payload small enough to not overflow.
 *
 * Matches opencode's `TOOL_OUTPUT_MAX_CHARS` (2_000).
 */
const COMPACTION_TOOL_OUTPUT_MAX_CHARS = 2_000;

/**
 * Max chars for a synthetic text part sent to the compaction model.
 * Synthetic parts are injected file contents from `@` references that
 * can be massive.
 */
const COMPACTION_SYNTHETIC_MAX_CHARS = 2_000;

/**
 * Pre-flight pruning of messages before sending to the compaction API call.
 *
 * When auto-compact triggers on overflow, the full oversized context would
 * be sent to the compaction LLM — which then ALSO fails with 413. This
 * function prunes aggressively BEFORE the compaction call so the compaction
 * payload itself fits.
 *
 * All modifications are on shallow copies — the caller's objects are never
 * mutated.
 *
 * Aligned with opencode's compaction serialization:
 *   1. Cap at MAX_COMPACTION_MESSAGES (40) — anchor + most recent 39.
 *   2. Truncate completed tool outputs to 2_000 chars.
 *   3. Truncate large synthetic text parts to 2_000 chars.
 */
export function pruneForOverflow<T extends HistoryMessage>(messages: T[]): T[] {
  if (messages.length === 0) return [];

  // Step 1: Cap at MAX_COMPACTION_MESSAGES while preserving the first user message (task anchor)
  let pruned: T[];
  if (messages.length > MAX_COMPACTION_MESSAGES) {
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    if (firstUserIdx !== -1) {
      const anchor = messages[firstUserIdx];
      const recentCount = MAX_COMPACTION_MESSAGES - 1;
      const recent = messages.slice(-recentCount).filter((_, i) => {
        const actualIdx = messages.length - recentCount + i;
        return actualIdx !== firstUserIdx;
      });
      pruned = [anchor, ...recent];
    } else {
      pruned = messages.slice(-MAX_COMPACTION_MESSAGES);
    }
  } else {
    pruned = [...messages];
  }

  // Step 2 & 3: Truncate large content in-place on shallow copies
  pruned = pruned.map((msg) => {
    if (msg.role !== "tool" && msg.role !== "user") return msg;

    let content = msg.content;

    // Step 2: Truncate completed tool outputs to 500 chars
    if (msg.role === "tool" && content.length > COMPACTION_TOOL_OUTPUT_MAX_CHARS) {
      content = content.slice(0, COMPACTION_TOOL_OUTPUT_MAX_CHARS) +
        `\n…[tool output truncated to ${COMPACTION_TOOL_OUTPUT_MAX_CHARS} chars for compaction]`;
    }

    // Step 3: Truncate large synthetic text parts — detect via synthetic markers
    if (msg.role === "user") {
      const isSynthetic = content.includes("[File:") || content.includes("--- FILE CONTENT START ---") ||
        content.includes("@") && content.length > 2000;
      if (isSynthetic && content.length > COMPACTION_SYNTHETIC_MAX_CHARS) {
        content = content.slice(0, COMPACTION_SYNTHETIC_MAX_CHARS) +
          `\n…[synthetic text truncated to ${COMPACTION_SYNTHETIC_MAX_CHARS} chars for compaction]`;
      }
    }

    return { ...msg, content } as T;
  });

  return pruned;
}

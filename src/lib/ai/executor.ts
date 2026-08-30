import { db } from "@/lib/db";
import { readFileSync, existsSync, promises as fsPromises } from "fs";
import * as path from "path";
import { pruneOldToolOutputs, isContextOverflow, truncateHistory, pruneForOverflow, estimateTokens, estimateMessageTokens, resolveEffectiveMaxInputBudget, selectCompactionTail, COMPACTION_TRIGGER_RATIO, resolvePreserveRecentBudget, buildCompactionPrompt, DEFAULT_CONTEXT_CONFIG, isCompactionMarker, type ContextConfig } from "./context";
import { fitPayloadToBudget, recoverGroqTpmRateLimit } from "./token-budget";
import { buildDiscoveryBlock } from "./discovery";
import { decrypt } from "@/lib/encryption";
import { getSecuritySettings } from "@/lib/security-settings";
import { scrubHistoryForWire, scrubPromptString } from "@/lib/security-scrub";
import { PROVIDERS, resolveModel, getProvider, modelSupportsVision, requiresReasoningEcho, rememberReasoningEchoRequired, DEFAULT_FALLBACK_MODEL } from "@/lib/ai/providers";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { peekModelInRegistry } from "@/lib/models-dev";
import { refreshProviderModels } from "@/lib/provider-fetch";
import {
  runTool,
  resolveWs,
  PUBLIC_BUILTIN_TOOLS,
} from "@/lib/ai/tools";
import {
  evaluateToolPermission,
  getPermissions,
  refreshPermissionsConfig,
  actionForTool,
  isReadOnlyTool,
  isWriteTool,
  type PermissionAction,
  type PermissionMode,
} from "@/lib/permissions";
import {
  createPendingApproval,
  cancelPendingForConversation,
  type PermissionDecision,
} from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation, raceWithAbort } from "@/lib/question-prompt";
import { audit } from "@/app/api/_lib/helpers";
import { assertUrlAllowed } from "@/lib/ssrf";
import { parseMentions, parseCommands, type ParsedMention } from "@/lib/mentions";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  readFileWs,
  getCompletedCommand,
  acknowledgeCompletedCommand,
} from "@/lib/workspace";
import { mergeReasoningCapability } from "@/lib/provider-models";
import { getSubagents } from "@/lib/ai/subagents";
import { createCheckpoint } from "@/lib/checkpoints";
import {
  deferSubagentDelivery,
  isSubagentReportDelivered,
  grantAndPublishWake,
  recheckDeferredDelivery,
} from "@/lib/ai/subagent-delivery";
import {
  drainSubagentReports,
  registerActiveRun,
  unregisterActiveRun,
  markSubagentReportDelivered,
  unmarkSubagentReportDelivered,
  enqueueSubagentReport,
} from "@/lib/ai/subagent-queue";
import { getSession } from "@/lib/ai/subagent-session";
import {
  takeQueuedUserTurns,
  clearQueuedUserTurns,
} from "@/lib/ai/user-queue";
import { truncateToolOutput } from "@/lib/truncate";
import {
  extractUpstreamError,
  parseNonStreamingResponse,
  STREAM_TOOL_START_RE,
  STREAM_TOOL_COMPLETE_RE,
} from "@/lib/ai/tool-call-parser";
import {
  configureRequestBody,
  sanitizeRejectedReasoningParams,
  parseSseReasoningChunk,
  extractOpenAIUsage,
  extractAnthropicUsage,
  isStreamOptionsRejected,
  markStreamOptionsRejected,
  ANTHROPIC_SDK_DEFAULT_MAX_TOKENS,
  type MeasuredUsage,
} from "@/lib/ai/provider-payloads";
import {
  stripHtml,
  parseRetryHeader,
  getErrorStatusCode,
  isTransientStreamError,
} from "@/lib/ai/retry-utils";
import {
  resolveReasoningPlan,
  normalizeThinkingLevel,
  rememberReasoningRejected,
  rememberModelRejectsReasoning,
  hostRejectsReasoning,
  modelRejectsReasoning,
  isBehavioralScheme,
  parseModelReasoningCapabilities,
  type ReasoningPlan,
  type ModelReasoningCapabilities,
  type ThinkingLevel,
} from "@/lib/reasoning";
import type {
  ChatRequest,
  ChatStreamEvent,
  ProviderId,
  ToolCall,
  AgentMode,
} from "@/lib/types";

function throwProviderError(resp: Response, retryText: string) {
  const text = retryText.slice(0, 500);
  const err = new Error(`Provider returned ${resp.status}: ${stripHtml(text) || resp.statusText}`);
  (err as Error & { status?: number }).status = resp.status;
  (err as Error & { responseBody?: string }).responseBody = retryText.slice(0, 1000);
  throw err;
}

/** Max agent iterations — configurable via HERMOS_MAX_AGENT_ITERATIONS.
 *  Defaults to Infinity (uncapped) to preserve autonomous design.
 *  Operators can set a finite ceiling as a global safety net. */
const MAX_ITERATIONS: number = (() => {
  const raw = process.env.HERMOS_MAX_AGENT_ITERATIONS;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

// Fallback max_tokens only where a provider API REQUIRES the field.
// See ANTHROPIC_SDK_DEFAULT_MAX_TOKENS in provider-payloads.ts.

/** Helper to build compound cache key for rejected tools (so switching models/providers doesn't stay stuck). */
function toolsRejectedKey(convId: string, provider?: string, model?: string): string {
  return `${convId}:${provider || ""}:${model || ""}`;
}

/** Cache of rejected tool definitions per conversation+model to avoid repeated failed attempts. */
const toolsRejectedCache = new Map<string, boolean>();
const TOOLS_REJECTED_CACHE_MAX = 500;
function setToolsRejected(convId: string, provider?: string, model?: string): void {
  if (toolsRejectedCache.size >= TOOLS_REJECTED_CACHE_MAX) {
    const key = toolsRejectedCache.keys().next();
    if (!key.done) toolsRejectedCache.delete(key.value);
  }
  const compoundKey = toolsRejectedKey(convId, provider, model);
  toolsRejectedCache.set(compoundKey, true);
}

function isToolsRejected(convId: string, provider?: string, model?: string): boolean {
  if (provider || model) {
    return toolsRejectedCache.has(toolsRejectedKey(convId, provider, model));
  }
  return toolsRejectedCache.has(convId);
}

/** Clear per-conversation in-memory caches (tools-rejected flag, read tracker). */
export function clearConversationCache(conversationId: string): void {
  toolsRejectedCache.delete(conversationId);
  for (const key of Array.from(toolsRejectedCache.keys())) {
    if (key.startsWith(`${conversationId}:`)) {
      toolsRejectedCache.delete(key);
    }
  }
  sessionReadTracker.delete(conversationId);
}

/** Helper: resolve attachment IDs from the DB and return file info + bytes. */
interface ResolvedAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Full file path on disk. */
  path: string;
  /** File bytes (lazily loaded on first access via getBytes()). */
  _buffer?: Buffer;
}

export async function resolveAttachments(
  ids: string[],
  userId: string,
  conversationId: string,
): Promise<ResolvedAttachment[]> {
  if (!ids || ids.length === 0) return [];
  const rows = await db.attachment.findMany({
    where: { id: { in: ids }, conversationId, userId },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    size: r.size,
    path: r.path,
  }));
}

function getAttachmentBuffer(a: ResolvedAttachment): Buffer | null {
  try {
    if (existsSync(a.path)) {
      return readFileSync(a.path);
    }
  } catch {
    /* disk read failure — attachment unavailable */
  }
  return null;
}

/** Read-only tools allowed in Architect mode. */
const ARCHITECT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  PUBLIC_BUILTIN_TOOLS.filter((t) => isReadOnlyTool(t.name)).map((t) => t.name),
);

/** Subagent orchestration tools allowed in Architect mode (delegated to read-only toolsets). */
const ARCHITECT_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "spawn_subagent",
  "get_subagent",
  "message_subagent",
]);

/** Everything architect mode may invoke: read-only tools + orchestration. */
const ARCHITECT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...ARCHITECT_READ_ONLY_TOOLS,
  ...ARCHITECT_SUBAGENT_TOOLS,
]);

/** Reasonable limit for inlined preview text extracted from text-like attachments. */
const MAX_ATTACHMENT_PREVIEW_CHARS = 50000;

/**
 * Resolve image attachments from LoadedMessage[] into a map of
 * attachment ID → { mediaType, base64 } so message builders can
 * inject actual image content blocks for vision-capable models.
 */
type ResolvedImageData = Map<string, { mediaType: string; base64: string }>;

async function resolveHistoryImages(
  history: LoadedMessage[],
  userId: string,
  conversationId: string,
): Promise<ResolvedImageData> {
  const imageMap: ResolvedImageData = new Map();
  const allIds = new Set<string>();
  for (const m of history) {
    if (m.role !== "user" || !m.attachments) continue;
    try {
      const atts = JSON.parse(m.attachments) as Array<{ id: string; type: string }>;
      for (const a of atts) {
        if (a.type.startsWith("image/")) allIds.add(a.id);
      }
    } catch { /* ignore malformed JSON */ }
  }
  if (allIds.size === 0) return imageMap;
  const rows = await db.attachment.findMany({
    where: { id: { in: Array.from(allIds) }, conversationId, userId },
  });
  for (const row of rows) {
    if (!row.type.startsWith("image/")) continue;
    try {
      const buf = readFileSync(row.path);
      imageMap.set(row.id, { mediaType: row.type, base64: buf.toString("base64") });
    } catch { /* file not found */ }
  }
  return imageMap;
}

/** Extract text preview from attachment for non-multimodal model representations. */
export function extractAttachmentPreview(a: ResolvedAttachment): string {
  const buf = getAttachmentBuffer(a);
  if (!buf) return `[Attachment "${a.name}" — ${formatBytes(a.size)} — could not be read]`;
  const type = a.type.toLowerCase();
  if (type.startsWith("image/")) {
    return `[Image: "${a.name}" (${a.type}, ${formatBytes(a.size)}) — described inline below if the model supports vision, otherwise omitted]`;
  }
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("yaml") || type.includes("javascript") || type.includes("typescript")) {
    const text = buf.toString("utf-8").slice(0, MAX_ATTACHMENT_PREVIEW_CHARS);
    return `[File: "${a.name}" (${formatBytes(a.size)})\n\`\`\`\n${text}\n\`\`\`${buf.length > MAX_ATTACHMENT_PREVIEW_CHARS ? "\n...[truncated]" : ""}]`;
  }
  return `[Attachment: "${a.name}" (${a.type}, ${formatBytes(a.size)})]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Some models occasionally repeat the same prose line
// ("Now let me enhance …") 4-6 times word-for-word before emitting a
// tool call. This helper collapses runs of identical trimmed lines.
function collapseDuplicateLines(text: string): string {
  if (!text || text.length < 2) return text;
  let prevTrimmed: string | null = null;
  let start = 0;
  // Single pass: build output, collapsing consecutive duplicate trimmed lines.
  // Avoids allocating the full split array — pushes directly to out[].
  const out: string[] = [];
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const line = text.slice(start, i);
      const trimmed = line.trim();
      if (!(trimmed && trimmed === prevTrimmed)) {
        out.push(line);
      }
      prevTrimmed = trimmed || null;
      start = i + 1;
    }
  }
  // If no duplicates were found, out.length will equal the line count.
  // Inlining the common case (no duplicates) here instead of branching:
  return out.join("\n");
}

/** Conversation session read tracker to catch repeated reads of identical line ranges. */
const sessionReadTracker = new Map<string, Set<string>>();

/**
 * Detects when the agent is no longer making progress by fingerprinting
 * each iteration's streamed text output (normalized: trim + lowercase +
 * collapse whitespace). Identical output across iterations = no progress.
 *
 * An agent that is making genuine progress produces different text each
 * iteration. An agent in a loop produces the same text repeatedly.
 *
 * Escalation ladder:
 *   - 2 consecutive identical outputs → "warn" — caller injects a system
 *     correction instructing the model to change approach
 *   - 3 consecutive → "break" — caller force-terminates with a diagnostic
 */
class ConvergenceDetector {
  private history: string[] = [];

  private normalize(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * Record this iteration's text output. Returns the action to take.
   * @param iterText - The cleaned text output from this iteration (after
   *   collapseDuplicateLines + stripToolCallBlocks).
   */
  record(iterText: string): "ok" | "warn" | "break" {
    const normalized = this.normalize(iterText);
    // Skip empty iterations (tool-only turns with no prose).
    if (!normalized) return "ok";
    this.history.push(normalized);

    // Count consecutive trailing repetitions of the current fingerprint.
    let consecutive = 0;
    const current = this.history[this.history.length - 1];
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i] === current) consecutive++;
      else break;
    }

    if (consecutive >= 3) return "break";
    if (consecutive >= 2) return "warn";
    return "ok";
  }

  reset(): void {
    this.history = [];
  }
}
const NATIVE_SYSTEM_PROMPT = `You are HermOS, an elite coding agent in the HermOS full-stack IDE. Complete tasks end-to-end: investigate, implement, verify, report.

- GROUND TRUTH: Base claims only on tool output. Find files with grep/glob first; read targeted ranges (files <500 lines: whole; larger: by range). Never re-read identical ranges.
- SURGICAL EDITS: Sequential, character-exact diffs. Match surrounding code style, types, and architecture. Never write placeholders, stubs, TODOs, or mocks.
- PROVE IT: Always verify correctness (run build/typecheck/lint/tests) before finishing. On error/failure: read output, fix root cause, and retry — a failure is never "done".
- SECRETS & BUDGET: Never print or commit real keys/secrets. Quote key log lines, not full walls.
- TASK TRACKING: For complex, multi-step tasks or when planning work, invoke the todo_write tool to maintain and update structured todo items so progress is tracked live in the UI.
- ASKING QUESTIONS: When requirements are genuinely ambiguous or involve significant architectural/design tradeoffs, call the ask_question tool with structured options. Never ask questions that can be answered by reading the codebase, and never ask trivial questions.
- CONCISE, ENGLISH: Always use relative workspace paths. Put extensive plans/docs into create_artifact; keep chat responses short.
- SUBAGENTS: spawn_subagent runs asynchronously in background. Never poll or loop-wait — end turn; reports auto-deliver upon completion.

Use the tools exposed via the native function-calling API.`;

/**
 * TEXT_FALLBACK system prompt — used only when a provider rejects native
 * function-calling. The "Available tools" list is mode-aware: architect mode
 * lists only the read-only tools that will actually be honored (write tools
 * would be denied anyway), chat mode lists none.
 */
function buildTextFallbackSystemPrompt(enabledTools: string[], mode: AgentMode): string {
  const availableList =
    enabledTools.length > 0
      ? enabledTools.join(", ")
      : mode === "chat"
        ? "(tool usage is disabled in Chat mode)"
        : PUBLIC_BUILTIN_TOOLS.map((t) => t.name).join(", ");
  return `You are HermOS, an elite coding agent in the HermOS full-stack IDE. Complete tasks end-to-end: investigate, implement, verify, report.

- GROUND TRUTH: Base claims only on tool output. Find files with grep/glob first; read targeted ranges (files <500 lines: whole; larger: by range). Never re-read identical ranges.
- SURGICAL EDITS: Sequential, character-exact diffs. Match surrounding code style, types, and architecture. Never write placeholders, stubs, TODOs, or mocks.
- PROVE IT: Always verify correctness (run build/typecheck/lint/tests) before finishing. On error/failure: read output, fix root cause, and retry — a failure is never "done".
- SECRETS & BUDGET: Never print or commit real keys/secrets. Quote key log lines, not full walls.
- TASK TRACKING: For complex, multi-step tasks or when planning work, invoke the todo_write tool to maintain and update structured todo items so progress is tracked live in the UI.
- ASKING QUESTIONS: When requirements are genuinely ambiguous or involve significant architectural/design tradeoffs, call the ask_question tool with structured options. Never ask questions that can be answered by reading the codebase, and never ask trivial questions.
- CONCISE, ENGLISH: Always use relative workspace paths. Put extensive plans/docs into create_artifact; keep chat responses short.
- SUBAGENTS: spawn_subagent runs asynchronously in background. Never poll or loop-wait — end turn; reports auto-deliver upon completion.

To call a tool, output a JSON object on its own line:
{"tool":"tool_name","args":{"key":"value"}}

Available tools: ${availableList}.

Examples:

User: hi
Assistant: Hello! How can I help you with your codebase today?

User: what files are in this project?
Assistant: {"tool":"list_directory","args":{"path":"."}}

User: read src/math.ts
Assistant: {"tool":"read_file","args":{"path":"src/math.ts"}}`;
}

// Default export kept for callers that don't pick a variant (e.g. agent-preset
// overrides that previously referenced DEFAULT_SYSTEM_PROMPT). Resolves to the
// native variant — the executor selects the right one per iteration.
const DEFAULT_SYSTEM_PROMPT = NATIVE_SYSTEM_PROMPT;

export interface ExecuteOptions {
  user: { id: string };
  req: ChatRequest;
  /** Emit one SSE event to the client. */
  emit: (event: ChatStreamEvent) => void;
  /** AbortSignal tied to the client connection. */
  signal?: AbortSignal;
}

interface LoadedMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  thoughtSignature?: string;
  /** JSON stringified array of { id, name, type, size } from the DB. */
  attachments?: string;
  /** DB row identity — carried through so token estimates can be memoized. */
  id?: string;
  createdAt?: Date;
}

/** In-memory mirror of a Message DB row for the per-run history cache. */
interface CachedRow {
  id: string;
  role: string;
  content: string;
  toolCallId: string | null;
  toolCalls: string | null;
  thinking: string | null;
  segments?: string | null;
  attachments: string | null;
  createdAt: Date;
}

/** Extract the inline text of a `<context_summary>` marker, or null. */
function compactionSummaryText(content: string): string | null {
  if (!isCompactionMarker(content)) return null;
  const match = /<context_summary(?:\s+[^>]*)?>([\s\S]*?)(?:<\/context_summary>|$)/i.exec(content);
  if (!match) return null;
  const inner = match[1].trim();
  return inner || null;
}

/**
 * Applies compaction window: returns [task anchor, summary marker, ...recent rows]
 * to preserve original intent and maximize prompt cache hits.
 */
function applyCompactionWindow<T extends { role: string; content: string }>(rows: T[]): T[] {
  let summaryIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === "user" && isCompactionMarker(rows[i].content)) {
      summaryIdx = i;
    }
  }
  if (summaryIdx < 0) return rows;
  const anchorIdx = rows.findIndex(
    (r) => r.role === "user" && !isCompactionMarker(r.content),
  );
  if (anchorIdx >= 0 && anchorIdx < summaryIdx) {
    return [rows[anchorIdx], ...rows.slice(summaryIdx)];
  }
  return rows.slice(summaryIdx);
}

function mapHistory(rows: Array<{
  role: string;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  thinking: string | null;
  segments?: string | null;
  attachments?: string | null;
  id?: string;
  createdAt?: Date;
}>): LoadedMessage[] {
  return rows.map((r) => {
    const m: LoadedMessage = {
      role: (r.role as LoadedMessage["role"]) || "user",
      content: r.content,
    };
    if (r.id) m.id = r.id;
    if (r.createdAt) m.createdAt = r.createdAt;
    if (r.toolCallId) m.toolCallId = r.toolCallId;
    if (r.thinking) m.thinking = r.thinking;
    if (r.attachments) m.attachments = r.attachments;
    if (r.segments) {
      try {
        const parsedSegs = JSON.parse(r.segments);
        if (Array.isArray(parsedSegs)) {
          const thinkSeg = parsedSegs.find(
            (s: any) => s && s.kind === "thinking" && (s.thoughtSignature || s.signature),
          );
          if (thinkSeg) {
            m.thoughtSignature = thinkSeg.thoughtSignature || thinkSeg.signature;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (r.toolCalls) {
      try {
        m.toolCalls = JSON.parse(r.toolCalls) as ToolCall[];
        if (!m.thoughtSignature && Array.isArray(m.toolCalls)) {
          const tcWithSig = m.toolCalls.find((tc: any) => tc && (tc.thoughtSignature || tc.thought_signature));
          if (tcWithSig) {
            m.thoughtSignature = (tcWithSig as any).thoughtSignature || (tcWithSig as any).thought_signature;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return m;
  });
}

/** Builds OpenAI-format messages with native function-calling tool calls and IDs preserved. */
function toOpenAIMessagesWithTools(
  systemPrompt: string,
  history: LoadedMessage[],
  imageData?: ResolvedImageData,
  supportsVision?: boolean,
  reasoningEcho = false,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];
  
  // Track tool call IDs that have a corresponding `tool` result message in `history`.
  // If an assistant message contains toolCalls whose results are NOT in history (e.g. cancelled/orphaned),
  // emitting those unfulfilled tool_calls will break OpenAI/Gemini providers (which require that tool_calls must be followed by matching tool results).
  const availableToolResults = new Set(
    history.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId!),
  );

  // Track tool call IDs that have been EMITTED in an assistant message in
  // the output so far. A `tool` message may only be appended AFTER its
  // corresponding assistant tool_use has already been pushed to `out` —
  // otherwise the provider errors with "tool role message without a
  // previous assistant message with a tool call" (OpenAI/Anthropic/Gemini
  // all enforce this ordering strictly).
  const emittedToolCallIds = new Set<string>();

  const historyLen = history.length;
  for (let idx = 0; idx < historyLen; idx++) {
    const m = history[idx];
    if (m.role === "system") continue;

    // Recent turn window: keep last 4 items (approx 2 turns) completely uncompressed
    const isRecentTurn = idx >= historyLen - 4;

    if (m.role === "tool") {
      // Only emit a tool result if an assistant tool_call with a matching
      // id has ALREADY been pushed to `out` in this sequential walk.
      if (!m.toolCallId || !emittedToolCallIds.has(m.toolCallId)) {
        continue; // Skip orphan, pre-order, or unmatched tool result
      }

      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      });
      continue;
    }
    if (m.role === "assistant") {
      const hasThinking = !!(m.thinking && m.thinking.trim());
      // DeepSeek-family APIs (incl. Puter's gateway) require the model's
      // reasoning_content to be echoed back verbatim in the dedicated
      // `reasoning_content` field on every subsequent request — inlining it
      // into content text instead triggers HTTP 400.
      const assistantContent = reasoningEcho
        ? (m.content || null)
        : (hasThinking && isRecentTurn)
          ? `<think>${m.thinking}</think>${m.content || ""}`
          : m.content || null;

      // Filter tool calls to only those that have a matching tool response in history
      const validToolCalls = m.toolCalls && m.toolCalls.length > 0
        ? m.toolCalls.filter((tc) => tc.id && availableToolResults.has(tc.id))
        : [];

      if (validToolCalls.length > 0) {
        // Register each tool call id as EMITTED so subsequent `tool` result
        // messages can match against them. Done before pushing so we don't
        // race with the next-history-item check.
        const toolCalls = validToolCalls.map((tc) => {
          if (tc.id) emittedToolCallIds.add(tc.id);
          const res: any = {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          };
          if (tc.thought_signature) {
            res.thought_signature = tc.thought_signature;
            res.extra_content = {
              google: {
                thought_signature: tc.thought_signature,
              },
            };
          }
          if (tc.thoughtSignature) {
            res.thoughtSignature = tc.thoughtSignature;
            if (!res.extra_content) {
              res.extra_content = {
                google: {
                  thoughtSignature: tc.thoughtSignature,
                },
              };
            } else {
              res.extra_content.google.thoughtSignature = tc.thoughtSignature;
            }
          }
          return res;
        });
        const toolMsg: OpenAIMessage = {
          role: "assistant",
          content: assistantContent,
          tool_calls: toolCalls,
        };
        if (reasoningEcho && hasThinking) toolMsg.reasoning_content = m.thinking;
        out.push(toolMsg);
      } else {
        // Skip empty assistant messages (no content and no valid tool calls)
        // to prevent trailing or empty assistant turns from breaking providers like Google Gemini.
        if (!assistantContent || !assistantContent.trim()) {
          if (!(reasoningEcho && hasThinking)) continue;
        }
        const plainMsg: OpenAIMessage = {
          role: "assistant",
          content: assistantContent,
        };
        if (reasoningEcho && hasThinking) plainMsg.reasoning_content = m.thinking;
        out.push(plainMsg);
      }
      continue;
    }
    // User messages — build content with image blocks if vision supported
    if (m.role === "user" && supportsVision && imageData && imageData.size > 0 && m.attachments) {
      try {
        const atts = JSON.parse(m.attachments) as Array<{ id: string; type: string }>;
        const imgAtts = atts.filter((a) => a.type.startsWith("image/"));
        if (imgAtts.length > 0) {
          const blocks: OpenAIContentBlock[] = [];
          if (m.content?.trim()) {
            blocks.push({ type: "text", text: m.content });
          }
          for (const ia of imgAtts) {
            const img = imageData.get(ia.id);
            if (img) {
              blocks.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
            }
          }
          if (blocks.length > 0) {
            out.push({ role: "user", content: blocks });
            continue;
          }
        }
      } catch { /* fall through to plain text push */ }
    }
    out.push({ role: m.role as OpenAIMessage["role"], content: m.content });
  }

  // Ensure output does not end with an assistant message without tool calls.
  // Google Gemini strictly requires that requests must end with a user or tool turn.
  while (
    out.length > 0 &&
    out[out.length - 1].role === "assistant" &&
    (!out[out.length - 1].tool_calls || out[out.length - 1].tool_calls!.length === 0)
  ) {
    out.pop();
  }

  return out;
}

const TOOL_CALL_FENCE_RE = /```tool_call\s*([\s\S]*?)```/gi;
const TOOL_CALL_JSON_RE = /\{"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\}/g;
// Any fenced block (with any/no language tag).
const ANY_FENCE_RE = /```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/g;
// A leading comment like `// edit_file` or `# run_command` naming a tool.
const LEADING_TOOL_COMMENT_RE = /^(?:\/\/|#)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\n([\s\S]*)$/;
// XML-style tool calls: <tool_call>{"tool":"name","args":{...}}</tool_call>
// Also matches <tool_code>...</tool_code> (some models use this variant)
const XML_TOOL_CALL_RE = /<(?:tool_call|tool_code)>\s*([\s\S]*?)<\/(?:tool_call|tool_code)>/gi;
// XML-style tool calls with tag name: <list_directory><path>.</path></list_directory>
const XML_TAG_TOOL_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/gi;
// DSML format: <｜DSML｜tool_calls><｜DSML｜invoke name="tool_name"><｜DSML｜parameter name="url" string="true">value</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>
const D = "(?:\\s*[｜|]\\s*)";
const DSML_TOOL_CALL_RE = new RegExp(`<\\s*${D}?DSML${D}tool_calls\\s*>([\\s\\S]*?)<\\/\\s*${D}?DSML${D}tool_calls\\s*>`, "gi");
const DSML_INVOKE_RE = new RegExp(`<\\s*${D}?DSML${D}invoke\\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\\s*>([\\s\\S]*?)<\\/\\s*${D}?DSML${D}invoke\\s*>`, "gi");
const DSML_PARAM_RE = new RegExp(`<\\s*${D}?DSML${D}parameter\\s+name="([^"]+)"(?:\\s+(string|number|boolean)="true")?\\s*>([\\s\\S]*?)<\\/\\s*${D}?DSML${D}parameter\\s*>`, "gi");
// Unclosed DSML invoke (model started but didn't close):
const DSML_INVOKE_UNCLOSED_RE = new RegExp(`<\\s*${D}?DSML${D}invoke\\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\\s*>([\\s\\S]*?)$`, "gi");
// Unclosed XML tool call: <tool_call>list_directory  or  <tool_code>read_file path="..."
// (many models emit <tool_call>/<tool_code> without a closing tag)
const XML_TOOL_CALL_UNCLOSED_RE = /<(?:tool_call|tool_code)>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\n([\s\S]*?))?$/gi;
// Strip think tags that some models emit (they're internal reasoning, not tool calls)
const THINK_TAGS_RE = /<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*?<\/(?:think|thinking|thought|reasoning|cot|details)>/gi;
// Also strip unclosed think tags (model starts thinking but never closes)
const THINK_UNCLOSED_RE = /<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*$/gi;
// Strip standalone closing think tags (model sends closing tag without opening tag)
const THINK_STANDALONE_CLOSE_RE = /<\/(?:think|thinking|thought|reasoning|cot|details)>/gi;
// Strip malformed opening think tags without a closing `>` (e.g. `<think` at line start or `<thinkI`)
// Some models output `<think\n\nHello` or `<thinkI have started` instead of `<think>Hello</think>`.
const THINK_MALFORMED_OPEN_RE = /^\s*<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?\s*/gim;
// Strip model self-instructions like "[Response interrupted by...]" and "[Only one tool...]"
const MODEL_SELF_INSTRUCTIONS_RE = /\[Response interrupted[^\]]*\]|\[Only one tool[^\]]*\]/gi;
// Strip tool result echoes — the model sometimes copies the tool result text
// from its history into the response. The persisted tool-result format is
// `<tool_result tool="..." ok="...">...</tool_result>` (XML, deliberately
// non-natural so the model is unlikely to echo it), but historically we also
// persisted `Tool "..." succeeded: ...` / `Tool "..." result (ok=true): ...`
// shapes. This single regex catches ALL of them:
//   - `Tool "..." result (ok=true): ...`
//   - `Tool "..." result(ok=...): ...`
//   - `Tool "..." result: ...`
//   - `Tool "..." succeeded: ...`
//   - `Tool "..." failed: ...`
const TOOL_RESULT_ECHO_RE =
  /^Tool\s+"[^"]+"\s+(?:result(?:\s*\(ok=[^)]*\))?\s*:|succeeded\s*:|failed\s*:).*$/gmi;
// Also strip the XML form if the model echoes it back verbatim (closed tag).
const TOOL_RESULT_XML_ECHO_RE = /<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi;
// Task 45 (Bug 4): Also catch UNCLOSED `<tool_result>` (model started but
// never closed the tag — happens when the response is cut mid-echo, or when
// the model just emits the opening tag as a "I'm about to write the tool
// result" prefix). Applied ONLY to the final iterContent (stripToolCallBlocks
// + parseToolCalls), NOT per-delta — otherwise a partial `<tool_result>` in
// one delta would strip everything that follows it.
const TOOL_RESULT_XML_UNCLOSED_ECHO_RE = /<tool_result[^>]*>[\s\S]*$/gi;
// Task 45 (Bug 4): Fenced code blocks whose language tag is `tool_result`
// (the model sometimes wraps the echoed tool result in a code fence).
// Closed and unclosed variants — unclosed is final-iterContent only.
const TOOL_RESULT_FENCE_ECHO_RE = /```tool_result\s*[\s\S]*?```/gi;
const TOOL_RESULT_FENCE_UNCLOSED_ECHO_RE = /```tool_result\s*[\s\S]*$/gi;
// Bare `tool_result:` prefix (another echo variant).
const TOOL_RESULT_PREFIX_ECHO_RE = /^tool_result\s*:.*$/gmi;

/** Strips safe (closed/line-anchored) tool-result echo patterns per streaming delta. */
function stripToolResultEchoesSafe(text: string): string {
  return text
    .replace(TOOL_RESULT_ECHO_RE, "")
    .replace(TOOL_RESULT_PREFIX_ECHO_RE, "")
    .replace(TOOL_RESULT_FENCE_ECHO_RE, "")
    .replace(TOOL_RESULT_XML_ECHO_RE, "");
}

/** Strips all tool-result echo patterns (including unclosed blocks) on completed iteration content. */
function stripToolResultEchoesFinal(text: string): string {
  return text
    .replace(TOOL_RESULT_ECHO_RE, "")
    .replace(TOOL_RESULT_PREFIX_ECHO_RE, "")
    .replace(TOOL_RESULT_FENCE_ECHO_RE, "")
    .replace(TOOL_RESULT_FENCE_UNCLOSED_ECHO_RE, "")
    .replace(TOOL_RESULT_XML_ECHO_RE, "")
    .replace(TOOL_RESULT_XML_UNCLOSED_ECHO_RE, "");
}

// Derive KNOWN_TOOL_NAMES dynamically from PUBLIC_BUILTIN_TOOLS so this list never
// goes stale when new tools are added to tools.ts. (Previously this was a
// hardcoded Set that had to be manually kept in sync — see Task 38-E.)
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  PUBLIC_BUILTIN_TOOLS.map((t) => t.name),
);

interface ParsedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  raw: string;
  startIndex: number;
  endIndex: number;
  thought_signature?: string;
  thoughtSignature?: string;
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse `key="value" key2="value2"` (or unquoted) into an args object. */
function parseKeyValueArgs(s: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  // Quoted values first.
  const quoted = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = quoted.exec(s)) !== null) {
    out[m[1]] = m[2];
    matched = true;
  }
  // Single-quoted values.
  const single = /(\w+)\s*=\s*'([^']*)'/g;
  while ((m = single.exec(s)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2];
    matched = true;
  }
  // Unquoted values (only for keys not already seen).
  const unquoted = /(\w+)\s*=\s*(\S+)/g;
  while ((m = unquoted.exec(s)) !== null) {
    if (!(m[1] in out)) {
      out[m[1]] = m[2];
      matched = true;
    }
  }
  return matched ? out : null;
}

function parseToolCalls(content: string): ParsedToolCall[] {
  // Strip <think>...</think> tags (and unclosed <think> tags) before parsing.
  // These are internal reasoning that some models emit — they interfere with
  // tool-call parsing.
  let cleanContent = content.replace(THINK_TAGS_RE, "");
  cleanContent = cleanContent.replace(THINK_UNCLOSED_RE, "");
  cleanContent = cleanContent.replace(THINK_MALFORMED_OPEN_RE, "");
  cleanContent = cleanContent.replace(THINK_STANDALONE_CLOSE_RE, "");
  cleanContent = cleanContent.replace(MODEL_SELF_INSTRUCTIONS_RE, "");
  // Strip tool result echoes (final pass — includes unclosed variants since
  // we have the full iterContent here).
  cleanContent = stripToolResultEchoesFinal(cleanContent);

  const results: ParsedToolCall[] = [];
  const taken: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);

  // 1. Canonical: fenced ```tool_call blocks containing {"tool":...,"args":{...}}
  const fenceMatches: Array<{ json: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_FENCE_RE.exec(cleanContent)) !== null) {
    fenceMatches.push({ json: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  for (const fm of fenceMatches) {
    const parsed = tryJson(fm.json);
    if (parsed && typeof parsed.tool === "string") {
      const args =
        parsed.args && typeof parsed.args === "object"
          ? (parsed.args as Record<string, unknown>)
          : {};
      results.push({
        toolName: parsed.tool,
        args,
        raw: content.slice(fm.start, fm.end),
        startIndex: fm.start,
        endIndex: fm.end,
      });
      taken.push([fm.start, fm.end]);
    }
  }

  // 2. Bare JSON {"tool":"...","args":{...}} anywhere in text.
  TOOL_CALL_JSON_RE.lastIndex = 0;
  while ((m = TOOL_CALL_JSON_RE.exec(cleanContent)) !== null) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const args = tryJson(m[2]);
    if (args) {
      results.push({
        toolName: m[1],
        args,
        raw: m[0],
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }

  // 2b. XML-style: <tool_call>{"tool":"name","args":{...}}</tool_call>
  XML_TOOL_CALL_RE.lastIndex = 0;
  while ((m = XML_TOOL_CALL_RE.exec(cleanContent)) !== null) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const parsed = tryJson(m[1].trim());
    if (parsed && typeof parsed.tool === "string") {
      const args =
        parsed.args && typeof parsed.args === "object"
          ? (parsed.args as Record<string, unknown>)
          : {};
      results.push({
        toolName: parsed.tool,
        args,
        raw: m[0],
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }

  // 2c. XML-tag-style: <list_directory><path>.</path></list_directory> or <read_file><path>src/math.ts</path></read_file>
  //     The tag name IS the tool name. Child tags are the args.
  XML_TAG_TOOL_RE.lastIndex = 0;
  while ((m = XML_TAG_TOOL_RE.exec(cleanContent)) !== null) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const tagName = m[1];
    if (!KNOWN_TOOL_NAMES.has(tagName)) continue;
    const inner = m[2];
    // Parse child XML tags as args: <path>src/math.ts</path> → { path: "src/math.ts" }
    const args: Record<string, unknown> = {};
    const childTagRe = /<(\w+)>([\s\S]*?)<\/\1>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = childTagRe.exec(inner)) !== null) {
      const key = cm[1];
      const val = cm[2].trim();
      // Try parsing as JSON first (for complex values), otherwise use as string.
      try {
        args[key] = JSON.parse(val);
      } catch {
        args[key] = val;
      }
    }
    // If no child tags found, try parsing the inner content as JSON.
    if (Object.keys(args).length === 0) {
      const innerJson = tryJson(inner.trim());
      if (innerJson) {
        Object.assign(args, innerJson);
      }
    }
    if (Object.keys(args).length > 0) {
      results.push({
        toolName: tagName,
        args,
        raw: m[0],
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }

  // 2c.1 Self-closing XML tags: <list_directory path="./"/>
  //     Some models (e.g. DeepSeek) use this format.
  const SELF_CLOSE_XML_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)\s+([^>]*?)\s*\/>/g;
  SELF_CLOSE_XML_RE.lastIndex = 0;
  while ((m = SELF_CLOSE_XML_RE.exec(cleanContent)) !== null) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const tagName = m[1];
    if (!KNOWN_TOOL_NAMES.has(tagName)) continue;
    const inner = m[2].trim();
    const args: Record<string, unknown> = {};
    if (inner) {
      const kvArgs = parseKeyValueArgs(inner);
      if (kvArgs) Object.assign(args, kvArgs);
    }
    results.push({
      toolName: tagName,
      args,
      raw: m[0],
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
    taken.push([m.index, m.index + m[0].length]);
  }

  // 2d. Unclosed XML: <tool_call>list_directory  or  <tool_call>read_file path="..."
  //     Many models emit <tool_call> without a closing </tool_call> tag.
  XML_TOOL_CALL_UNCLOSED_RE.lastIndex = 0;
  while ((m = XML_TOOL_CALL_UNCLOSED_RE.exec(cleanContent)) !== null) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const toolName = m[1];
    if (!KNOWN_TOOL_NAMES.has(toolName)) continue;
    const restArgs = m[2]?.trim() ?? "";
    let args: Record<string, unknown> = {};
    // Try JSON first
    if (restArgs) {
      const jsonArgs = tryJson(restArgs);
      if (jsonArgs) {
        args = jsonArgs;
      } else {
        // Try key="value" pairs
        const kvArgs = parseKeyValueArgs(restArgs);
        if (kvArgs) args = kvArgs;
      }
    }
    results.push({
      toolName,
      args,
      raw: m[0],
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
    taken.push([m.index, m.index + m[0].length]);
  }

  // 2e. DSML format: <｜DSML｜tool_calls><｜DSML｜invoke name="tool_name"><｜DSML｜parameter name="x" string="true">val</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>
  DSML_TOOL_CALL_RE.lastIndex = 0;
  while ((m = DSML_TOOL_CALL_RE.exec(cleanContent)) !== null) {
    const toolCallsBlock = m[1] ?? "";
    const blockStart = m.index;
    const blockEnd = m.index + m[0].length;
    if (overlaps(blockStart, blockEnd)) continue;

    let im: RegExpExecArray | null;
    DSML_INVOKE_RE.lastIndex = 0;
    while ((im = DSML_INVOKE_RE.exec(toolCallsBlock)) !== null) {
      const dsmlToolName = im[1];
      const paramsBlock = im[2] ?? "";
      const invokeStart = blockStart + im.index;
      const invokeEnd = blockStart + im.index + im[0].length;
      if (overlaps(invokeStart, invokeEnd)) continue;
      if (!KNOWN_TOOL_NAMES.has(dsmlToolName)) continue;

      const args: Record<string, unknown> = {};
      let pm: RegExpExecArray | null;
      DSML_PARAM_RE.lastIndex = 0;
      while ((pm = DSML_PARAM_RE.exec(paramsBlock)) !== null) {
        const pName = pm[1];
        const pType = pm[2] ?? "";
        const pRawValue = pm[3] ?? "";
        // Try to parse value appropriately based on type hint
        if (pType === "number") {
          const num = Number(pRawValue);
          args[pName] = isNaN(num) ? pRawValue : num;
        } else if (pType === "boolean") {
          args[pName] = pRawValue === "true" || pRawValue === "1";
        } else if (pType === "string" || pRawValue === "") {
          args[pName] = pRawValue;
        } else {
          // No type hint — try JSON.parse, fall back to string
          const parsed = tryJson(pRawValue);
          args[pName] = parsed ?? pRawValue;
        }
      }

      results.push({
        toolName: dsmlToolName,
        args,
        raw: cleanContent.slice(invokeStart, invokeEnd),
        startIndex: invokeStart,
        endIndex: invokeEnd,
      });
      taken.push([invokeStart, invokeEnd]);
    }
    // Mark entire block as taken to prevent inner content from being parsed again
    taken.push([blockStart, blockEnd]);
  }

  // 3. Lenient: any fenced code block whose language tag is a known tool name,
  //    OR whose body begins with `// <tool_name>` / `# <tool_name>` followed by
  //    a JSON object, OR whose body's first token is a known tool name followed
  //    by `key="value"` pairs. This catches the real-world model output where
  //    the model writes ```typescript\n// edit_file\n{...}```, ```bash\nrun_command command="..."\n```,
  //    etc., instead of the canonical ```tool_call format.
  ANY_FENCE_RE.lastIndex = 0;
  while ((m = ANY_FENCE_RE.exec(cleanContent)) !== null) {
    const lang = (m[1] || "").trim();
    const body = (m[2] || "").trim();
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) continue;

    let toolName: string | null = null;
    let argsRaw = body;

    // 3a. Language tag is a known tool name.
    if (KNOWN_TOOL_NAMES.has(lang)) {
      toolName = lang;
    } else {
      // 3b. Leading comment names a known tool.
      const cm = LEADING_TOOL_COMMENT_RE.exec(body);
      if (cm && KNOWN_TOOL_NAMES.has(cm[1])) {
        toolName = cm[1];
        argsRaw = cm[2].trim();
      } else {
        // 3c. The body LEADS with a known tool name (e.g.
        //     `edit_file path="..."`, `edit_file(\n  path="..."\n)`,
        //     `run_command(command="...")`). Match the leading identifier only
        //     so trailing "(" or args don't disqualify it.
        const leadMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(body);
        if (leadMatch && KNOWN_TOOL_NAMES.has(leadMatch[1])) {
          toolName = leadMatch[1];
          argsRaw = body.slice(leadMatch[0].length).trim();
        }
      }
    }
    if (!toolName) {
      // 3d. JSON with a "command" OR "tool" field naming a tool, with flat args
      //     (e.g. {"tool":"edit_file","path":"...","find":"...","replace":"..."}).
      //     The model sometimes puts args at the top level instead of in "args".
      const asJson = tryJson(body);
      if (asJson && typeof asJson === "object" && !Array.isArray(asJson)) {
        const toolFieldEntries: [string, unknown][] = [
          ["tool", asJson.tool],
          ["name", asJson.name],
          ["tool_name", asJson.tool_name],
          ["toolName", asJson.toolName],
          ["action", asJson.action],
          ["function", asJson.function],
          ["command", asJson.command],
        ];
        const foundEntry = toolFieldEntries.find(
          (entry): entry is [string, string] => typeof entry[1] === "string" && KNOWN_TOOL_NAMES.has(entry[1]),
        );
        if (foundEntry) {
          const [fieldName] = foundEntry;
          toolName = foundEntry[1];
          let extractedArgs: Record<string, unknown>;
          if (asJson.args && typeof asJson.args === "object" && !Array.isArray(asJson.args)) {
            extractedArgs = asJson.args as Record<string, unknown>;
          } else if (asJson.arguments && typeof asJson.arguments === "object" && !Array.isArray(asJson.arguments)) {
            extractedArgs = asJson.arguments as Record<string, unknown>;
          } else {
            const { [fieldName]: _identified, ...rest } = asJson as Record<string, unknown>;
            if ("command" in rest && rest.command === toolName) {
              const { command: _cmd, ...rest2 } = rest;
              extractedArgs = rest2;
            } else {
              extractedArgs = rest;
            }
          }
          results.push({
            toolName,
            args: extractedArgs,
            raw: cleanContent.slice(start, end),
            startIndex: start,
            endIndex: end,
          });
          taken.push([start, end]);
          continue;
        }
      }
    }
    if (!toolName) continue;

    // Parse args: try JSON first, then key="value" / key=value pairs.
    const cleaned = argsRaw.replace(/,\s*$/, "");
    let args = tryJson(cleaned);
    if (!args) {
      args = parseKeyValueArgs(argsRaw);
    }
    if (!args) continue;

    results.push({
      toolName,
      args,
      raw: content.slice(start, end),
      startIndex: start,
      endIndex: end,
    });
    taken.push([start, end]);
  }

  results.sort((a, b) => a.startIndex - b.startIndex);
  return results;
}

function stripToolCallBlocks(content: string): string {
  let out = content.replace(THINK_TAGS_RE, "");
  out = out.replace(THINK_UNCLOSED_RE, "");
  out = out.replace(THINK_MALFORMED_OPEN_RE, "");
  out = out.replace(THINK_STANDALONE_CLOSE_RE, "");
  out = out.replace(MODEL_SELF_INSTRUCTIONS_RE, "");
  // Strip tool result echoes (final pass — includes unclosed variants since
  // we have the full iterContent here).
  out = stripToolResultEchoesFinal(out);
  out = out.replace(TOOL_CALL_FENCE_RE, "");
  out = out.replace(TOOL_CALL_JSON_RE, "");
  out = out.replace(XML_TOOL_CALL_RE, "");
  out = out.replace(XML_TAG_TOOL_RE, (full, tagName: string) => {
    if (KNOWN_TOOL_NAMES.has(tagName)) return "";
    return full;
  });
  out = out.replace(XML_TOOL_CALL_UNCLOSED_RE, "");
  // Strip self-closing XML tool calls: <list_directory path="./"/>
  out = out.replace(/<([a-zA-Z_][a-zA-Z0-9_]*)\s+[^>]*?\/>/g, (full, tagName: string) => {
    if (KNOWN_TOOL_NAMES.has(tagName)) return "";
    return full;
  });
  out = out.replace(DSML_TOOL_CALL_RE, "");
  // Strip lenient fenced tool blocks (language = tool name, leading tool
  // comment, first token = tool name, or JSON with "command" field).
  out = out.replace(ANY_FENCE_RE, (full, lang: string, body: string) => {
    const l = (lang || "").trim();
    if (KNOWN_TOOL_NAMES.has(l)) return "";
    const b = (body || "").trim();
    const cm = LEADING_TOOL_COMMENT_RE.exec(b);
    if (cm && KNOWN_TOOL_NAMES.has(cm[1])) return "";
    const leadMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(b);
    if (leadMatch && KNOWN_TOOL_NAMES.has(leadMatch[1])) return "";
    // JSON with a field naming a tool
    const asJson = tryJson(b);
    if (asJson && typeof asJson === "object") {
      const possibleToolFields = [asJson.tool, asJson.name, asJson.tool_name, asJson.toolName, asJson.action, asJson.function, asJson.command];
      if (possibleToolFields.some((f) => typeof f === "string" && KNOWN_TOOL_NAMES.has(f as string))) return "";
    }
    return full;
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// The free-tier model sometimes narrates a tool call instead of emitting
// it in the parseable ```tool_call fenced format. detectToolAttempt() looks
// for tell-tale signs — a known tool name followed by `(` or `{`, or a
// fenced code block whose language tag or body leads with a known tool
// name — and the agent loop uses it to give the model ONE chance to retry
// with the correct format (only on iter 0, only once per executeChat run).

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function detectToolAttempt(content: string): boolean {
  if (!content) return false;
  const clean = content.replace(THINK_TAGS_RE, "").replace(THINK_UNCLOSED_RE, "").replace(THINK_STANDALONE_CLOSE_RE, "").replace(THINK_MALFORMED_OPEN_RE, "");
  // Pattern 1 & 2: a known tool name followed by `(` or `{` (with optional
  // whitespace) anywhere in the response. Catches both `edit_file(\n  ...`
  // and `edit_file { ... }` styles.
  for (const name of KNOWN_TOOL_NAMES) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\s*[\\(\\{]`);
    if (re.test(clean)) return true;
  }
  // Pattern 3: a fenced code block whose language tag is a known tool name.
  ANY_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_FENCE_RE.exec(clean)) !== null) {
    const lang = (m[1] || "").trim();
    if (KNOWN_TOOL_NAMES.has(lang)) return true;
  }
  // Pattern 4: Narration of unexecuted action intent (e.g. "I'll start by creating", "currently executing the refactor", "I will create")
  const narrationRegex = /(?:currently executing|start by creating|will create|going to edit|will refactor|will update you as soon as|start by refactoring|creating the directory|executing the refactor)/i;
  if (narrationRegex.test(clean)) return true;

  return false;
}

const TOOL_NUDGE_MESSAGE = `Note: Your previous response did not use the required tool_call format. To call a tool, emit a fenced block EXACTLY in this format:

\`\`\`tool_call
{"tool":"<name>","args":{...}}
\`\`\`

Please retry your last action using the correct format.`;

/** Native tool call accumulated from streamed OpenAI function deltas. */
export interface NativeToolCall {
  id: string;
  name: string;
  arguments: string;
  thought_signature?: string;
  thoughtSignature?: string;
}

type StreamChunk =
  | { type: "content"; text: string }
  | { type: "thinking"; text: string }
  | { type: "signature"; signature: string }
  | { type: "tool_calls"; calls: NativeToolCall[] }
  | { type: "finish"; reason: string }
  | { type: "tools_rejected" }
  | { type: "usage"; usage: MeasuredUsage };

export type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** OpenAI-format message with tool_calls and tool_call_id for conversation history. */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | OpenAIContentBlock[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  cache_control?: { type: "ephemeral" };
  /** Verbatim thinking text echoed on assistant turns (required by DeepSeek/Puter APIs). */
  reasoning_content?: string;
}

/** Anthropic-format content block supporting text, image, tool_use, and tool_result. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Builds OpenAI function-calling tools schema array. */
function buildOpenAITools(
  enabledToolNames: string[],
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return PUBLIC_BUILTIN_TOOLS.filter((t) => enabledToolNames.includes(t.name)).map(
    (t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }),
  );
}

/** Builds Anthropic tools schema array. */
function buildAnthropicTools(
  enabledToolNames: string[],
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return PUBLIC_BUILTIN_TOOLS.filter((t) => enabledToolNames.includes(t.name)).map(
    (t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }),
  );
}

/** Max chars the BufferedToolCallStream will hold back while waiting for a
 *  tool-call closing fence. Configurable via HERMOS_STREAM_BUFFER_LIMIT.
 *  Default: 100_000 (≈100KB — sufficient for any realistic tool payload
 *  while preventing multi-second UI stalls on very large writes). */
const STREAM_BUFFER_HOLD_LIMIT: number = (() => {
  const raw = process.env.HERMOS_STREAM_BUFFER_LIMIT;
  if (!raw) return 100_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();

/** Buffers partial streaming output to hide incomplete tool-call syntax before emitting to the client. */
class BufferedToolCallStream {
  private fullText = "";
  private emittedUpTo = 0;
  /** Match a tool-call start in the unemitted tail. */
  private static readonly START_RE = STREAM_TOOL_START_RE;
  /** Match a complete tool-call block (used to find the close). */
  private static readonly COMPLETE_RE = STREAM_TOOL_COMPLETE_RE;

  /** Push a delta. Returns the portion that is safe to emit to the frontend now. */
  push(delta: string): string {
    this.fullText += delta;
    return this.drainTail();
  }

  /** Walk the unemitted tail and emit completed prose outside tool-call blocks. */
  private drainTail(): string {
    let out = "";
    // Loop until the tail has no start pattern, or the start pattern is
    // followed by a complete block, or we hit the 500-char hold limit.
    while (true) {
      const tail = this.fullText.slice(this.emittedUpTo);
      const startIdx = tail.search(BufferedToolCallStream.START_RE);
      if (startIdx === -1) {
        // No tool-call start in the tail — emit everything.
        out += tail;
        this.emittedUpTo = this.fullText.length;
        return out;
      }
      // Emit text before the start.
      out += tail.slice(0, startIdx);
      this.emittedUpTo += startIdx;
      const fromStart = this.fullText.slice(this.emittedUpTo);
      // Look for a complete tool-call block starting at the start position.
      BufferedToolCallStream.COMPLETE_RE.lastIndex = 0;
      const m = BufferedToolCallStream.COMPLETE_RE.exec(fromStart);
      if (m && m.index === 0) {
        // The block is complete. Skip it (it stays in fullText but is not
        // emitted as a content delta — parseToolCalls will find it later).
        this.emittedUpTo += m[0].length;
        // Loop: drainTail again to handle text after the block.
        continue;
      }
      // Incomplete block — hold back while the model generates the tool call payload.
      // Use a generous 500,000 char threshold so long file operations (like 200/1000-line write_file)
      // are not prematurely flushed into content prose mid-stream.
      if (fromStart.length > STREAM_BUFFER_HOLD_LIMIT) {
        out += fromStart;
        this.emittedUpTo = this.fullText.length;
        return out;
      }
      // Hold back — wait for more deltas.
      return out;
    }
  }

  /**
   * Flush at end-of-stream. If a tool-call block was started but never
   * closed, emit it as plain content (so the user sees what the model
   * actually produced rather than a silent drop).
   */
  flush(): string {
    const remaining = this.fullText.slice(this.emittedUpTo);
    this.emittedUpTo = this.fullText.length;
    return remaining;
  }

  /** The full accumulated text (including tool-call blocks). */
  getFullText(): string {
    return this.fullText;
  }
}

/**
 * Auto-disable a model that returned 404 (dead endpoint). Sets `enabled: false`
 * in the ProviderKey.models column so it disappears from the model selector
 * on next refresh. Best-effort — errors are silently swallowed.
 */
async function disableDeadModel(
  userId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  try {
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId, provider: provider as any } },
    });
    if (!row?.models) return;
    const models = JSON.parse(row.models) as Array<{ id: string; enabled?: boolean }>;
    const target = models.find((m) => m.id === modelId);
    if (!target || target.enabled === false) return;
    target.enabled = false;
    await db.providerKey.update({
      where: { id: row.id },
      data: { models: JSON.stringify(models) },
    });
    console.warn(`[executor] Auto-disabled dead model ${provider}/${modelId} (404)`);
  } catch {
    /* best-effort */
  }
}

async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  temperature?: number,
  signal?: AbortSignal,
  plan?: ReasoningPlan,
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  maxTokens?: number,
  providerId?: string,
): AsyncGenerator<StreamChunk> {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";

  const isOpenRouter = providerId === "openrouter" || url.includes("openrouter.ai");
  // Error-envelope matching below is format-specific, so recognize the real
  // gateway endpoint too — a Groq API key can be wired through a custom base
  // URL, and providerId alone would miss the recovery/retry path.
  const isGroq = plan?.scheme === "groq_effort" || providerId === "groq" || url.includes("api.groq.com");

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };
  if (temperature !== undefined) body.temperature = temperature;
  // max_tokens is the output limit. Use the model catalog's per-model value
  // when available. If the caller provides an explicit value (from provider API
  // metadata), use it. Otherwise omit the field entirely — the provider enforces
  // its own per-model limit and will not return an empty response.
  configureRequestBody({
    providerId,
    model,
    body,
    reasoningParams: plan?.kind === "params" ? plan.params : undefined,
    extraBody: plan?.kind === "params" ? plan.extraBody : undefined,
    maxTokens,
    tools,
  });

  // Ask OpenAI-compatible providers to include a final `usage` object in the
  // stream (documented `stream_options` parameter). Not all gateways support
  // it: when a gateway has previously 400'd on the flag we SKIP it entirely
  // (no repeated full-request retry → no per-message latency) and usage simply
  // falls back to "not reported".
  if (!isStreamOptionsRejected(baseUrl) && (providerId === "openai" || providerId === "openrouter")) {
    body.stream_options = { include_usage: true };
  }

  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (apiKey && apiKey !== "not-needed") {
    defaultHeaders.Authorization = `Bearer ${apiKey}`;
  }

  let resp = await safeProviderFetch(url, {
    method: "POST",
    headers: defaultHeaders,
    cache: "no-store",
    body: JSON.stringify(body),
    signal,
  });

  // Automatic retry fallback if the provider endpoint rejected reasoning parameters with 400/405/422.
  // The STRIP is a safety net for every scheme; the LEARNING is gated on the
  // behavioral schemes only (see learn.ts) — a confirmed 400/422 on a documented
  // provider surface (e.g. `reasoning_effort: "none"` on a pre-gpt-5.1
  // model) must not mark the model as rejecting for the process lifetime.
  if ((resp.status === 400 || resp.status === 405 || resp.status === 422) && (body.reasoning_effort || body.reasoning || body.thinkingConfig)) {
    sanitizeRejectedReasoningParams(body);
    resp = await safeProviderFetch(url, {
      method: "POST",
      headers: defaultHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
      signal,
    });
    if (resp.ok && isBehavioralScheme(plan?.scheme)) {
      rememberReasoningRejected(baseUrl);
      rememberModelRejectsReasoning(baseUrl, model);
    }
  }

  // Some providers reject the `stream_options` argument outright with 400 or 422.
  // Strip it and retry so measured usage simply falls back to "not reported"
  // rather than failing the request. The host is remembered so the retry cost
  // is paid once per gateway, not on every message.
  if ((resp.status === 400 || resp.status === 405 || resp.status === 422) && body.stream_options) {
    delete body.stream_options;
    markStreamOptionsRejected(baseUrl);
    resp = await safeProviderFetch(url, {
      method: "POST",
      headers: defaultHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
      signal,
    });
  }

  if (!resp.ok || !resp.body) {
    let text = await resp.text().catch(() => "");
    
    if (isOpenRouter || isGroq) {
      if (isOpenRouter && (resp.status === 402 || resp.status === 400)) {
        const limitMatch = text.match(/can only afford (\d+)/i);
        const promptLimitMatch = text.match(/Prompt tokens limit exceeded:\s*(\d+)\s*>\s*(\d+)/i);
        const contextLimitMatch = text.match(/maximum context length is (\d+).*?requested about (\d+).*?(\d+)\s+of\s+text\s+input(?:,\s*(\d+)\s+of\s+tool\s+input)?,\s*(\d+)\s+in\s+the\s+output/i);

        if (limitMatch) {
          const limit = parseInt(limitMatch[1], 10);
          const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : 4096;
          const capped = Math.min(currentMax, limit);
          console.warn(
            `[executor] OpenRouter 402: max_tokens exceeds account limit ${limit}, retrying with ${capped}`
          );
          body.max_tokens = capped;
          resp = await safeProviderFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
          if (resp.ok && resp.body) {
            // success on retry, continue below
          } else {
            const retryText = await resp.text().catch(() => "");
            throwProviderError(resp, retryText);
          }
        } else if (promptLimitMatch) {
          const promptTokens = parseInt(promptLimitMatch[1], 10);
          const limit = parseInt(promptLimitMatch[2], 10);
          const allowedOutput = Math.max(1, limit - promptTokens);
          const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : allowedOutput;
          const capped = Math.min(currentMax, allowedOutput);
          console.warn(
            `[executor] OpenRouter 402: prompt tokens ${promptTokens} exceeds account limit ${limit}, capping max_tokens to ${capped}`
          );
          body.max_tokens = capped;
          resp = await safeProviderFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
          if (resp.ok && resp.body) {
            // success on retry
          } else {
            const retryText = await resp.text().catch(() => "");
            throwProviderError(resp, retryText);
          }
        } else if (contextLimitMatch) {
          const limit = parseInt(contextLimitMatch[1], 10);
          const textInput = parseInt(contextLimitMatch[3], 10);
          const toolInput = contextLimitMatch[4] ? parseInt(contextLimitMatch[4], 10) : 0;
          const totalInput = textInput + toolInput;
          const allowedOutput = Math.max(1, limit - totalInput);
          const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : allowedOutput;
          const capped = Math.min(currentMax, allowedOutput);
          console.warn(
            `[executor] OpenRouter 400: prompt + output exceeds context window, capping max_tokens to ${capped}`
          );
          body.max_tokens = capped;
          resp = await safeProviderFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
          if (resp.ok && resp.body) {
            // success on retry
          } else {
            const retryText = await resp.text().catch(() => "");
            throwProviderError(resp, retryText);
          }
        }
      }
      if (isGroq && (resp.status === 400 || resp.status === 413)) {
        // Groq TPM (tokens-per-minute) rate limit. The quota is a per-minute
        // total (prompt + output), so the retry must send LESS: trim the
        // prompt to the budget and cap max_tokens to the leftover, then retry
        // ONCE. If even the irreducible core can't fit, fail with an
        // actionable message rather than send a maimed prompt.
        const tpm = recoverGroqTpmRateLimit(body as Record<string, unknown>, text, resp.status, "[executor]");
        if (tpm.isTpmError) {
          resp = await safeProviderFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
          if (!resp.ok || !resp.body) {
            const retryText = await resp.text().catch(() => "");
            throwProviderError(resp, retryText);
          }
        }
        const groqLimitMatch = text.match(/maximum context length is (\d+) tokens.*?requested (\d+) tokens \((\d+) in the messages, (\d+) in the completion_length\)/i);
        if (groqLimitMatch) {
          const limit = parseInt(groqLimitMatch[1], 10);
          const promptTokens = parseInt(groqLimitMatch[3], 10);
          const allowedOutput = Math.max(1, limit - promptTokens);
          const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : allowedOutput;
          const capped = Math.min(currentMax, allowedOutput);
          console.warn(
            `[executor] Groq 400/413: prompt tokens ${promptTokens} exceeds context limit ${limit}, capping max_tokens to ${capped}`
          );
          body.max_tokens = capped;
          resp = await safeProviderFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
          if (resp.ok && resp.body) {
            // success on retry
          } else {
            const retryText = await resp.text().catch(() => "");
            throwProviderError(resp, retryText);
          }
        }
      }
    }

    const standardContextMatch = text.match(/maximum context length is (\d+).*?requested (\d+) output tokens.*?prompt contains (?:at least )?(\d+)\s+(?:input tokens|characters)/i);
    if (standardContextMatch && (resp.status === 400 || resp.status === 422)) {
      const limit = parseInt(standardContextMatch[1], 10);
      const promptTokens = parseInt(standardContextMatch[3], 10);
      const allowedOutput = Math.max(1, limit - promptTokens);
      const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : allowedOutput;
      const capped = Math.min(currentMax, allowedOutput);
      console.warn(
        `[executor] Provider 400: prompt + output exceeds context window (${limit}), capping max_tokens to ${capped}`,
      );
      body.max_tokens = capped;
      resp = await safeProviderFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) text = await resp.text().catch(() => "");
    }

  // If the reasoning-param retry still returned 400/405/422 and we had tools,
  // retry WITHOUT tools (some providers/models reject the tools parameter).
  if (!resp.ok && (resp.status === 400 || resp.status === 405 || resp.status === 422) && body.tools) {
    delete body.tools;
    delete body.tool_choice;
    resp = await safeProviderFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (resp.ok && resp.body) {
      yield { type: "tools_rejected" };
    }
  }

  if (!resp.ok || !resp.body) {
      const err = new Error(
        `Provider returned ${resp.status}: ${stripHtml(text.slice(0, 500)) || resp.statusText}`,
      );
      (err as Error & { status?: number }).status = resp.status;
      (err as Error & { responseBody?: string }).responseBody = text.slice(0, 1000);
      const retryHeader =
        resp.headers.get("retry-after") ||
        resp.headers.get("x-ratelimit-reset") ||
        resp.headers.get("ratelimit-reset") ||
        resp.headers.get("x-ratelimit-reset-requests") ||
        resp.headers.get("x-ratelimit-reset-tokens");
      const retryAfterMs = parseRetryHeader(retryHeader);
      if (retryAfterMs !== null) {
        (err as any).retryAfterMs = retryAfterMs;
        (err as any).retryAfter = retryHeader;
      }
      console.warn(
        `[executor] upstream ${resp.status} from ${url} model=${model} body=${text.slice(0, 800)}`,
      );
      throw err;
    }
  }
  // Some provider endpoints return a JSON response even when `stream: true`
  // is set (e.g. certain models for cold-start requests). Detect
  // this by Content-Type and handle it inline to avoid silent empty responses
  // from trying to parse JSON as SSE.
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("text/event-stream")) {
    const fullBody = await resp.text();
    const parsed = parseNonStreamingResponse(fullBody);
    if (parsed) {
      if (parsed.thinking) yield { type: "thinking", text: parsed.thinking };
      if (parsed.content) yield { type: "content", text: parsed.content };
      if (parsed.toolCalls?.length) yield { type: "tool_calls", calls: parsed.toolCalls };
    }
    const usage = extractOpenAIUsage((JSON.parse(fullBody) as any)?.usage);
    if (usage) yield { type: "usage", usage };
    return;
  }
  // Content-Type is text/event-stream or absent — read as SSE.

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Native tool-call accumulator (same scheme as the free-tier path).
  const toolCallAccumulator = new Map<
    number,
    {
      id: string;
      name: string;
      args: string;
      thought_signature?: string;
      thoughtSignature?: string;
    }
  >();
  let sawToolCalls = false;
  // Buffer to detect and split <think>…</think> tags that some models
  // (e.g. stepfun, deepseek, qwen) emit inside delta.content
  // rather than the reasoning_content field.
  // OpenCode's approach: handle think-tags universally for ALL models via a
  // streaming state machine — no per-model name detection needed.
  // The opening/closing tags may arrive across separate SSE chunks, so we
  // buffer until we see the closing tag.
  let thinkBuf = "";
  let inThink = false;
  // Track whether the PREVIOUS delta had reasoning_content. When true,
  // the next content delta may still be thinking (not the actual response).
  let prevHadReasoning = false;
  // Content held back for one delta to determine if it's thinking or response.
  let pendingContent = "";
  // Upstream finish_reason from the final SSE frame — surfaced so the caller
  // can distinguish budget exhaustion (`length`) from a normal stop.
  let finishReason: string | undefined;
  // Measured usage reported by the provider (last usage object seen wins).
  let openaiUsage: MeasuredUsage | undefined;

  const READ_TIMEOUT_MS = 300_000;

  while (true) {
    let timeoutId: NodeJS.Timeout | undefined;
    const readPromise = reader.read();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Stream idle timeout: No chunk received for 5 minutes."));
      }, READ_TIMEOUT_MS);
    });

    let res: ReadableStreamReadResult<Uint8Array>;
    try {
      res = await Promise.race([readPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const { value, done } = res;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        // Yield the upstream finish_reason so callers can detect budget
        // exhaustion (`length`) vs. a normal stop.
        if (finishReason) yield { type: "finish", reason: finishReason };
        // Yield measured usage exactly once, at stream end.
        if (openaiUsage) yield { type: "usage", usage: openaiUsage };
        // Yield accumulated tool calls before returning.
        if (sawToolCalls && toolCallAccumulator.size > 0) {
          const calls = Array.from(toolCallAccumulator.entries())
            .sort(([a], [b]) => a - b)
            .map(([, v]) => ({
              id: v.id,
              name: v.name,
              arguments: v.args,
              thought_signature: v.thought_signature,
              thoughtSignature: v.thoughtSignature,
            }))
            .filter((c) => c.name.trim().length > 0); // some providers (e.g. puter) send empty tool_calls in every SSE response — skip those
          if (calls.length === 0) {
            sawToolCalls = false;
          } else {
            yield { type: "tool_calls", calls };
          }
        }
        return;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // malformed line — skip
      }
      // Some gateways return HTTP 200 with an SSE error
      // frame (`data: {"error": ...}`) instead of a 4xx/5xx status. Surface
      // the real reason instead of silently producing an "empty response".
      if (json?.error) {
        const err = new Error(`Provider error: ${extractUpstreamError(json.error)}`) as Error & {
          status?: number;
          statuslessUpstream?: boolean;
        };
        if (typeof json.error?.status === "number") err.status = json.error.status;
        // Some gateways reject request-shape problems — `reasoning_effort`
        // outside the model's official vocabulary, `max_tokens` above the
        // documented cap, missing mandatory `reasoning_content` echo — with
        // this statusless frame ("Internal server error"). Flag it so the
        // retry ladder can probe a stripped request; the bare message alone
        // cannot distinguish a parameter rejection from a genuine outage.
        if (err.status === undefined) err.statuslessUpstream = true;
        throw err;
      }
      const finishReasonFrame = json?.choices?.[0]?.finish_reason;
      if (typeof finishReasonFrame === "string") finishReason = finishReasonFrame;
      if (json?.usage) {
        const usage = extractOpenAIUsage(json.usage);
        if (usage) openaiUsage = usage;
      }
      const delta = json?.choices?.[0]?.delta;
      if (!delta) {
        // A usage-only frame (choices: []) may arrive once streaming is done.
        // Capture it now; the chunk is yielded exactly once at stream end.
        continue;
      }
      try {
        // Native tool-call deltas — accumulate.
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          sawToolCalls = true;
          for (let tcIdx = 0; tcIdx < delta.tool_calls.length; tcIdx++) {
            const tc = delta.tool_calls[tcIdx];
            let key = typeof tc.index === "number" ? tc.index : tcIdx;
            let existing = toolCallAccumulator.get(key);

            // If existing tool call has a distinct name or different ID, treat as new tool call
            if (existing && existing.name && tc.function?.name && existing.name !== tc.function.name && !tc.function.name.startsWith(existing.name) && !existing.name.startsWith(tc.function.name)) {
              key = toolCallAccumulator.size;
              existing = undefined;
            }

            if (!existing) {
              existing = { id: "", name: "", args: "" };
            }

            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) {
              if (!existing.name) {
                existing.name = tc.function.name;
              } else if (tc.function.name !== existing.name && tc.function.name.startsWith(existing.name)) {
                existing.name = tc.function.name;
              } else if (tc.function.name !== existing.name && !existing.name.startsWith(tc.function.name)) {
                existing.name = tc.function.name; // replace, never concatenate different tool names
              }
            }
            if (tc.function?.arguments) existing.args += tc.function.arguments;
            if (tc.thought_signature) existing.thought_signature = tc.thought_signature;
            if (tc.thoughtSignature) existing.thoughtSignature = tc.thoughtSignature;
            if (tc.function?.thought_signature) existing.thought_signature = tc.function.thought_signature;
            if (tc.function?.thoughtSignature) existing.thoughtSignature = tc.function.thoughtSignature;
            if (tc.extra_content?.google?.thought_signature) {
              existing.thought_signature = tc.extra_content.google.thought_signature;
            }
            if (tc.extra_content?.google?.thoughtSignature) {
              existing.thoughtSignature = tc.extra_content.google.thoughtSignature;
            }
            toolCallAccumulator.set(key, existing);
          }
          continue;
        }

        // Check for reasoning content from ANY provider property variant
        // (delta.reasoning_content, delta.reasoning, delta.thinking, delta.reasoning_text).
        const { reasoningDelta, contentDelta } = parseSseReasoningChunk(delta);

        if (reasoningDelta) {
          if (pendingContent) {
            yield { type: "thinking", text: pendingContent };
            pendingContent = "";
          }
          prevHadReasoning = true;
          yield { type: "thinking", text: reasoningDelta };
        }

        const reasoningThisChunk = !!reasoningDelta;

        if (contentDelta) {
          const text = contentDelta;

          const openMatch = text.match(/<(?:think|thinking|thought|reasoning|cot|details)>/i);
          const closeMatch = text.match(/<\/(?:think|thinking|thought|reasoning|cot|details)>/i);

          if (inThink) {
            if (closeMatch && closeMatch.index !== undefined) {
              const closeTagLen = closeMatch[0].length;
              const thinkPart = text.slice(0, closeMatch.index);
              if (thinkPart) yield { type: "thinking", text: thinkPart };
              thinkBuf = "";
              inThink = false;
              prevHadReasoning = false;
              pendingContent = "";
              const rest = text.slice(closeMatch.index + closeTagLen);
              if (rest) yield { type: "content", text: rest };
            } else {
              thinkBuf += text;
              yield { type: "thinking", text };
            }
          } else {
            if (openMatch && openMatch.index !== undefined) {
              const openTagLen = openMatch[0].length;
              const before = text.slice(0, openMatch.index);
              if (before && !prevHadReasoning) yield { type: "content", text: before };
              prevHadReasoning = false;
              const afterOpen = text.slice(openMatch.index + openTagLen);
              const closeInAfter = afterOpen.match(/<\/(?:think|thinking|thought|reasoning|cot|details)>/i);
              if (closeInAfter && closeInAfter.index !== undefined) {
                const thinkText = afterOpen.slice(0, closeInAfter.index);
                if (thinkText) yield { type: "thinking", text: thinkText };
                const rest = afterOpen.slice(closeInAfter.index + closeInAfter[0].length);
                if (rest) yield { type: "content", text: rest };
              } else {
                inThink = true;
                thinkBuf = afterOpen;
                if (afterOpen) yield { type: "thinking", text: afterOpen };
              }
            } else if (closeMatch && closeMatch.index !== undefined) {
              const thinkText = text.slice(0, closeMatch.index).replace(/<(?:think|thinking|thought|reasoning|cot|details)>|<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");
              if (thinkText) yield { type: "thinking", text: thinkText };
              thinkBuf = "";
              pendingContent = "";
              inThink = false;
              prevHadReasoning = false;
              const rest = text.slice(closeMatch.index + closeMatch[0].length);
              if (rest) yield { type: "content", text: rest };
            } else if (prevHadReasoning && !reasoningThisChunk) {
              if (pendingContent) {
                yield { type: "thinking", text: pendingContent };
                pendingContent = "";
              }
              prevHadReasoning = false;
              yield { type: "content", text };
            } else if (prevHadReasoning) {
              prevHadReasoning = false;
              yield { type: "content", text };
            } else if (pendingContent) {
              pendingContent += text;
            } else {
              yield { type: "content", text };
            }
          }
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }
  // Flush un-yielded pending content at end-of-stream.
  if (pendingContent) {
    yield { type: "content", text: pendingContent };
  }
  // Yield any accumulated tool calls at end-of-stream.
  if (sawToolCalls && toolCallAccumulator.size > 0) {
    const calls = Array.from(toolCallAccumulator.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        name: v.name,
        arguments: v.args,
        thought_signature: v.thought_signature,
        thoughtSignature: v.thoughtSignature,
      }));
    yield { type: "tool_calls", calls };
  }
  if (finishReason) yield { type: "finish", reason: finishReason };
  if (openaiUsage) yield { type: "usage", usage: openaiUsage };
}

/** Converts LoadedMessage history to strict alternating Anthropic messages with tool_use and tool_result blocks. */
function toAnthropicMessages(
  history: LoadedMessage[],
  imageData?: ResolvedImageData,
  supportsVision?: boolean,
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  // Track tool_use IDs that have been EMITTED in an assistant message in
  // `out` so far. A `tool_result` block may only be appended AFTER its
  // corresponding `tool_use` block has been pushed in a preceding
  // assistant message — otherwise Anthropic rejects with "tool role
  // message without a previous assistant message with a tool call".
  const emittedToolUseIds = new Set<string>();

  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      // Only emit a tool result if a matching tool_use has already been
      // pushed in the output sequence.
      if (!m.toolCallId || !emittedToolUseIds.has(m.toolCallId)) {
        continue; // Skip orphan, pre-order, or unmatched tool result
      }
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.thinking && m.thinking.trim()) {
        const sig =
          m.thoughtSignature ||
          m.toolCalls?.[0]?.thoughtSignature ||
          m.toolCalls?.[0]?.thought_signature ||
          (m as any).thought_signature;
        if (sig) {
          blocks.push({ type: "thinking" as any, thinking: m.thinking, signature: sig } as any);
        } else {
          // No valid signature — Anthropic would reject dummy_sig, so emit thinking as a text block instead
          blocks.push({ type: "text", text: `<thinking>${m.thinking}</thinking>` } as any);
        }
      }
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          if (tc.id) emittedToolUseIds.add(tc.id);
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }
    if (m.role === "user") {
      // Build content blocks with optional image data
      let blocks: AnthropicContentBlock[] | undefined;
      if (supportsVision && imageData && imageData.size > 0 && m.attachments) {
        try {
          const atts = JSON.parse(m.attachments) as Array<{ id: string; type: string }>;
          const imgAtts = atts.filter((a) => a.type.startsWith("image/"));
          if (imgAtts.length > 0) {
            blocks = [];
            if (m.content?.trim()) {
              blocks.push({ type: "text", text: m.content });
            }
            for (const ia of imgAtts) {
              const img = imageData.get(ia.id);
              if (img) {
                blocks.push({
                  type: "image",
                  source: { type: "base64", media_type: img.mediaType, data: img.base64 },
                });
              }
            }
          }
        } catch { /* fall through */ }
      }
      if (blocks && blocks.length > 0) {
        // Merge with previous user message if consecutive
        const prev = out[out.length - 1];
        if (prev && prev.role === "user") {
          if (Array.isArray(prev.content)) {
            prev.content.push(...blocks);
          } else {
            prev.content = [{ type: "text", text: prev.content as string }, ...blocks];
          }
        } else {
          out.push({ role: "user", content: blocks });
        }
      } else {
        // Merge consecutive same-role text messages
        const prev = out[out.length - 1];
        if (prev && prev.role === "user") {
          if (typeof prev.content === "string") {
            prev.content = prev.content + "\n\n" + m.content;
          } else if (Array.isArray(prev.content)) {
            prev.content.push({ type: "text", text: m.content });
          }
        } else {
          out.push({ role: "user", content: m.content });
        }
      }
    }
  }
  return out;
}

/** Looks up max output tokens for a model from the provider model catalog or registry. */
async function getModelMaxOutput(
  userId: string,
  provider: ProviderId,
  model: string,
): Promise<number | undefined> {
  try {
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (row?.models) {
      const parsed: unknown = JSON.parse(row.models);
      if (Array.isArray(parsed)) {
        const entry = parsed.find(
          (m: unknown) =>
            m && typeof m === "object" && "id" in m && (m as { id: string }).id === model,
        );
        if (
          entry &&
          typeof entry === "object" &&
          "maxOutput" in entry &&
          typeof (entry as { maxOutput: number }).maxOutput === "number"
        ) {
          const maxOut = (entry as { maxOutput: number }).maxOutput;
          const ctx = typeof (entry as { contextWindow?: number }).contextWindow === "number"
            ? (entry as { contextWindow: number }).contextWindow
            : undefined;
          if (ctx === undefined || maxOut < ctx) {
            return maxOut;
          }
        }
      }
    }
  } catch {
    /* fall through */
  }

  const reg = await peekModelInRegistry(model, provider, { core: true });
  if (reg?.maxOutput !== undefined) {
    if (reg.contextWindow === undefined || reg.maxOutput < reg.contextWindow) {
      return reg.maxOutput;
    }
  }

  return undefined;
}

async function* streamAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: LoadedMessage[],
  temperature?: number,
  signal?: AbortSignal,
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
  maxTokens?: number,
  plan?: ReasoningPlan,
  imageData?: ResolvedImageData,
): AsyncGenerator<StreamChunk> {
  const url = baseUrl.replace(/\/$/, "") + "/messages";
  const supportsVision = modelSupportsVision("anthropic", model);
  const messages = toAnthropicMessages(history, imageData, supportsVision);
  const body: Record<string, unknown> = {
    model,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
    max_tokens: maxTokens ?? ANTHROPIC_SDK_DEFAULT_MAX_TOKENS,
    stream: true,
  };

  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  if (plan?.kind === "params") {
    Object.assign(body, plan.params);
    if (plan.extraBody && Object.keys(plan.extraBody).length > 0) {
      for (const [key, value] of Object.entries(plan.extraBody)) {
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
  }
  if (tools && tools.length > 0) {
    // Add cache_control to the last tool definition so all tools are cached together
    const cachedTools = tools.map((t, idx) =>
      idx === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t,
    );
    body.tools = cachedTools;
  }
  let resp = await safeProviderFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-25",
    },
    body: JSON.stringify(body),
    signal,
  });
  // If the request failed with 400/405/422 and tools were present, retry without tools
  // (some providers/models reject the native tools parameter but work fine without it).
  if (!resp.ok && (resp.status === 400 || resp.status === 405 || resp.status === 422) && body.tools) {
    delete body.tools;
    resp = await safeProviderFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-25",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (resp.ok && resp.body) {
      yield { type: "tools_rejected" };
    }
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `Anthropic returned ${resp.status}: ${stripHtml(text.slice(0, 500)) || resp.statusText}`,
    );
    (err as Error & { status?: number }).status = resp.status;
    const retryHeader =
      resp.headers.get("retry-after") ||
      resp.headers.get("x-ratelimit-reset") ||
      resp.headers.get("ratelimit-reset") ||
      resp.headers.get("x-ratelimit-reset-requests") ||
      resp.headers.get("x-ratelimit-reset-tokens");
    const retryAfterMs = parseRetryHeader(retryHeader);
    if (retryAfterMs !== null) {
      (err as any).retryAfterMs = retryAfterMs;
      (err as any).retryAfter = retryHeader;
    }
    throw err;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Anthropic streams tool_use as content_block_start → content_block_delta
  // (input_json_delta) → content_block_stop. We accumulate the partial JSON
  // per tool_use id and yield a `tool_calls` event at the end.
  interface PendingToolUse {
    id: string;
    name: string;
    inputJson: string;
  }
  const pendingTools = new Map<number, PendingToolUse>();
  const completedTools: NativeToolCall[] = [];
  // Measured usage: input + cache counts arrive on `message_start`, the
  // cumulative output count on `message_delta` (per the Anthropic streaming
  // spec). Merged and yielded once at stream end.
  let anthropicUsage: MeasuredUsage | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      try {
        const json = JSON.parse(payload);
        if (json.type === "message_start" && json.message?.usage) {
          const usage = extractAnthropicUsage(json.message.usage);
          if (usage) anthropicUsage = { ...anthropicUsage, ...usage };
        } else if (json.type === "message_delta" && json.usage) {
          const usage = extractAnthropicUsage(json.usage);
          if (usage?.completionTokens !== undefined) {
            anthropicUsage = { ...anthropicUsage, completionTokens: usage.completionTokens };
          }
        } else if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
          pendingTools.set(json.index, {
            id: json.content_block.id,
            name: json.content_block.name,
            inputJson: "",
          });
        } else if (json.type === "content_block_delta") {
          if (json.delta?.type === "text_delta" && json.delta?.text) {
            yield { type: "content", text: json.delta.text as string };
          } else if (json.delta?.type === "input_json_delta" && json.delta?.partial_json) {
            const pt = pendingTools.get(json.index);
            if (pt) pt.inputJson += json.delta.partial_json;
          } else if (json.delta?.type === "thinking_delta" && json.delta?.thinking) {
            yield { type: "thinking", text: json.delta.thinking as string };
          } else if (json.delta?.type === "signature_delta" && json.delta?.signature) {
            yield { type: "signature", signature: json.delta.signature as string };
          }
        } else if (json.type === "content_block_stop") {
          const pt = pendingTools.get(json.index);
          if (pt) {
            completedTools.push({
              id: pt.id,
              name: pt.name,
              arguments: pt.inputJson || "{}",
            });
            pendingTools.delete(json.index);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (completedTools.length > 0) {
    yield { type: "tool_calls", calls: completedTools };
  }
  if (anthropicUsage) {
    yield { type: "usage", usage: anthropicUsage };
  }
}

async function resolveByok(
  userId: string,
  provider: ProviderId,
): Promise<{ apiKey: string; baseUrl: string } | null> {
  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row || !row.isActive) return null;
  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch {
    return null;
  }
  const info = PROVIDERS[provider];
  const baseUrl = row.baseUrl || info?.baseUrl || "";
  return { apiKey, baseUrl };
}

/** Reads user per-model thinking-level config and reasoning capabilities. */
async function getModelReasoningState(
  userId: string,
  provider: ProviderId,
  model: string,
): Promise<{ userLevel: ThinkingLevel; caps?: ModelReasoningCapabilities }> {
  try {
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row?.models) return { userLevel: "default" };
    const parsed = JSON.parse(row.models);
    if (!Array.isArray(parsed)) return { userLevel: "default" };
    const entry = parsed.find(
      (m: unknown) =>
        m && typeof m === "object" && "id" in m && (m as { id: string }).id === model,
    );
    if (!entry || typeof entry !== "object") return { userLevel: "default" };
    const userLevel = normalizeThinkingLevel((entry as { thinkingLevel?: unknown }).thinkingLevel);
    const persistedCaps = parseModelReasoningCapabilities((entry as { reasoning?: unknown }).reasoning);
    // Rows fetched before per-model reasoning flags existed (or flagged
    // unknown) carry no caps. Self-heal from the models.dev registry:
    //  - `reasoning: false` → explicit `{ scheme: "none" }` (selector hides,
    //    no reasoning params ever sent);
    //  - `reasoning_options` effort values → `supportedEfforts` (the
    //    documented per-model effort vocabulary, e.g. Inkling's
    //    none|minimal|low|medium|high|xhigh);
    //  - `interleaved.field` → `interleavedField` (eager reasoning echo).
    // Registry "true"/unknown leaves the provider's documented scheme in
    // charge.
    const registryEntry = await peekModelInRegistry(model, provider);
    const caps = mergeReasoningCapability(undefined, persistedCaps, registryEntry);
    // Gateway providers scoped like `custom` (nvidia/zen) must never inherit
    // a stale interleaved echo persisted from a prior registry-scoped refresh.
    if (provider === "nvidia" || provider === "zen") {
      if (caps?.interleavedField) {
        const noEcho = { ...caps };
        delete (noEcho as { interleavedField?: unknown }).interleavedField;
        return { userLevel, caps: noEcho };
      }
    }
    return { userLevel, caps };
  } catch {
    return { userLevel: "default" };
  }
}

async function getModelContextWindow(
  userId: string,
  provider: ProviderId,
  model: string,
): Promise<number | undefined> {
  const staticWindow = PROVIDERS[provider]?.models.find((m) => m.id === model)?.contextWindow;
  if (typeof staticWindow === "number") return staticWindow;

  try {
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (row?.models) {
      const parsed = JSON.parse(row.models);
      if (Array.isArray(parsed)) {
        const entry = parsed.find(
          (m: unknown) =>
            m && typeof m === "object" && "id" in m && (m as { id: string }).id === model,
        );
        if (
          entry &&
          typeof entry === "object" &&
          "contextWindow" in entry &&
          typeof (entry as any).contextWindow === "number"
        ) {
          return (entry as any).contextWindow;
        }
      }
    }
  } catch {}

  const reg = await peekModelInRegistry(model, provider, { core: true });
  if (reg?.contextWindow !== undefined) return reg.contextWindow;

  return lookupContextWindow(model);
}

/** Formats human-readable target summary for a pending permission prompt. */
function buildPermissionTarget(
  toolName: string,
  action: PermissionAction | null,
  args: Record<string, unknown>,
): string {
  const getStr = (key: string): string => {
    const v = args[key];
    return typeof v === "string" ? v : "";
  };
  const firstCommand = (): string =>
    getStr("command") || getStr("CommandLine") || getStr("cmd") || getStr("Command");
  switch (toolName) {
    case "run_command":
      return `run \`${firstCommand()}\``;
    case "edit_file":
      return `edit \`${getStr("path")}\``;
    case "write_file":
      return `write \`${getStr("path")}\``;
    case "read_file":
      return `read \`${getStr("path")}\``;
    case "list_directory":
      return `list \`${getStr("path")}\``;
    case "browser_open":
      return `open \`${getStr("url")}\``;
    case "browser_click":
      return `click \`${getStr("ref")}\``;
    case "browser_type":
      return `type into \`${getStr("ref")}\``;
    case "web_search":
      return `search \`${getStr("query")}\``;
    case "http_fetch":
      return `fetch \`${getStr("url")}\``;
    case "mcp_call":
      return `mcp call \`${getStr("server")}/${getStr("tool")}\``;
    default:
      return action ?? toolName;
  }
}

// Sequential tool execution per iteration with per-resource locks across concurrent loops.

const VALID_PROVIDERS: ReadonlySet<string> = new Set([
  "puter",
  "openrouter",
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "together",
  "gemini",
  "custom",
]);

/**
 * Builds mention context from @file, @skill, @mcp, and @agent tokens,
 * returning context blocks and optional system prompt overrides.
 */
export async function buildMentionContext(
  userId: string,
  mentions: ParsedMention[],
): Promise<{ contextBlock: string; systemPromptOverride?: string }> {
  if (!mentions.length) return { contextBlock: "" };
  const parts: string[] = [];
  let systemPromptOverride: string | undefined;

  let ws = await getActiveWorkspace(userId);
  if (!ws) {
    try {
      ws = await ensureDefaultWorkspace(userId);
    } catch {
      /* no workspace available */
    }
  }
  const wsName = ws?.name ?? null;
  const rootDir = ws?.rootDir;

  for (const m of mentions) {
    if (m.type === "file") {
      if (!wsName) {
        parts.push(`[Referenced file: ${m.id} — no workspace]`);
        continue;
      }
      try {
        const r = await readFileWs(userId, wsName, m.id, undefined, rootDir);
        const content = r.content;
        parts.push(
          `[Referenced file: ${m.id}]\n\`\`\`\n${content}\n\`\`\``,
        );
      } catch {
        parts.push(`[Referenced file: ${m.id} — not found]`);
      }
    } else if (m.type === "skill") {
      try {
        const cleanSkill = m.id.replace(/^["']|["']$/g, "").trim().toLowerCase();
        const { loadPluginTools } = await import("@/lib/plugins/plugin-runtime");
        const pluginTools = await loadPluginTools(userId);
        
        const dbSkill = await db.plugin.findFirst({
          where: {
            name: { contains: cleanSkill },
            enabled: true,
            OR: [{ userId }, { user: { role: "system" } }],
          },
        });

        const matchTools = pluginTools.filter(
          (t) =>
            t.pluginName?.toLowerCase().includes(cleanSkill) ||
            t.name?.toLowerCase().includes(cleanSkill)
        );

        if (matchTools.length > 0) {
          const toolsContext = matchTools.map((t: any) => 
            `- Tool: "${t.name}"\n  Description: "${t.description || ''}"\n  Args Schema: ${JSON.stringify(t.inputSchema)}`
          ).join("\n\n");
          parts.push(
            `[Skill/Plugin "${dbSkill?.name || m.id}" is ENABLED and active]:\n${dbSkill?.description ? `Description: ${dbSkill.description}\n` : ""}\nProvided tools:\n${toolsContext}`
          );
        } else if (dbSkill) {
          parts.push(`[Skill "${dbSkill.name}" is ENABLED. Description: ${dbSkill.description || "Active skill"}]`);
        } else {
          parts.push(`[Skill: ${m.id} is available for agent use.]`);
        }
      } catch (e: any) {
        parts.push(`[Skill: ${m.id} is available. Note loading plugin tools: ${e?.message || String(e)}]`);
      }
    } else if (m.type === "mcp") {
      try {
        const cleanMcp = m.id.replace(/^["']|["']$/g, "").trim().toLowerCase();
        const mcpServer = await db.mcpServer.findFirst({
          where: {
            name: { contains: cleanMcp },
            OR: [{ userId }, { user: { role: "system" } }],
          },
        });
        if (mcpServer && mcpServer.status === "connected" && mcpServer.tools) {
          const toolsList = JSON.parse(mcpServer.tools as string);
          const toolsContext = toolsList.map((t: any) => 
            `- Tool: "${t.name}"\n  Description: "${t.description || ''}"\n  Args Schema: ${JSON.stringify(t.inputSchema)}`
          ).join("\n\n");
          parts.push(
            `[MCP Server "${mcpServer.name}" is CONNECTED and provides tools. You can invoke them using "mcp_call" with server="${mcpServer.name}", tool="<name>"]:\n\n${toolsContext}`
          );
        } else if (mcpServer) {
          parts.push(`[MCP server "${mcpServer.name}" is registered (status: ${mcpServer.status}). Connect it to enable tools.]`);
        } else {
          parts.push(`[MCP server "${m.id}" not found.]`);
        }
      } catch (e: any) {
        parts.push(`[MCP server ${m.id} tools lookup error: ${e?.message || String(e)}]`);
      }
    } else if (m.type === "agent") {
      try {
        const cleanName = m.id.replace(/^["']|["']$/g, "").trim().toLowerCase();
        const allPresets = await db.agentPreset.findMany({
          where: {
            OR: [{ isBuiltin: true }, { userId }],
          },
        });
        const preset = allPresets.find(
          (p) =>
            p.name.toLowerCase() === cleanName ||
            p.name.toLowerCase().replace(/[^a-z0-9]/g, "") === cleanName.replace(/[^a-z0-9]/g, "") ||
            p.name.toLowerCase().includes(cleanName) ||
            cleanName.includes(p.name.toLowerCase()),
        );
        if (preset) {
          systemPromptOverride = preset.systemPrompt;
          parts.push(`[Agent preset activated: "${preset.name}" (${preset.description})]\n\nSystem Prompt Override:\n${preset.systemPrompt}`);
        } else {
          parts.push(`[Agent preset: "${m.id}" — not found. Available presets: ${allPresets.map((p) => p.name).join(", ")}]`);
        }
      } catch {
        parts.push(`[Agent preset: "${m.id}" — error]`);
      }
    }
  }

  return { contextBlock: parts.join("\n\n"), systemPromptOverride };
}

/** Handles slash commands (/clear, /compact, /agent, /model, /help) with early confirmation response. */
async function handleCommand(opts: {
  user: { id: string };
  conversationId: string;
  command: { command: string; args: string; raw: string };
  req: ChatRequest;
  emit: (event: ChatStreamEvent) => void;
  startedAt: number;
  contextConfig: Partial<ContextConfig>;
}): Promise<void> {
  const { user, conversationId, command, req, emit, startedAt, contextConfig } = opts;

  // Create an assistant message bubble for the confirmation.
  const cmdMsg = await db.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: "",
      provider: req.provider,
      model: req.model,
    },
  });
  emit({ type: "start", messageId: cmdMsg.id });

  let confirmation: string;
  switch (command.command) {
    case "clear": {
      // Delete ALL messages in the conversation (except the confirmation itself).
      await db.message.deleteMany({
        where: {
          conversationId,
          id: { not: cmdMsg.id },
        },
      });
      confirmation = "🗑️ Conversation cleared.";
      break;
    }
    case "compact": {
      const allMessages = await db.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "asc" },
      });
      // Only re-summarize what the model actually needs: everything after the
      // most recent compaction summary (prior summaries are already dense).
      // The marker rows themselves are dropped after the window is computed,
      // so the window logic still sees them (the window must NOT collapse to
      // the full history) — the latest summary is passed in as the anchor.
      const window = applyCompactionWindow(allMessages).filter(
        (m) => m.id !== cmdMsg.id && !isCompactionMarker(m.content),
      );

      const conv = await db.conversation.findUnique({ where: { id: conversationId } }).catch(() => null);
      const summaryProvider = conv?.provider ?? req.provider;
      const summaryModel = conv?.model ?? req.model;
      // Incremental compaction: anchor on the most recent prior summary so the
      // model only folds in the delta since the last compact.
      const previousSummary = (() => {
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const text = compactionSummaryText(allMessages[i].content);
          if (text) return text;
        }
        return undefined;
      })();

      // Preserve the most recent turns verbatim (opencode select()) and
      // summarize only the older head. When even the most recent turn alone
      // cannot be preserved (tailStart === null), the whole window compacts.
      const convWindow = (await getModelContextWindow(user.id, summaryProvider as ProviderId, summaryModel)) || undefined;
      const preserveBudget = resolvePreserveRecentBudget(
        resolveEffectiveMaxInputBudget({ contextWindow: convWindow }) ?? convWindow ?? 0,
      );
      const tailStart = selectCompactionTail(window, preserveBudget, {
        tailTurns: contextConfig.tailTurns ?? DEFAULT_CONTEXT_CONFIG.tailTurns,
      });
      const cutIndex = tailStart === null ? 0 : tailStart;
      const summarizeTarget = window.slice(0, cutIndex).filter((m) => !isCompactionMarker(m.content));
      if (summarizeTarget.length < 2) {
        confirmation =
          tailStart === null
            ? "🗜️ The most recent turn alone exceeds the context budget — nothing to compact."
            : "🗜️ Conversation fits within its preserved window — nothing to compact.";
        break;
      }

      // Summarize via the conversation's provider/model (the helper falls
      // back to the local heuristic extractor when the model call is
      // unavailable or fails).
      const summaryText = await summarizeTranscript({
        userId: user.id,
        provider: summaryProvider,
        model: summaryModel,
        messages: summarizeTarget,
        buildPrompt: (transcript) => buildCompactionPrompt({ transcript, previousSummary }),
      });

      const originalTokenEst = summarizeTarget.reduce(
        (s, m) =>
          s +
          estimateMessageTokens({
            content: m.content,
            toolCalls: m.toolCalls as any,
            thinking: m.thinking,
            attachments: m.attachments as any,
          }),
        0,
      );
      const summaryTokenEst = estimateMessageTokens({ content: summaryText });
      const firstKept = tailStart !== null ? window[tailStart] : undefined;

      // Insert the summary as a user message (NOT delete old messages — they remain for history/undo).
      // The summary is wrapped in a marker so it can be identified for undo.
      // Backdated to sort between the summarized head and the preserved tail.
      await db.message.create({
        data: {
          conversationId,
          role: "user",
          content: `<context_summary compacted="true">\n${summaryText}\n</context_summary>`,
          provider: req.provider,
          model: req.model,
          promptTokens: summaryTokenEst,
          ...(firstKept ? { createdAt: new Date(firstKept.createdAt.getTime() - 1) } : {}),
        },
      });

      const tailMsgs = tailStart !== null ? window.slice(tailStart) : [];
      const tailTokens = tailMsgs.reduce(
        (s, m) =>
          s +
          estimateMessageTokens({
            content: m.content,
            toolCalls: m.toolCalls as any,
            thinking: m.thinking,
            attachments: m.attachments as any,
          }),
        0,
      );
      const savedTokens = Math.max(0, originalTokenEst - summaryTokenEst);
      confirmation =
        tailStart !== null
          ? `🗜️ Conversation compacted — ${summarizeTarget.length} older messages summarized into 1; ${tailMsgs.length} recent messages kept verbatim (history preserved).\n\n**Tokens**: ~${originalTokenEst.toLocaleString()} → ~${(summaryTokenEst + tailTokens).toLocaleString()} (saved ~${savedTokens.toLocaleString()} tokens)`
          : `🗜️ Conversation compacted — ${summarizeTarget.length} messages summarized into 1 (history preserved).\n\n**Tokens**: ~${originalTokenEst.toLocaleString()} → ~${summaryTokenEst.toLocaleString()} (saved ~${savedTokens.toLocaleString()} tokens)`;
      // Emit context_trimmed so the status-bar indicator updates immediately.
      const postCompactTokens = summaryTokenEst + tailTokens;
      emit({
        type: "context_trimmed",
        dropped: summarizeTarget.length - 1,
        keptTokens: postCompactTokens,
        activePromptTokens: postCompactTokens,
        via: "command",
      });
      break;
    }
    case "agent": {
      const name = command.args.trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (!name) {
        confirmation = "Usage: `/agent <name>`";
        break;
      }
      const allPresets = await db.agentPreset.findMany({
        where: {
          OR: [{ isBuiltin: true }, { userId: user.id }],
        },
      });
      const preset = allPresets.find(
        (p) =>
          p.name.toLowerCase() === name ||
          p.name.toLowerCase().replace(/[^a-z0-9]/g, "") === name.replace(/[^a-z0-9]/g, "") ||
          p.name.toLowerCase().includes(name) ||
          name.includes(p.name.toLowerCase()),
      );
      if (!preset) {
        confirmation = `Agent preset \`${command.args}\` not found. Available presets: ${allPresets.map((p) => `\`${p.name}\``).join(", ")}`;
      } else {
        await db.conversation.update({
          where: { id: conversationId },
          data: {
            systemPrompt: preset.systemPrompt,
            provider: preset.provider,
            model: preset.model,
          },
        });
        confirmation = `🤖 Switched to agent: **${preset.name}**.`;
      }
      break;
    }
    case "model": {
      const arg = command.args.trim();
      const mm = /^([a-zA-Z]+)\/(.+)$/.exec(arg);
      if (!mm) {
        confirmation =
          "Usage: `/model <provider>/<model>`  (e.g. `/model free/glm-5.2`)";
        break;
      }
      const provider = mm[1].toLowerCase() as ProviderId;
      const model = mm[2].trim();
      if (!VALID_PROVIDERS.has(provider)) {
        confirmation = `Unknown provider: \`${provider}\`.`;
        break;
      }
      if (!model || model.length > 120) {
        confirmation = "Invalid model name.";
        break;
      }
      await db.conversation.update({
        where: { id: conversationId },
        data: { provider, model },
      });
      confirmation = `🔄 Switched to model: **${provider}/${model}**.`;
      // Tell the client to refresh its conversation row and re-sync the
      // active selection (provider/model/mode) so the status bar indicator
      // and model selector don't go stale.
      emit({ type: "ui_action", action: "sync_selection" });
      break;
    }
    case "help": {
      confirmation = `**Commands**
- \`/clear\` — delete all messages in this conversation
- \`/compact\` — drop the middle of the conversation to save context
- \`/agent <name>\` — switch to an agent preset
- \`/model <provider>/<model>\` — switch provider + model
- \`/help\` — show this help

**Mentions**
- \`@file:<path>\` — embed a workspace file's content as context
- \`@skill:<name>\` — mark a skill as available to the agent
- \`@mcp:<server>\` — surface an MCP server's tools
- \`@agent:<name>\` — use an agent preset's system prompt for this turn`;
      break;
    }
    default:
      confirmation = `Unknown command: \`/${command.command}\``;
  }

  const tokensOut = estimateTokens(confirmation);
  await db.message.update({
    where: { id: cmdMsg.id },
    data: {
      content: confirmation,
      tokensIn: 0,
      tokensOut,
      latencyMs: Date.now() - startedAt,
    },
  });

  emit({ type: "delta", content: confirmation });
  emit({ type: "done", messageId: cmdMsg.id });
}

/** Summarizes conversation transcript via provider model with heuristic fallback on failure. */
async function summarizeTranscript(opts: {
  userId: string;
  provider: string;
  model: string;
  messages: Array<{ role: string; content?: string | null; createdAt?: Date }>;
  /** Builds the final prompt from the pre-flight-pruned transcript. */
  buildPrompt: (transcript: string) => string;
  /** Cap on compaction prompt tokens; skips model call if prompt exceeds context. */
  maxPromptTokens?: number;
}): Promise<string> {
  const { userId, provider, model, messages, buildPrompt, maxPromptTokens } = opts;

  // Pre-flight prune to prevent compaction API overflow (OpenCode #20718)
  const pruned = pruneForOverflow(
    messages.map((m) => ({ role: m.role, content: m.content ?? "", createdAt: m.createdAt })),
  );
  const transcript = pruned
    .map((m) => `[${m.role.toUpperCase()}]: ${(m.content ?? "").slice(0, 3000)}`)
    .join("\n\n---\n\n")
    .slice(0, 80000);
  const prompt = scrubPromptString(
    buildPrompt(transcript),
    await getSecuritySettings(userId),
  ) ?? "";
  const promptOverBudget =
    typeof maxPromptTokens === "number" &&
    maxPromptTokens > 0 &&
    estimateTokens(prompt) > maxPromptTokens;

  let summaryText = "";
  if (!promptOverBudget) {
    try {
    if (provider === "anthropic") {
      const pkRow = await db.providerKey.findUnique({
        where: { userId_provider: { userId, provider: provider as any } },
      });
      if (pkRow?.encryptedKey) {
        let apiKey: string | undefined;
        try {
          apiKey = decrypt(pkRow.encryptedKey);
        } catch (err) {
          console.warn("[summarize] Failed to decrypt Anthropic API key:", err);
        }
        if (apiKey) {
          const baseUrl = pkRow.baseUrl ?? "https://api.anthropic.com";
          const reg = await peekModelInRegistry(model, provider, { core: true });
          if (reg?.maxOutput) {
            const resp = await safeProviderFetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model, max_tokens: reg.maxOutput, messages: [{ role: "user", content: prompt }] }),
              signal: AbortSignal.timeout(120000),
            });
            if (resp.ok) { const j = await resp.json() as any; summaryText = j?.content?.[0]?.text ?? ""; }
            else { console.warn(`[summarize] request failed: ${resp.status} ${resp.statusText} — ${(await resp.text()).slice(0, 300)}`); }
          }
        }
      }
    } else {
      // OpenAI-compatible (free tier, OpenRouter, OpenAI, Groq, etc.)
      const pkRow = !PROVIDERS[provider as keyof typeof PROVIDERS]?.requiresKey
        ? null
        : await db.providerKey.findUnique({
            where: { userId_provider: { userId, provider: provider as any } },
          });
      let apiKey: string | null = "not-needed";
      if (pkRow?.encryptedKey) {
        try {
          apiKey = decrypt(pkRow.encryptedKey);
        } catch (err) {
          console.warn(`[summarize] Failed to decrypt API key for ${provider}:`, err);
          apiKey = null;
        }
      }
      const baseUrl = pkRow?.baseUrl ?? PROVIDERS[provider as keyof typeof PROVIDERS]?.baseUrl ?? "";
      if (apiKey !== null && baseUrl) {
        const reg = await peekModelInRegistry(model, provider, { core: true });
        const body: Record<string, unknown> = {
          model,
          stream: false,
          messages: [
            { role: "system", content: "You are a context-compression assistant. Produce structured summaries." },
            { role: "user", content: prompt },
          ],
        };
        if (reg?.maxOutput) body.max_tokens = reg.maxOutput;
        const resp = await safeProviderFetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey !== "not-needed" ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        if (resp.ok) { const j = await resp.json() as any; summaryText = j?.choices?.[0]?.message?.content ?? ""; }
        else { console.warn(`[summarize] request failed: ${resp.status} ${resp.statusText} — ${(await resp.text()).slice(0, 300)}`); }
      }
    }
  } catch { /* silent — heuristic fallback below */ }
  }

  if (!summaryText) {
    const { compactConversation } = await import("@/lib/ai/context");
    summaryText = compactConversation(
      messages.map((m) => ({ role: m.role, content: m.content ?? "", createdAt: m.createdAt })),
    );
  }
  return summaryText;
}

/**
 * SSRF-gated provider fetch: validates the URL against the shared policy
 * before sending, and re-validates the FINAL URL after any redirects were
 * followed (so a redirect to an internal/metadata host is refused before the
 * response is consumed). Provider base URLs are user-editable (the stored
 * `baseUrl` column overrides the preset), so every provider call is gated.
 */
async function safeProviderFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertUrlAllowed(url);
  const resp = await fetch(url, init);
  if (resp.redirected) {
    await assertUrlAllowed(resp.url);
  }
  return resp;
}

/** Append a brief verification hint to tool results for write operations. */
function appendVerificationHint(toolName: string, ok: boolean, content: string): string {
  if (!ok) return content;
  switch (toolName) {
    case "write_file":
      return content + "\n[Verify: read the file or run build/lint to confirm correctness.]";
    case "edit_file":
    case "multi_edit":
      return content + "\n[Verify: read the file to confirm the edit landed correctly.]";
    default:
      return content;
  }
}

/** Find tool calls that returned ok:false and were not subsequently retried. */
function findUnresolvedFailures(
  allToolCalls: ToolCall[],
  excludedIds?: ReadonlySet<string>,
): Array<{ tool: string; path?: string; error: string }> {
  const failures: Array<{ tool: string; path?: string; error: string; idx: number; id: string }> = [];

  for (let i = 0; i < allToolCalls.length; i++) {
    const tc = allToolCalls[i];
    if (tc.status === "error") {
      if (excludedIds && excludedIds.has(tc.id)) continue;
      const errorMsg = typeof tc.result === "object" && tc.result && "error" in tc.result
        ? String((tc.result as any).error)
        : "failed";
      failures.push({
        tool: tc.name,
        path: String(tc.args?.path || tc.args?.command || ""),
        error: errorMsg,
        idx: i,
        id: tc.id,
      });
    }
  }

  return failures.filter(f => {
    const key = `${f.tool}:${f.path}`;
    // Check if any call AFTER this failure used the same tool+path and succeeded
    for (let j = f.idx + 1; j < allToolCalls.length; j++) {
      const later = allToolCalls[j];
      const laterKey = `${later.name}:${later.args?.path || later.args?.command || ""}`;
      if (laterKey === key && later.status !== "error") return false; // Was retried successfully
    }
    return true;
  }).slice(0, 5); // Cap at 5 to avoid token bloat
}

/** Builds completion integrity nudge prompt listing unresolved tool failures across iterations. */
export function buildCompletionIntegrityNudge(
  allToolCalls: ToolCall[],
  deniedToolCallIds?: ReadonlySet<string>,
): string | null {
  const unresolvedFailures = findUnresolvedFailures(allToolCalls, deniedToolCallIds);
  if (unresolvedFailures.length === 0) return null;
  const failList = unresolvedFailures.map((f) => `- ${f.tool}(${f.path || "N/A"}): ${f.error}`).join("\n");
  return `[System] Tool failures from earlier steps were not retried:\n${failList}\nAddress them or acknowledge them before completing.`;
}

/** Persists queued subagent completion reports as user-role messages in conversation history. */
async function persistQueuedSubagentReports(
  userId: string,
  conversationId: string,
  emit?: (event: ChatStreamEvent) => void,
): Promise<Awaited<ReturnType<typeof db.message.create>>[]> {
  const created: Awaited<ReturnType<typeof db.message.create>>[] = [];
  const queued = drainSubagentReports(userId, conversationId);
  for (const q of queued) {
    try {
      const sess = getSession(userId, q.subagentId);
      if (sess && sess.status !== "completed" && sess.status !== "failed") continue;
      if (isSubagentReportDelivered(userId, conversationId, q.subagentId)) continue;
      // Claim BEFORE the awaited create: the watcher gates its posts on the
      // delivered mark, so claiming first closes the double-post TOCTOU (a
      // completion landing during a teardown drain could otherwise slip a
      // second identical row in between check and mark).
      markSubagentReportDelivered(userId, conversationId, q.subagentId);
      const row = await db.message.create({
        data: {
          conversationId,
          role: "user",
          content: q.content,
          // Anchor the row to the moment the subagent actually finished so the
          // "messaged from X" row sits at its chronological place (right after
          // the turn that spawned it, before any later user turns) instead of
          // at drain time — a drain can run during an unrelated in-flight
          // answer and drop the row below it, misordering the transcript.
          ...(sess?.completedAt ? { createdAt: new Date(sess.completedAt) } : {}),
        },
      });
      created.push(row);
      if (emit) {
        try {
          emit({
            type: "subagent_report",
            messageId: row.id,
            subagentId: q.subagentId,
            name: sess?.name,
            content: q.content,
            status: sess?.status as "completed" | "failed",
            createdAt: row.createdAt.toISOString(),
          });
        } catch {
          /* emit may be closed */
        }
      }
    } catch {
      unmarkSubagentReportDelivered(userId, conversationId, q.subagentId);
      enqueueSubagentReport(userId, conversationId, q.subagentId);
    }
  }
  return created;
}

export async function executeChat(opts: ExecuteOptions): Promise<void> {
  const { user, req, emit, signal } = opts;
  const startedAt = Date.now();

  // Context governance config — enterprise-tunable retention policies.
  // Override via user settings to customize prune window, compaction buffer, etc.
  const ctxConfig: Partial<ContextConfig> = req.contextConfig ?? {};

  try {
    // 1. Load conversation (verify ownership). Only the fields consumed in
    // this scope are fetched — message BODIES (segments/attachments JSON) are
    // heavy and are re-loaded by loadHistoryOnce below; here we need just the
    // message ids for the edit-truncation path.
    const conversation = await db.conversation.findUnique({
      where: { id: req.conversationId },
      select: {
        id: true,
        userId: true,
        systemPrompt: true,
        mode: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true },
        },
      },
    });
    if (!conversation || conversation.userId !== user.id) {
      emit({
        type: "error",
        message: "Conversation not found.",
        code: "NOT_FOUND",
      });
      return;
    }

    // Server-authoritative security settings (reserved `__security__` row).
    // Read once per request and reused across iterations — the server DB is
    // the source of truth, so a browser client cannot disable enforcement.
    const securitySettings = await getSecuritySettings(user.id);

    // 1a. Parse /commands from the leading slash-prefixed token. If this is
    // a known command, handle it (clear / compact / agent / model / help)
    // and return early — no model call is made.
    const command = parseCommands(req.message);
    if (command) {
      await handleCommand({
        user,
        conversationId: conversation.id,
        command,
        req,
        emit,
        startedAt,
        contextConfig: ctxConfig,
      });
      return;
    }

    // 1b. Parse @mentions. For each @file:<path> we read the file (capped at
    // 500KB) and prepend it as context. For @agent:<name> we override the
    // system prompt for this turn. Other mention types just inject a note.
    const mentions = parseMentions(req.message);
    let augmentedMessage = req.message;
    let systemPromptOverride: string | undefined;
    if (mentions.length > 0) {
      const { contextBlock, systemPromptOverride: sp } =
        await buildMentionContext(user.id, mentions);
      if (sp) systemPromptOverride = sp;
      if (contextBlock) {
        augmentedMessage = contextBlock + "\n\n" + req.message;
      }
    }

    // Resolve and inline attachments
    let resolvedAtts: ResolvedAttachment[] = [];
    if (req.attachmentIds && req.attachmentIds.length > 0) {
      resolvedAtts = await resolveAttachments(req.attachmentIds, user.id, conversation.id);
      if (resolvedAtts.length > 0) {
        const previews = resolvedAtts.map((a) => extractAttachmentPreview(a));
        augmentedMessage += "\n\n## Attached files\n" + previews.join("\n\n");
      }
    }
    const attachmentsJson = resolvedAtts.length > 0
      ? JSON.stringify(resolvedAtts.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size })))
      : null;

    // 2. Persist the incoming user message immediately (with @mention
    //    context and attachments injected so the stored transcript reflects
    //    what the model actually saw). Skip for internal autoWake sentinel
    //    runs — those inject no user text; they only read the delivered
    //    `<subagent_report>` user messages the delivery pipeline posted.
    if (req.autoWake === true) {
      // no silent user message row for internal wake runs
    } else if (!req.editMessageId) {
      try {
        await db.message.create({
          data: {
            id: req.messageId || undefined,
            conversationId: conversation.id,
            role: "user",
            content: augmentedMessage,
            attachments: attachmentsJson,
          },
        });
      } catch (err) {
        // The message may already exist with this id — a queued turn whose row
        // was persisted by the queue route and then reconciled/re-sent by the
        // client fallback. Idempotent: if a row with the same id is present,
        // the turn is already durable and the run proceeds on it.
        const e = err as { code?: string; meta?: { target?: unknown } };
        if (e?.code === "P2002" && req.messageId) {
          // The turn is already durable with this id — proceed; the history
          // fetch will see the existing row. Verify it belongs to THIS
          // conversation (mirrors the queue route's ownership check).
          const existing = await db.message.findUnique({ where: { id: req.messageId } });
          if (!existing) throw err;
          if (existing.conversationId !== conversation.id) {
            emit({ type: "error", message: "Message belongs to another conversation.", code: "CONFLICT" });
            return;
          }
        } else {
          throw err;
        }
      }
    } else {
      // It's an edit! We update the content of the existing user message
      // rather than creating a duplicate.
      try {
        await db.message.update({
          where: { id: req.editMessageId },
          data: { content: augmentedMessage, attachments: attachmentsJson },
        });
      } catch (err) {
        console.warn(`[executor] editMessageId ${req.editMessageId} not found in database, creating fallback user message:`, err);
        try {
          await db.message.create({
            data: {
              id: req.editMessageId,
              conversationId: conversation.id,
              role: "user",
              content: augmentedMessage,
              attachments: attachmentsJson,
            },
          });
        } catch {
          /* ignore nested creation errors */
        }
      }
      // Delete stale assistant responses after the edited message so the
      // model doesn't see its old replies when the agent loop reloads history.
      const allMsgIds = conversation.messages.map((m) => m.id);
      const editIdx = allMsgIds.indexOf(req.editMessageId);
      if (editIdx !== -1) {
        const staleIds = allMsgIds.slice(editIdx + 1);
        if (staleIds.length > 0) {
          await db.message.deleteMany({
            where: { id: { in: staleIds }, conversationId: conversation.id },
          });
        }
      }
    }
    await db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    // 3. Create assistant message (empty content) — emit start
    let assistantMsg = await db.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: "",
        provider: req.provider,
        model: req.model,
      },
    });
    // The answer row can rotate below queued turns (see the rotation blocks
    // below); every `done` event references the CURRENT `assistantMsg` row,
    // so the client always finalizes the row it streamed into.
    emit({ type: "start", messageId: assistantMsg.id });

    // 4. Build system prompt (mention override > request override > saved prompt > default).
    let baseSystemPrompt =
      systemPromptOverride ||
      req.systemPrompt ||
      conversation.systemPrompt ||
      NATIVE_SYSTEM_PROMPT;

    const mode: AgentMode = req.mode || (conversation.mode as AgentMode) || "agent";

    let enabledTools: string[] = [];
    let toolSection = "";

    if (mode === "chat") {
      enabledTools = [];
      toolSection =
        "\n\n## Mode: Chat\nTool usage is disabled. Answer questions, discuss ideas, and provide code snippets.";
    } else if (mode === "architect") {
      const allTools = req.enabledTools && req.enabledTools.length > 0
        ? req.enabledTools
        : PUBLIC_BUILTIN_TOOLS.map((t) => t.name);
      enabledTools = allTools.filter((t) => ARCHITECT_ALLOWED_TOOLS.has(t));
      toolSection =
        "\n\n## Mode: Architect (Read-Only)\nYou may read and analyze the codebase but MUST NOT modify files or run commands. Write plans and analysis to artifacts via create_artifact. You MAY spawn read-only research subagents (spawn_subagent) for parallel investigation — they are restricted to read-only tools automatically.";
    } else {
      enabledTools =
        req.enabledTools && req.enabledTools.length > 0
          ? req.enabledTools
          : PUBLIC_BUILTIN_TOOLS.map((t) => t.name);
      toolSection =
        "\n\n## Mode: Agent\nFull autonomous execution. Read, edit, and create files, and run commands. Verify changes after making them.";
    }

    const isSimpleGreeting = /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|howdy|sup|hi there|hello there)[.!\s]*$/i.test(req.message.trim());
    if (isSimpleGreeting) {
      enabledTools = [];
      toolSection = "\n\n## Turn Note\n- The user greeted you. Respond warmly and conversationally without calling any tools.";
    }

    // Append runtime capability info (detected client-side) so the agent knows
    // what environment it's running in (PWA standalone vs browser tab, etc.).
    const capabilitiesBlock =
      req.capabilities && req.capabilities.length > 0
        ? `\n\n## Runtime capabilities\n${req.capabilities.map((c) => `- ${c}`).join("\n")}`
        : "";
    const discoveryBlock = await buildDiscoveryBlock(user.id);

    // Build environment block so the agent knows its working directory,
    // platform, and shell (like OpenCode's "Build Environment" section).
    let envBlock = "";
    try {
      let activeWs = null;
      if (req.conversationId) {
        const conv = await db.conversation.findUnique({
          where: { id: req.conversationId },
          select: { workspaceId: true },
        });
        if (conv?.workspaceId) {
          activeWs = await db.workspace.findFirst({ where: { id: conv.workspaceId, userId: user.id } });
        }
      }
      if (!activeWs) {
        activeWs = (await getActiveWorkspace(user.id)) || (await ensureDefaultWorkspace(user.id));
      }
      if (activeWs) {
        const platform =
          req.capabilities?.find((c) => c.startsWith("os:"))?.slice(3) ||
          (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
        const shell = platform === "windows" ? "powershell" : "bash";
        const cwd = activeWs.name ? `./ (${activeWs.name})` : "./";
        const wsRoot = activeWs.rootDir;
        const runtimeMode = process.env.HERMOS_DESKTOP === "true" ? "Desktop App (Tauri Native)" : "Web Server / Dev";
        envBlock = `\n\n## Build Environment\n- **Runtime Mode**: ${runtimeMode}\n- **Platform**: ${platform}\n- **Shell**: ${shell}\n- **Working directory**: ${cwd}\n- **Workspace root**: ${wsRoot}\n- **Date**: ${new Date().toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })}\n- **Path style**: Use workspace-relative paths (e.g., \`src/app/page.tsx\`). Never use absolute server paths like \`C:\\ROOT\\workspaces\\...\` or \`/home/user/workspaces/...\`.`;
      }
    } catch {
      envBlock = "";
    }

    // Load workspace-level rules (AGENTS.md / GEMINI.md / .agents/rules) auto-driven like Antigravity
    let workspaceRulesBlock = "";
    try {
      let wsForRules = null;
      if (req.conversationId) {
        const conv = await db.conversation.findUnique({
          where: { id: req.conversationId },
          select: { workspaceId: true },
        });
        if (conv?.workspaceId) {
          wsForRules = await db.workspace.findFirst({ where: { id: conv.workspaceId, userId: user.id } });
        }
      }
      if (!wsForRules) {
        wsForRules = await getActiveWorkspace(user.id);
      }
      workspaceRulesBlock = await loadWorkspaceRules(wsForRules?.rootDir);
    } catch {
      workspaceRulesBlock = "";
    }

    // We load it once before the loop so it can be injected into each
    // iteration's model context as a "stay focused on the original task"
    // signal, preventing long-running conversations from drifting.
    const firstUserMsg = await db.message.findFirst({
      where: { conversationId: conversation.id, role: "user" },
      orderBy: { createdAt: "asc" },
    });
    const originalRequest = firstUserMsg?.content ?? "";

    // Inject the original user request as a mission reminder so long
    // conversations don't drift. This is similar to OpenCode's approach.
    const missionBlock = originalRequest
      ? `\n\n## Original Request (Mission)\n${originalRequest.slice(0, 2000)}`
      : "";

    let systemPrompt = baseSystemPrompt + workspaceRulesBlock + toolSection + capabilitiesBlock + envBlock + discoveryBlock + missionBlock;

    let openaiTools = buildOpenAITools(enabledTools);
    let anthropicTools = buildAnthropicTools(enabledTools);
    let toolsRejected = false;
    // Skip tool retries if this conversation+provider+model already had tools rejected.
    if (isToolsRejected(conversation.id, req.provider, req.model)) {
      openaiTools = [];
      anthropicTools = [];
      toolsRejected = true;
    }

    // 5. Agent loop: stream → parse tool calls → execute → feed results back,
    //    repeating until the model emits no tool calls. No iteration cap —
    //    the agent runs until the task is complete, the client disconnects,
    //    or `maxDuration` (set in the route handler) is exceeded.
    let fullContent = "";
    let fullThinking = "";
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastPromptTokens = 0;
    // Provenance of `lastPromptTokens`: true while it holds the BPE estimate
    // (set every iteration from the truncated history), false once a provider
    // measurement replaces it. Mirrored into the `estimated` flag of usage
    // events so the status-bar ring never shows an estimated value as
    // provider-measured data.
    let lastPromptTokensEstimated = true;
    // Last provider-measured promptTokens across the run; survives the
    // per-iteration estimate reset so a final iteration without usage (abort,
    // error) doesn't discard the reading.
    let lastMeasuredPromptTokens = 0;
    // Grounded Context — provider-measured totals (replaces BPE estimates
    // whenever the upstream reported usage for at least one iteration).
    let measuredIterations = 0;
    let measuredTokensIn = 0;
    let measuredTokensOut = 0;
    let measuredCacheReads = 0;
    let measuredCacheWrites = 0;
    // Token windowing: the `totalTokens*` / `measuredTokens*` accumulators
    // track the WHOLE run, but each persisted row and usage event must
    // report only the tokens accrued since the current row was created.
    // Rotation resets the window, so the stats API's per-message summation
    // reproduces the true run total instead of re-counting pre-rotation
    // cumulative totals on every rotated row.
    const windowStartTokensIn = 0;
    const windowStartTokensOut = 0;
    const windowStartMeasuredTokensIn = 0;
    const windowStartMeasuredTokensOut = 0;
    const windowTokens = () => {
      const useMeasured = measuredIterations > 0;
      return {
        tokensIn: useMeasured
          ? measuredTokensIn - windowStartMeasuredTokensIn
          : totalTokensIn - windowStartTokensIn,
        tokensOut: useMeasured
          ? measuredTokensOut - windowStartMeasuredTokensOut
          : totalTokensOut - windowStartTokensOut,
      };
    };
    let allToolCalls: ToolCall[] = [];
    const segments: Array<{ kind: "thinking" | "text" | "tool_call"; id: string; content?: string; toolCallId?: string }> = [];
    // Tool-reliability nudge: only fires once per executeChat run, only on
    // iter 0, only when no tool call was parsed but the response looks like
    // a (malformed) tool attempt. See detectToolAttempt() above.
    let nudged = 0;
    // Task 38-F.1: empty-response retry — once per run. If the model returns
    // an empty response (no content, no thinking, no tool calls), we inject
    // a nudge user message and retry the SAME iteration. If the second
    // attempt is also empty, we break.
    let emptyRetried = false;
    let emptyBarePromptTried = false;
    let thinkingOnlyNudged = false;
    // Completion-integrity nag (unresolved tool failures): injected into the
    // prompt before the model streams, so no duplicate "final answer" is
    // produced. Recomputed per iteration; never persisted.
    // toolCallIds whose execution was permission-denied — excluded from the
    // integrity nag (the model already received the explicit deny result and
    // prompting it to "retry the failed call" is wrong for a user denial).
    const deniedToolCallIds = new Set<string>();
    // finish_reason observed on the last stream attempt (`length` = the model
    // exhausted its output budget — documented behavior for reasoning models
    // whose thinking tokens count against max_tokens).
    let lastFinishReason: string | undefined;
    // Budget-starvation retry: at most once per run, retry with the model's
    // documented maximum output tokens from the models.dev registry instead
    // of stripping tools/thinking.
    let budgetRetried = false;
    let budgetMaxTokens: number | undefined;
    // The max_tokens value actually sent in the most recent stream attempt.
    let maxTokensUsed: number | undefined;
    // The concrete model id used for the most recent stream attempt (resolved
    // from "auto" selection), available to the empty-response ladder.
    let usedApiModel: string | undefined;
    // Statusless-upstream probe override: when a statusless error frame
    // (some gateways) 500s a request whose max_tokens exceeded the model's
    // documented registry max, the cap is applied here so it survives the
    // per-attempt recomputation of max_tokens on the retry.
    let statuslessMaxTokens: number | undefined;
    // `context_trimmed` SSE event is emitted at most once per executeChat
    // run (not per iteration) — the first time the context manager drops
    // messages to fit the model's context window. The frontend shows a
    // "Context trimmed" badge so the user knows older turns were elided.
    let contextTrimmedEmitted = false;


    // Emit a `stream_heartbeat` JSON event every 5s during the entire run so
    // the frontend knows the agent is still alive between tokens. (The route
    // already sends `: keepalive` SSE comments every 3s, but those aren't
    // parseable as JSON events — an explicit `stream_heartbeat` lets a future
    // frontend hook show a "still working…" indicator.) The frontend's
    // `dispatchEvent` switch safely ignores unknown event types.
    const heartbeatInterval = setInterval(() => {
      try {
        emit({ type: "stream_heartbeat", ts: Date.now() });
      } catch {
        /* emit may be closed */
      }
    }, 5_000);

    // Create a pre-agent checkpoint so the user can undo the first
    // interaction's changes (no prior checkpoint exists yet). Best-effort
    // — if the workspace isn't ready or checkpoints aren't supported, the
    // agent loop still proceeds.
    let preTurnCheckpointId: string | undefined;
    try {
      const cp = await createCheckpoint(conversation.userId, conversation.id, "Before agent run");
      preTurnCheckpointId = cp.id;
    } catch {
      /* non-critical — undo just won't be available on first interaction */
    }

    // Reports drained at the break path / finally arrived after the model's
    // final answer; when any exist and nothing else is pending, the finally
    // fires a wake so the client's sentinel synthesizes them.
    let drainedAfterAnswer = 0;

    // Queued turn ids this run actually answered (recorded when the terminal
    // point breaks with the pending marker cleared). Reported in the `done`
    // event so the client's fallback re-sender drops them instead of
    // re-sending — the fallback cannot detect the same-run answer itself,
    // because the executor persists exactly ONE assistant row per run,
    // created before the queued row existed.
    const answeredQueuedTurns: string[] = [];

    try {
      // In-memory conversation mirror with cursor-based deltas and memoized token estimates.
      const cachedRows: CachedRow[] = [];
      const tokenMemo = new Map<string, { content: string; tokens: number }>();
      const pendingRowUpdates = new Map<string, Partial<CachedRow>>();
      let cacheCursor: { createdAt: Date; id: string } | null = null;

      const toCachedRow = (r: {
        id: string;
        role: string;
        content: string;
        toolCallId: string | null;
        toolCalls: string | null;
        thinking: string | null;
        segments?: string | null;
        attachments: string | null;
        createdAt: Date;
      }): CachedRow => ({
        id: r.id,
        role: r.role,
        content: r.content,
        toolCallId: r.toolCallId,
        toolCalls: r.toolCalls,
        thinking: r.thinking,
        segments: r.segments,
        attachments: r.attachments,
        createdAt: r.createdAt,
      });

      /** Memoized token estimate keyed by message id + full message payload. */
      const tokenOf = (m: {
        id?: string | null;
        content: string;
        toolCalls?: any;
        thinking?: string | null;
        attachments?: any;
      }): number => {
        if (!m.id) return estimateMessageTokens(m);
        const hit = tokenMemo.get(m.id);
        if (hit && hit.content === m.content) return hit.tokens;
        const tokens = estimateMessageTokens(m);
        tokenMemo.set(m.id, { content: m.content, tokens });
        return tokens;
      };

      /** Loads conversation cache: initial full read followed by cursor-based deltas. */
      const loadHistoryOnce = async (): Promise<void> => {
        if (cachedRows.length === 0) {
          const rows = await db.message.findMany({
            where: { conversationId: conversation.id },
            orderBy: { createdAt: "asc" },
          });
          for (const r of rows) cachedRows.push(toCachedRow(r));
          const last = cachedRows[cachedRows.length - 1];
          if (last) cacheCursor = { createdAt: last.createdAt, id: last.id };
          return;
        }
        if (pendingRowUpdates.size > 0) {
          for (const [id, patch] of pendingRowUpdates) {
            const idx = cachedRows.findIndex((r) => r.id === id);
            if (idx >= 0) {
              cachedRows[idx] = { ...cachedRows[idx], ...patch };
              tokenMemo.delete(id);
            }
          }
          pendingRowUpdates.clear();
        }
        if (!cacheCursor) return;
        const fresh = await db.message.findMany({
          where: {
            conversationId: conversation.id,
            OR: [
              { createdAt: { gt: cacheCursor.createdAt } },
              { createdAt: cacheCursor.createdAt, id: { gt: cacheCursor.id } },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (fresh.length > 0) {
          const known = new Set(cachedRows.map((c) => c.id));
          for (const r of fresh) {
            if (known.has(r.id)) continue;
            known.add(r.id);
            cachedRows.push(toCachedRow(r));
          }
          const last = fresh[fresh.length - 1];
          cacheCursor = { createdAt: last.createdAt, id: last.id };
        }
      };

      // Model capability lookups are constant within a run (provider/model
      // cannot change mid-run) — resolved once, reused by every iteration.
      let cachedReasoningState: Awaited<ReturnType<typeof getModelReasoningState>> | null = null;
      let cachedByok: Awaited<ReturnType<typeof resolveByok>> | null = null;
      let cachedContextWindow: number | undefined;
      let cachedMaxOutput: number | undefined;
      const getRunModelContextWindow = async (): Promise<number | undefined> => {
        if (cachedContextWindow === undefined) {
          cachedContextWindow = (await getModelContextWindow(user.id, req.provider, req.model)) ?? 0;
        }
        return cachedContextWindow || undefined;
      };
      const getRunModelMaxOutput = async (): Promise<number | undefined> => {
        if (cachedMaxOutput === undefined) {
          cachedMaxOutput = (await getModelMaxOutput(user.id, req.provider, req.model)) ?? 0;
        }
        return cachedMaxOutput || undefined;
      };

      /** Synchronously compacts context by summarizing the middle turn history when budget triggers. */
      const compactContextNow = async (effectiveInputBudget: number, systemTokens: number): Promise<boolean> => {
        try {
          const window = applyCompactionWindow(cachedRows);
          if (window.length < 4) return false;

          const tailStart = selectCompactionTail(window, resolvePreserveRecentBudget(effectiveInputBudget), {
            tailTurns: ctxConfig.tailTurns ?? DEFAULT_CONTEXT_CONFIG.tailTurns,
            estimateMessageTokensFn: tokenOf,
          });
          // Skip compaction if insufficient history beyond current turns is preserveable.
          const cutIndex = tailStart ?? 0;
          if (cutIndex <= 0) return false;
          const firstKept = window[cutIndex];
          const droppedMsgs = window
            .slice(0, cutIndex)
            .filter((m) => !isCompactionMarker(m.content));
          if (droppedMsgs.length < 2 || !firstKept) return false;

          // Incremental compaction: fold in delta since last compact using previous summary as anchor.
          const previousSummary = (() => {
            for (const m of window) {
              if (m.role === "user") {
                const text = compactionSummaryText(m.content);
                if (text) return text;
              }
            }
            return undefined;
          })();

          const summaryText = await summarizeTranscript({
            userId: user.id,
            provider: req.provider,
            model: req.model,
            messages: droppedMsgs,
            maxPromptTokens: effectiveInputBudget,
            buildPrompt: (transcript) =>
              buildCompactionPrompt({ transcript, previousSummary }),
          });

          if (summaryText) {
            // Insert backdated summary message without deleting raw historical records.
            const created = await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "user",
                content: `<context_summary compacted="true">\n${summaryText}\n</context_summary>`,
                provider: req.provider,
                model: req.model,
                createdAt: new Date(firstKept.createdAt.getTime() - 1),
              },
            });
            // Mirror backdated summary into in-memory cache to ensure cursor-based visibility.
            const keepIdx = cachedRows.findIndex((r) => r.id === firstKept.id);
            const row = toCachedRow(created);
            if (keepIdx >= 0) {
              cachedRows.splice(keepIdx, 0, row);
            } else {
              cachedRows.push(row);
            }
            console.log(`[context] auto-compact complete: ${droppedMsgs.length} messages → 1 summary (history preserved)`);
            // Emit context_trimmed event with accurate post-compact token counts.
            const summaryEstTokens = estimateTokens(summaryText);
            const tailTokens = window.slice(cutIndex).reduce((s, m) => s + tokenOf(m), 0);
            const anchorTokens = window[0] ? tokenOf(window[0]) : 0;
            const postCompactTokens = anchorTokens + summaryEstTokens + tailTokens;
            emit({
              type: "context_trimmed",
              dropped: droppedMsgs.length - 1,
              keptTokens: postCompactTokens,
              activePromptTokens: systemTokens + postCompactTokens,
              via: "auto",
            });
            return true;
          }
        } catch (e) {
          console.warn("[context] auto-compact failed:", e);
        }
        return false;
      };

      registerActiveRun(user.id, conversation.id);
      // Tracks queued mid-loop user message IDs to force continuation until answered.
      let queuedTurnsPending: string[] = [];
      const effectiveMaxIterations =
        typeof req.maxIterations === "number" && req.maxIterations > 0
          ? req.maxIterations
          : MAX_ITERATIONS;
      const convergenceDetector = new ConvergenceDetector();
      for (let iter = 0; iter < effectiveMaxIterations; iter++) {
        if (signal?.aborted) {
          break;
        }
        // Auto-compact is limited to at most once per iteration (preventing loops
        // within a single turn), but can trigger in multiple distinct iterations.
        let autoCompactTriggered = false;
        // If this or a previous iteration detected that the API rejected tools,
        // permanently disable native tool calls and switch to text-fallback prompts.
        if (toolsRejected) {
          openaiTools = [];
          anthropicTools = [];
          if (baseSystemPrompt === NATIVE_SYSTEM_PROMPT) {
            baseSystemPrompt = buildTextFallbackSystemPrompt(enabledTools, mode);
            systemPrompt = baseSystemPrompt + toolSection + capabilitiesBlock + envBlock + discoveryBlock + missionBlock;
          }
        }
        // Real queuing: drain user turns queued while the loop was working
        // (rows already committed by the queue route) BEFORE the history
        // reload so the model call below sees them as the latest user turn.
        // APPEND to the pending list instead of replacing it: a turn drained
        // in an earlier iteration that forced the loop to keep going must not
        // lose its "never break until answered" marker when a later iteration
        // drains more turns.
        const queuedNow = takeQueuedUserTurns(user.id, conversation.id);
        if (queuedNow.length > 0) {
          queuedTurnsPending = [...queuedTurnsPending, ...queuedNow];
        }
        // Reload history each iteration so prior tool results are included —
        // served from the in-memory run cache (delta fetch of new rows only).
        await loadHistoryOnce();
        // Cursor-delta misses happen for turns queued mid-run: the queue route
        // commits the row in the same second as the previous cursor with a
        // client-generated UUID that sorts BELOW the cursor's id, so
        // `createdAt == cursor AND id > cursorId` excludes it forever. Recover
        // drained-but-uncached ids by primary key and splice them into the run
        // cache at their sorted position — the model must see them THIS
        // iteration (next-iteration pickup is the whole point of the queue).
        if (queuedTurnsPending.length > 0) {
          const missing = queuedTurnsPending.filter((id) => !cachedRows.some((c) => c.id === id));
          if (missing.length > 0) {
            const rows = await db.message.findMany({
              where: { id: { in: missing }, conversationId: conversation.id },
            });
            for (const row of rows) {
              if (cachedRows.some((c) => c.id === row.id)) continue;
              const rr = toCachedRow(row);
              const idx = cachedRows.findIndex(
                (c) => c.createdAt > row.createdAt
                  || (c.createdAt.getTime() === row.createdAt.getTime() && c.id > row.id),
              );
              if (idx === -1) cachedRows.push(rr);
              else cachedRows.splice(idx, 0, rr);
              tokenMemo.delete(row.id);
            }
          }
        }

        // Real-time queuing rotation: if new queued turns were JUST received (queuedNow.length > 0) AND this run has already produced content,
        // we rotate to a new row ONCE so the model's subsequent answer streams directly below the queued turns in real time.
        if (queuedNow.length > 0) {
          if (fullContent.trim() || fullThinking.trim() || segments.length > 0) {
            try {
              await db.message.update({
                where: { id: assistantMsg.id },
                data: {
                  content: fullContent,
                  thinking: fullThinking || null,
                  toolCalls: allToolCalls.length ? JSON.stringify(allToolCalls) : null,
                  segments: segments.length ? JSON.stringify(segments) : null,
                  tokensIn: 0,
                  tokensOut: 0,
                  latencyMs: 0,
                  promptTokens: 0,
                  cacheWrites: 0,
                  cacheReads: 0,
                },
              });
            } catch {
              /* best-effort persist */
            }
            try { emit({ type: "done", messageId: assistantMsg.id }); } catch {}
            const rotated = await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "assistant",
                content: "",
                provider: req.provider,
                model: req.model,
              },
            });
            try { emit({ type: "start", messageId: rotated.id }); } catch {}
            if (!cachedRows.some((c) => c.id === rotated.id)) {
              const rr = toCachedRow(rotated);
              const idx = cachedRows.findIndex(
                (c) => c.createdAt > rotated.createdAt
                  || (c.createdAt.getTime() === rotated.createdAt.getTime() && c.id > rotated.id),
              );
              if (idx === -1) cachedRows.push(rr);
              else cachedRows.splice(idx, 0, rr);
              tokenMemo.delete(rotated.id);
            }
            assistantMsg = rotated;
            fullContent = "";
            fullThinking = "";
            segments.length = 0;
            allToolCalls = [];
          } else {
            // Nothing produced yet; just bump the current row's timestamp so it sorts below the queued turns.
            try {
              await db.message.update({
                where: { id: assistantMsg.id },
                data: { createdAt: new Date() },
              });
            } catch {}
            const bumpIdx = cachedRows.findIndex((c) => c.id === assistantMsg.id);
            if (bumpIdx >= 0) {
              const [moved] = cachedRows.splice(bumpIdx, 1);
              moved.createdAt = new Date();
              const insIdx = cachedRows.findIndex(
                (c) => c.createdAt > moved.createdAt
                  || (c.createdAt.getTime() === moved.createdAt.getTime() && c.id > moved.id),
              );
              if (insIdx === -1) cachedRows.push(moved);
              else cachedRows.splice(insIdx, 0, moved);
              tokenMemo.delete(moved.id);
            }
          }
        }

        let history = mapHistory(applyCompactionWindow(cachedRows));

        // Apply OpenCode Stage 1: Prune old tool outputs (configurable
        // protection window). Token estimates come from the memoized cache.
        let { messages: prunedHistory } = pruneOldToolOutputs(history, ctxConfig, tokenOf);

        // Inject think-tag instruction only when the resolved reasoning plan
        // will emit reasoning parameters (per the plan resolved below).
        // Provider-level blanket injection is removed: it inflated the prompt
        // for models that handle reasoning natively (e.g. MiniMax M3 uses
        // the `reasoning_content` field, not text tags).
        const reasoningState =
          cachedReasoningState ?? (cachedReasoningState = await getModelReasoningState(user.id, req.provider, req.model));
        const rawUserLevel = (req.thinkingLevel as string | undefined) ?? reasoningState.userLevel;
        let anthropicMode: "adaptive" | "extended" = "adaptive";
        let reasoningPlan: ReasoningPlan | undefined;
        const thinkPlan = resolveReasoningPlan({
          providerId: req.provider,
          userLevel: rawUserLevel,
          caps: reasoningState.caps,
          anthropicMode,
        });
const thinkInstruction = thinkPlan.kind === "params"
          ? "\n\nCRITICAL: If you perform internal Chain-of-Thought reasoning or self-talk, enclose it strictly inside  thinking... response tags before providing your final response prose."
          : "";
        // Completion-integrity nag: fires BEFORE the model streams, so the
        // iteration that would otherwise finish already has the failure list
        // in its prompt (post-hoc injection re-answered after an
        // already-streamed summary, duplicating it).
        const integrityNudge = buildCompletionIntegrityNudge(allToolCalls, deniedToolCallIds);
        const iterSystemPrompt = scrubPromptString(
          integrityNudge
            ? `${systemPrompt + thinkInstruction}\n\n${integrityNudge}`
            : systemPrompt + thinkInstruction,
          securitySettings,
        ) ?? "";

        // Model capability lookups are constant within a run (provider/model
        // cannot change mid-run) — resolved once and reused across iterations.
        const modelContextWindow = await getRunModelContextWindow();
        const modelMaxOutput = await getRunModelMaxOutput();
        const systemTokens = estimateTokens(iterSystemPrompt + toolSection);
        // Use PRE-truncation token count for overflow detection. After truncateHistory
        // runs, keptTokens already fits within the budget, so checking it would always
        // say "no overflow" — and auto-compact would never trigger.
        let preTruncationTokens =
          prunedHistory.reduce((sum, m) => sum + tokenOf(m), 0) + systemTokens;
        // Grounded Context: the auto-compact trigger uses the model's effective
        // input budget (Cline-compatible resolution) instead of a fixed fraction
        // of the total window. When the provider-declared input limit is known it
        // wins; otherwise the budget defaults to CONTEXT_WINDOW_INPUT_RATIO of the
        // context window so the indicator and the trigger always agree.
        const effectiveInputBudget =
          resolveEffectiveMaxInputBudget({ contextWindow: modelContextWindow }) ?? modelContextWindow ?? 0;

        // Auto-compact: trigger model-based summarization when the context
        // reaches COMPACTION_TRIGGER_RATIO (0.9) of the effective input budget.
        // Runs SYNCHRONOUSLY (Cline-compatible): the summary replaces the
        // dropped middle BEFORE the truncation below, so messages are never
        // dropped without being summarized first — no fire-and-forget loss
        // window. Triggering too early wastes tokens; too late risks dropping
        // useful context.
        const hasOverflow = isContextOverflow(preTruncationTokens, modelContextWindow ?? 0, modelMaxOutput, ctxConfig);
        // Ground the auto-compact trigger on the same value the status-bar
        // indicator displays: provider-measured prompt tokens (lastPromptTokens)
        // when present, else the BPE estimate. The estimate alone undercounts
        // against real tokenizers, which is why compaction previously fired far
        // later than the ring's 90% reading — or not at all before an overflow.
        const triggerContextTokens = Math.max(preTruncationTokens, lastPromptTokens);
        const capacityHit =
          effectiveInputBudget > 0 && triggerContextTokens >= COMPACTION_TRIGGER_RATIO * effectiveInputBudget;
        if ((hasOverflow || capacityHit) && !autoCompactTriggered) {
          console.log(
            `[context] auto-compact triggered: context=${triggerContextTokens} (${Math.round((triggerContextTokens / effectiveInputBudget) * 100)}% of effective budget=${Math.round(effectiveInputBudget)})`,
          );
          const compacted = await compactContextNow(effectiveInputBudget, systemTokens);
          if (compacted) {
            autoCompactTriggered = true;
            // Rebuild the working history from the compacted cache so THIS
            // iteration (not just the next one) sees the summary.
            history = mapHistory(applyCompactionWindow(cachedRows));
            prunedHistory = pruneOldToolOutputs(history, ctxConfig, tokenOf).messages;
            preTruncationTokens =
              prunedHistory.reduce((sum, m) => sum + tokenOf(m), 0) + systemTokens;
          }
        }

        const truncateResult = truncateHistory(
          prunedHistory,
          iterSystemPrompt + toolSection,
          {
            contextWindow: modelContextWindow,
            maxOutputTokens: modelMaxOutput,
            tailTurns: ctxConfig.tailTurns ?? 2,
            contextConfig: ctxConfig,
            estimateToken: tokenOf,
          },
        );
        const truncatedHistory = scrubHistoryForWire(truncateResult.messages, securitySettings);
        const droppedCount = truncateResult.dropped;
        const keptTokens = truncateResult.keptTokens;
        lastPromptTokens = systemTokens + keptTokens;
        lastPromptTokensEstimated = true;
        const contextUsagePct = modelContextWindow ? (systemTokens + keptTokens) / modelContextWindow : 0;

        if (droppedCount > 0) {
          console.log(
            `[context] dropped ${droppedCount} messages to fit context window ` +
              `(model=${req.provider}/${req.model}, window=${modelContextWindow}, usage=${Math.round(contextUsagePct * 100)}%)`,
          );
          if (!contextTrimmedEmitted) {
            contextTrimmedEmitted = true;
            emit({
              type: "context_trimmed",
              dropped: droppedCount,
              keptTokens,
              activePromptTokens: systemTokens + keptTokens,
              via: "overflow",
            });
          }
        }

        let imageData: ResolvedImageData | undefined;
        const isVisionModel = modelSupportsVision(req.provider, req.model);
        if (isVisionModel) {
          imageData = await resolveHistoryImages(truncatedHistory, user.id, conversation.id);
        }

        // Build provider-specific message history and resolve reasoning-echo requirements.
        const byok = cachedByok ?? (cachedByok = await resolveByok(user.id, req.provider).catch(() => null));
        // Determines if reasoning_content must be echoed back on assistant messages.
        let echoReasoning =
          requiresReasoningEcho(byok?.baseUrl) ||
          reasoningState.caps?.interleavedField === "reasoning_content";
        let echoUpgradedThisIteration = false;
        let messagesForModel: OpenAIMessage[];
        if (req.provider === "anthropic") {
          messagesForModel = [];
        } else {
          messagesForModel = toOpenAIMessagesWithTools(
            iterSystemPrompt,
            truncatedHistory,
            imageData,
            isVisionModel,
            echoReasoning,
          );
        }
        const tokensIn = estimateTokens(
          (Array.isArray(messagesForModel) ? messagesForModel : [])
            .map((m) => {
              if (typeof m.content === "string") return m.content ?? "";
              if (Array.isArray(m.content)) return m.content.map((b) => "text" in b ? b.text : "[image]").join("\n");
              return "";
            })
            .join("\n"),
        );
        totalTokensIn += tokensIn;

        // Live context estimate (pre-stream): emit current prompt tokens before streaming when no measured usage exists yet.
        if (measuredIterations === 0) {
          emit({
            type: "usage",
            ...windowTokens(),
            promptTokens: lastPromptTokens,
            cacheWrites: measuredCacheWrites,
            cacheReads: measuredCacheReads,
            model: req.model,
            provider: req.provider,
            estimated: lastPromptTokensEstimated,
          });
        }

        // Stream this iteration's response.
        // Task 38-G: buffer partial tool-call fences so the user doesn't see
        // raw `\`\`\`tool_call\n{"tool":...` text flash in the chat while
        // the model is mid-stream.
        let iterContent = "";
        let iterThinking = "";
        let prevCleanedLen = 0;
        let nativeToolCalls: NativeToolCall[] = [];
        let streamSucceeded = false;
        // Provider-measured usage for this iteration (undefined = not reported).
        let iterMeasured: MeasuredUsage | undefined;
        let lastStreamError: unknown;
        let forceDisableThinking = false;
        // Set when the retry ladder drops the reasoning parameters after a
        // 400/405/422; the host is only remembered as "rejects reasoning"
        // once the parameter-free retry actually SUCCEEDS (see the success
        // path below) — never on an unconfirmed rejection.
        let stripRetryPending = false;
        // Bounds for the statusless-upstream probes below (some gateways'
        // HTTP-200 SSE error frames): each probe fires at most once per
        // iteration, so a genuine outage costs one extra attempt and then
        // surfaces the real error.
        let statuslessRetried = false;
        let statuslessEchoProbed = false;

        // Commit the current (possibly partial) iteration's streamed content
        // into `fullContent`/`fullThinking` so an abort never loses text the
        // client already received. Think-tag extraction + stripping mirror
        // the normal post-stream path (THINK_TAGS_RE etc.) so the persisted
        // message matches exactly what the chat/status-bar displayed. The
        // thinking merge is guarded against double-appending chunk-level
        // thinking that was already folded into `fullThinking` while the
        // stream was live.
        const commitPartialIteration = () => {
          if (!iterContent && !iterThinking) return;
          const thinkMatches = [...iterContent.matchAll(THINK_TAGS_RE)];
          for (const m of thinkMatches) {
            const thinkText = m[0]
              .replace(/^<(?:think|thinking|thought|reasoning|cot|details)>/i, "")
              .replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>$/i, "");
            if (thinkText && !iterThinking.includes(thinkText.slice(0, 40))) {
              iterThinking += thinkText;
            }
          }
          // Strip think tags and tool call blocks to prevent raw XML/fences from leaking to stored prose.
          const tagStripped = iterContent
            .replace(THINK_TAGS_RE, "")
            .replace(THINK_UNCLOSED_RE, "")
            .replace(THINK_MALFORMED_OPEN_RE, "")
            .replace(THINK_STANDALONE_CLOSE_RE, "")
            .replace(MODEL_SELF_INSTRUCTIONS_RE, "");
          const stripped = stripToolCallBlocks(tagStripped);
          const partial =
            collapseDuplicateLines(
              stripped || (parseToolCalls(tagStripped).length ? "" : tagStripped),
            ) ||
            // Mirror the normal post-stream fallback: thinking-only output
            // persists as prose instead of an empty message.
            (parseToolCalls(tagStripped).length === 0 ? iterThinking.trim() : "");
          if (partial) {
            fullContent += (fullContent ? "\n\n" : "") + partial;
            totalTokensOut += estimateTokens(partial);
          }
          if (iterThinking.trim()) {
            const head = iterThinking.slice(0, 80);
            if (!fullThinking.includes(head)) {
              fullThinking += (fullThinking ? "\n\n" : "") + iterThinking;
            }
          }
        };

        // Retry transient errors (network, 5xx, 429) with exponential backoff.
        for (let streamAttempt = 0; ; streamAttempt++) {
          // Snapshot segment count to roll back UI segments on retry failure.
          const segCountBefore = segments.length;
          iterContent = "";
          iterThinking = "";
          prevCleanedLen = 0;
          nativeToolCalls = [];
          iterMeasured = undefined;
          const tcBuffer = new BufferedToolCallStream();
          try {
            emit({ type: "thinking_reset" });
            // `byok` was resolved once per iteration above (before the message
            // history was built) and is reused across stream attempts.
            if (!byok) {
              emit({
                type: "error",
                message: `No API key configured for ${req.provider}. Add it in Settings.`,
                code: "NO_KEY",
              });
              // Break out of BOTH the streamAttempt loop AND the iter loop.
              streamSucceeded = true; // skip the error-emit path
              throw new Error("__NO_KEY__");
            }
            let apiModel = resolveModel(req.provider, req.model);            usedApiModel = apiModel;
            // If the model is still "auto" (no static catalog), try the first
            // stored model from the user's provider key.
            if (apiModel === "auto" && byok) {
              try {
                const pkRow = await db.providerKey.findUnique({
                  where: { userId_provider: { userId: user.id, provider: req.provider } },
                  select: { models: true },
                });
                if (pkRow?.models) {
                  const parsed = JSON.parse(pkRow.models);
                  if (Array.isArray(parsed)) {
                    const first = parsed.find((m: any) => m.id && m.id !== "auto" && m.enabled !== false);
                    if (first?.id) apiModel = first.id;
                  }
                }
              } catch { /* fall through */ }
            }
            if (apiModel === "auto") {
              emit({
                type: "error",
                message: `No model configured for ${req.provider}. Open Settings → Providers and select a model.`,
                code: "NO_MODEL",
              });
              streamSucceeded = true;
              throw new Error("__NO_MODEL__");
            }
            let maxTokens = await getModelMaxOutput(
              user.id,
              req.provider,
              apiModel,
            );
            if (maxTokens === undefined) {
              await refreshProviderModels(user.id, req.provider as any);
              maxTokens = await getModelMaxOutput(user.id, req.provider, apiModel);
            }
            // No invented fallback for unknown models: OpenAI-compatible
            // providers (openai, openrouter, groq, …) treat
            // `max_tokens` as optional and apply their own documented
            // server-side default when omitted — so the field is simply
            // left out. Anthropic's Messages API requires `max_tokens`;
            // streamAnthropic applies the official SDK default (4096)
            // there. Budget-starvation retry override: raise to the
            // model's documented registry max output (see the
            // length-retry below).
            if (budgetMaxTokens !== undefined) maxTokens = budgetMaxTokens;
            // Statusless-upstream probe cap (see the retry ladder): applied
            // on every attempt so the stripped retry never re-sends a
            // max_tokens above the model's documented registry maximum.
            if (statuslessMaxTokens !== undefined) maxTokens = statuslessMaxTokens;
            if (maxTokens !== undefined && modelContextWindow !== undefined && modelContextWindow > 0) {
              const promptTokens = systemTokens + keptTokens;
              const remainingBudget = modelContextWindow - promptTokens;
              if (remainingBudget > 0) {
                maxTokens = Math.min(maxTokens, remainingBudget);
              }
            }
            maxTokensUsed = maxTokens;
            // Resolve the reasoning plan from the user's level + live model
            // capabilities. The scheme maps the level onto the provider's
            // official reasoning parameters; unsupported selections are
            // clamped, never invented. Caps and the per-model thinking level
            // live on the CONCRETE model entry, so re-resolve against
            // `apiModel` when the request used "auto".
            const planReasoningState =
              apiModel !== req.model
                ? await getModelReasoningState(user.id, req.provider, apiModel)
                : reasoningState;
            reasoningPlan = resolveReasoningPlan({
              providerId: req.provider,
              userLevel: req.thinkingLevel ?? planReasoningState.userLevel,
              caps: planReasoningState.caps,
              maxTokens: maxTokens ?? undefined,
              anthropicMode,
              stripReasoning: forceDisableThinking,
              hostRejectsReasoning: hostRejectsReasoning(byok?.baseUrl),
              modelRejectsReasoning: modelRejectsReasoning(byok?.baseUrl, apiModel),
            });
            if (req.provider === "anthropic") {
              for await (const chunk of streamAnthropic(
                byok.baseUrl,
                byok.apiKey,
                apiModel,
                iterSystemPrompt,
                truncatedHistory,
                req.temperature,
                signal,
                anthropicTools,
                maxTokens,
                reasoningPlan,
                imageData,
              )) {
                if (chunk.type === "tools_rejected") {
                  toolsRejected = true;
                  setToolsRejected(conversation.id, req.provider, req.model);
                  continue;
                }
                if (chunk.type === "finish") {
                  lastFinishReason = chunk.reason;
                  continue;
                }
                if (chunk.type === "usage") {
                  iterMeasured = chunk.usage;
                  continue;
                }
                if (chunk.type === "thinking") {
                  iterThinking += chunk.text;
                  fullThinking += chunk.text;
                  emit({ type: "thinking", content: chunk.text });
                  const lastSeg = segments[segments.length - 1];
                  if (lastSeg && lastSeg.kind === "thinking") {
                    lastSeg.content = (lastSeg.content ?? "") + chunk.text;
                  } else {
                    segments.push({
                      kind: "thinking",
                      id: `seg-think-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      content: chunk.text,
                    });
                  }
                  continue;
                }
                if (chunk.type === "signature") {
                  const lastSeg = segments[segments.length - 1];
                  if (lastSeg && lastSeg.kind === "thinking") {
                    (lastSeg as any).signature = ((lastSeg as any).signature ?? "") + chunk.signature;
                    (lastSeg as any).thoughtSignature = ((lastSeg as any).thoughtSignature ?? "") + chunk.signature;
                  }
                  continue;
                }
                if (chunk.type === "tool_calls") {
                  nativeToolCalls = chunk.calls;
                  continue;
                }
                const safe = tcBuffer.push(chunk.text);
                if (safe) {
                  iterContent += safe;
                  const fullCleaned = stripToolResultEchoesSafe(
                      iterContent
                        .replace(THINK_TAGS_RE, "")
                        .replace(THINK_UNCLOSED_RE, "")
                        .replace(THINK_MALFORMED_OPEN_RE, "")
                        .replace(THINK_STANDALONE_CLOSE_RE, "")
                        .replace(MODEL_SELF_INSTRUCTIONS_RE, ""),
                  );
                  const cleaned = collapseDuplicateLines(fullCleaned.slice(prevCleanedLen));
                  prevCleanedLen = fullCleaned.length;
                  if (cleaned) {
                    emit({ type: "delta", content: cleaned });
                    const lastSeg = segments[segments.length - 1];
                    if (lastSeg && lastSeg.kind === "text") {
                      lastSeg.content = (lastSeg.content ?? "") + cleaned;
                    } else {
                      segments.push({
                        kind: "text",
                        id: `seg-text-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        content: cleaned,
                      });
                    }
                  }
                }
              }
            } else {
              for await (const chunk of streamOpenAICompatible(
                byok.baseUrl,
                byok.apiKey,
                apiModel,
                messagesForModel as OpenAIMessage[],
                req.temperature,
                signal,
                reasoningPlan,
                openaiTools,
                maxTokens,
                req.provider,
              )) {
                if (chunk.type === "tools_rejected") {
                  toolsRejected = true;
                  setToolsRejected(conversation.id, req.provider, req.model);
                  continue;
                }
                if (chunk.type === "finish") {
                  lastFinishReason = chunk.reason;
                  continue;
                }
                if (chunk.type === "usage") {
                  iterMeasured = chunk.usage;
                  continue;
                }
                if (chunk.type === "thinking") {
                  iterThinking += chunk.text;
                  fullThinking += chunk.text;
                  emit({ type: "thinking", content: chunk.text });
                  const lastSeg = segments[segments.length - 1];
                  if (lastSeg && lastSeg.kind === "thinking") {
                    lastSeg.content = (lastSeg.content ?? "") + chunk.text;
                  } else {
                    segments.push({
                      kind: "thinking",
                      id: `seg-think-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      content: chunk.text,
                    });
                  }
                  continue;
                }
                if (chunk.type === "signature") {
                  const lastSeg = segments[segments.length - 1];
                  if (lastSeg && lastSeg.kind === "thinking") {
                    (lastSeg as any).signature = ((lastSeg as any).signature ?? "") + chunk.signature;
                    (lastSeg as any).thoughtSignature = ((lastSeg as any).thoughtSignature ?? "") + chunk.signature;
                  }
                  continue;
                }
                if (chunk.type === "tool_calls") {
                  nativeToolCalls = chunk.calls;
                  continue;
                }
                const safe = tcBuffer.push(chunk.text);
                if (safe) {
                  iterContent += safe;
                  const fullCleaned = stripToolResultEchoesSafe(
                    iterContent
                      .replace(THINK_TAGS_RE, "")
                      .replace(THINK_UNCLOSED_RE, "")
                      .replace(THINK_MALFORMED_OPEN_RE, "")
                      .replace(THINK_STANDALONE_CLOSE_RE, "")
                      .replace(MODEL_SELF_INSTRUCTIONS_RE, ""),
                  );
                  const cleaned = collapseDuplicateLines(fullCleaned.slice(prevCleanedLen));
                  prevCleanedLen = fullCleaned.length;
                  if (cleaned) {
                    emit({ type: "delta", content: cleaned });
                    const lastSeg = segments[segments.length - 1];
                    if (lastSeg && lastSeg.kind === "text") {
                      lastSeg.content = (lastSeg.content ?? "") + cleaned;
                    } else {
                      segments.push({
                        kind: "text",
                        id: `seg-text-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        content: cleaned,
                      });
                    }
                  }
                }
              }
            }
            // OVERWRITE iterContent with the full accumulated text. The
            // intermediate `iterContent += safe` above only captured the
            // safe-to-emit portion (which EXCLUDES tool-call blocks). The
            // full text is needed so parseToolCalls can find tool calls.
            iterContent = tcBuffer.getFullText();

            // Commit this iteration's provider-measured usage (Grounded
            // Context). When the provider reported usage, it REPLACES the
            // BPE estimate in the persisted/emitted totals; otherwise the
            // estimate remains the fallback (clearly "not reported").
            if (iterMeasured) {
              measuredIterations++;
              if (iterMeasured.promptTokens !== undefined) {
                measuredTokensIn += iterMeasured.promptTokens;
                lastMeasuredPromptTokens = iterMeasured.promptTokens;
                lastPromptTokens = iterMeasured.promptTokens;
                lastPromptTokensEstimated = false;
              }
              if (iterMeasured.completionTokens !== undefined) {
                measuredTokensOut += iterMeasured.completionTokens;
              }
              measuredCacheReads += iterMeasured.cacheReadTokens ?? 0;
              measuredCacheWrites += iterMeasured.cacheWriteTokens ?? 0;

              // Live context update: emit measured usage on every iteration so
              // the status-bar indicator grows in real time as the agent works
              // and — critically — keeps the latest reading when the client
              // aborts mid-run instead of waiting for the single end-of-run
              // event. Emitted only when the provider reported usage, so the
              // ring keeps its "usage not reported" empty state for providers
              // that never send measurements (no invented heuristic fill).
              emit({
                type: "usage",
                ...windowTokens(),
                promptTokens: lastPromptTokens,
                cacheWrites: measuredCacheWrites,
                cacheReads: measuredCacheReads,
                model: req.model,
                provider: req.provider,
                estimated: lastPromptTokensEstimated,
              });
            }

            // Extract <think> content into iterThinking BEFORE stripping it.
            // Some models (DeepSeek, StepFun, Qwen) route ALL
            // their output through <think>...</think> tags in the content
            // stream rather than using a separate reasoning_content field.
            // Without this, stripping the tags leaves iterContent empty and
            // iterThinking empty, causing a false EMPTY_RESPONSE error even
            // though the model produced real output (163 tokens etc.).
            {
              const thinkMatches = [...iterContent.matchAll(THINK_TAGS_RE)];
              for (const m of thinkMatches) {
                const thinkText = m[0].replace(/^<(?:think|thinking|thought|reasoning|cot|details)>/i, "").replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>$/i, "");
                if (thinkText && !iterThinking.includes(thinkText.slice(0, 40))) {
                  // Only add to iterThinking if it wasn't already captured
                  // via the streaming chunk path (to avoid duplication).
                  iterThinking += thinkText;
                  if (!fullThinking.includes(thinkText.slice(0, 40))) {
                    fullThinking += thinkText;
                    emit({ type: "thinking", content: thinkText });
                    const lastSeg = segments[segments.length - 1];
                    if (lastSeg && lastSeg.kind === "thinking") {
                      lastSeg.content = (lastSeg.content ?? "") + thinkText;
                    } else {
                      segments.push({
                        kind: "thinking",
                        id: `seg-think-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        content: thinkText,
                      });
                    }
                  }
                }
              }
            }

            // Now strip think tags from iterContent so parseToolCalls and the
            // empty-response check work against the actual prose/tool output.
            iterContent = iterContent.replace(THINK_TAGS_RE, "");
            // Also strip unclosed <think> tags (e.g. streaming ended before
            // the closing tag — some models sometimes do this).
            iterContent = iterContent.replace(THINK_UNCLOSED_RE, "");
            // Strip malformed <think tags without a closing `>` (some models
            // output `<think\n\nHello` instead of `<think>...</think>`).
            iterContent = iterContent.replace(THINK_MALFORMED_OPEN_RE, "");
            // Also strip standalone </think> tags (model sends closing
            // tag without an opening tag).
            iterContent = iterContent.replace(THINK_STANDALONE_CLOSE_RE, "");

            // Content deltas already emitted per-chunk during streaming.

            // If the reasoning echo was enabled by the retry path above and
            // this request SUCCEEDED, remember the gateway so future
            // requests include the echo from the start.
            if (echoUpgradedThisIteration && byok) {
              rememberReasoningEchoRequired(byok.baseUrl);
            }
            // If the reasoning parameters were stripped by the retry ladder
            // and this request SUCCEEDED, remember the host AND the specific
            // model so future requests skip reasoning parameters from the
            // start. Model-scoped learning (gateways where reasoning support
            // varies per model) is recorded alongside the host-level flag;
            // only the confirmed success path marks either
            // (see learn.ts) — a bare 400/405/422 with an unrelated cause
            // (bad model, malformed body) would otherwise disable reasoning
            // for the whole process or endpoint.
            if (stripRetryPending && byok) {
              rememberReasoningRejected(byok.baseUrl);
              rememberModelRejectsReasoning(byok.baseUrl, apiModel);
              stripRetryPending = false;
            }

            streamSucceeded = true;
            break;
          } catch (err) {
            lastStreamError = err;
            // Roll back segments to before this attempt so failed stream
            // data doesn't leak into the retry's output, creating duplicate
            // or out-of-order segments (thinking blocks, text fragments).
            // EXCEPT on abort: the client already received and displayed
            // this attempt's deltas — rolling them back would sever the
            // persisted message from what the user saw.
            if (!signal?.aborted && segments.length > segCountBefore) {
              segments.splice(segCountBefore);
            }
            // The failed attempt's partial stream is discarded (segments
            // rolled back above). Clear the buffers so a later abort during
            // this retry's backoff cannot commit content whose segments were
            // already rolled back — the persisted message would otherwise
            // carry text its own segment list contradicts (the client's live
            // view of transient-failure deltas is a pre-existing artifact;
            // the DB must stay self-consistent).
            if (!signal?.aborted) {
              iterContent = "";
              iterThinking = "";
            }
            // Special sentinel for the no-key case — break BOTH loops.
            if (err instanceof Error && (err.message === "__NO_KEY__" || err.message === "__NO_MODEL__")) {
              streamSucceeded = true; // skip error-emit; we already emitted the user-facing event
              break;
            }
            if (signal?.aborted) {
              // Client disconnected — don't retry, just break.
              streamSucceeded = true; // skip error-emit (abort is intentional)
              break;
            }
            // Retry with reasoning echo enabled if gateway returns 4xx when past thinking exists.
            const errStatus = getErrorStatusCode(err);
            if (
              !echoReasoning &&
              echoUpgradedThisIteration === false &&
              byok &&
              typeof errStatus === "number" &&
              errStatus >= 400 &&
              errStatus < 500 &&
              errStatus !== 408 &&
              errStatus !== 429 &&
              truncatedHistory.some((m) => !!(m.thinking && m.thinking.trim()))
            ) {
              echoReasoning = true;
              echoUpgradedThisIteration = true;
              messagesForModel = toOpenAIMessagesWithTools(
                iterSystemPrompt,
                truncatedHistory,
                imageData,
                isVisionModel,
                true,
              );
              streamAttempt--; // do not consume the stream-attempt budget
              continue;
            }
            // Fall back automatically on parameter rejection client errors (400/405/422).
            if (!forceDisableThinking && reasoningPlan?.kind === "params") {
              const errStatus = getErrorStatusCode(err);
              if (req.provider === "anthropic" && anthropicMode === "adaptive" && errStatus === 400) {
                // Retry Anthropic adaptive thinking with extended thinking on 400.
                console.warn("[executor] Anthropic adaptive thinking rejected (400). Retrying with extended thinking:", err);
                anthropicMode = "extended";
                streamAttempt--;
                continue;
              }
              if (req.provider === "anthropic" && anthropicMode === "extended" && errStatus === 400) {
                // Retry Anthropic extended thinking without thinking parameters on 400.
                console.warn("[executor] Anthropic extended thinking rejected (400). Retrying without thinking parameters:", err);
                forceDisableThinking = true;
                streamAttempt--;
                continue;
              }
              if (errStatus === 400 || errStatus === 405 || errStatus === 422) {
                // Flag behavioral scheme learning on parameter failure.
                if (isBehavioralScheme(reasoningPlan.scheme)) {
                  stripRetryPending = true;
                }
                console.warn("[executor] Request with thinking parameters failed. Retrying without thinking parameters:", err);
                forceDisableThinking = true;
                streamAttempt--; // do not consume a transient streamAttempt counter
                continue;
              }
            }
            // Probe parameter recovery on statusless upstream error frames (HTTP 200 with error JSON).
            if ((err as any)?.statuslessUpstream && !statuslessRetried && !statuslessEchoProbed) {
              const regMax = (await peekModelInRegistry(usedApiModel ?? req.model, req.provider, { core: true }).catch(() => null))?.maxOutput;
              const oversized =
                maxTokensUsed !== undefined && regMax !== undefined && maxTokensUsed > regMax;
              if (oversized) {
                // Cap max_tokens to the model's documented registry max —
                // never above an official cap.
                statuslessMaxTokens = regMax;
                maxTokensUsed = regMax;
              }
              if (reasoningPlan?.kind === "params") {
                // Probe 1: reasoning parameters were in flight — strip them.
                statuslessRetried = true;
                console.warn("[executor] Statusless upstream error with reasoning parameters in flight — retrying stripped:", err);
                forceDisableThinking = true;
                streamAttempt--; // do not consume a transient streamAttempt counter
                continue;
              }
              // Probe 2: test reasoning echo if past thinking text is present.
              if (
                !echoReasoning &&
                byok &&
                truncatedHistory.some((m) => !!(m.thinking && m.thinking.trim()))
              ) {
                statuslessEchoProbed = true;
                echoReasoning = true;
                echoUpgradedThisIteration = true;
                messagesForModel = toOpenAIMessagesWithTools(
                  iterSystemPrompt,
                  truncatedHistory,
                  imageData,
                  isVisionModel,
                  true,
                );
                console.warn("[executor] Statusless upstream error — probing with reasoning-content echo:", err);
                streamAttempt--; // do not consume a transient streamAttempt counter
                continue;
              }
            }
            const msg = err instanceof Error ? err.message : String(err);
            const status = getErrorStatusCode(err);
            const is429 = status === 429 || /429|rate limit|too many requests/i.test(msg);
            const isTransient = isTransientStreamError(err);
            const maxAttempts = is429 ? 15 : 3;
            if (!isTransient || streamAttempt >= maxAttempts - 1) {
              // Non-retryable, or retries exhausted — fall through to emit + break.
              streamSucceeded = false;
              break;
            }
            // Transient — wait and retry with exponential backoff + jitter or header reset
            let delay = (is429 ? 2000 : 1000) * Math.pow(2, streamAttempt) + Math.random() * 500;
            const headerMs = (err as any)?.retryAfterMs || parseRetryHeader((err as any)?.retryAfter);
            if (is429 && headerMs !== null && headerMs > 0) {
              delay = Math.min(headerMs, 120000);
            }

            emit({
              type: "rate_limit_retry",
              retryAfterMs: delay,
              attempt: streamAttempt + 1,
              maxAttempts,
              conversationId: conversation.id,
            });

            console.warn(
              `[stream-retry] attempt ${streamAttempt + 1}/${maxAttempts} after ${Math.round(delay)}ms: ${msg.slice(0, 120)}`,
            );

            // Fine-grained sleep loop checking for client abort signal
            const startTime = Date.now();
            while (Date.now() - startTime < delay) {
              if (signal?.aborted) {
                break;
              }
              await new Promise((r) => setTimeout(r, Math.min(1000, delay - (Date.now() - startTime))));
            }

            if (signal?.aborted) {
              streamSucceeded = true; // skip error-emit (abort is intentional)
              break;
            }
          }
        }

        if (!streamSucceeded) {
          const msg =
            lastStreamError instanceof Error
              ? lastStreamError.message
              : "Streaming failed.";
          // Surface the upstream response body if present, so users can see the
          // actual reason NIM (or another gateway) rejected the request — e.g.
          // quota exhausted, invalid model id, etc. Many gateways return 429
          // with an explanatory JSON body that is otherwise swallowed.
          let enriched = msg;
          if (lastStreamError instanceof Error && "responseBody" in lastStreamError) {
            const body = (lastStreamError as Error & { responseBody?: string }).responseBody || "";
            if (body && !msg.includes(body)) {
              enriched = `${msg} | upstream body: ${body}`;
            }
          }
          // On 404, append a hint — the model may have been retired by the provider
          // but still listed in /models. Suggest refreshing the model list.
          const status = getErrorStatusCode(lastStreamError);
          if (status === 404) {
            enriched += `\n\nThis model may no longer be available on ${req.provider}. Try refreshing your model list in Settings → Providers, or switch to a different model.`;
            // Auto-disable the dead model so it disappears from the selector
            disableDeadModel(user.id, req.provider, req.model).catch(() => {});
          }
          emit({ type: "error", message: enriched, code: "STREAM_ERROR" });
          break;
        }
        if (!streamSucceeded) {
          break;
        }
        if (
          lastStreamError instanceof Error &&
          (lastStreamError.message === "__NO_KEY__" || lastStreamError.message === "__NO_MODEL__")
        ) {
          break;
        }
        if (signal?.aborted) {
          // Commit whatever this iteration streamed (partial or complete)
          // so the final persist below keeps it in the transcript — the
          // client has already displayed these deltas.
          commitPartialIteration();
          break;
        }

        // If the model used the native function-calling API, we use those tool
        // calls directly (no text parsing needed). Otherwise, we parse the
        // text content for tool-call syntax (the text-fallback path).
        let toolCalls: ParsedToolCall[];
        if (nativeToolCalls.length > 0) {
          toolCalls = nativeToolCalls.map((c) => {
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(c.arguments || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              /* keep empty args */
            }
            return {
              toolName: c.name,
              args,
              raw: "",
              startIndex: -1,
              endIndex: -1,
              thought_signature: c.thought_signature,
              thoughtSignature: c.thoughtSignature,
            };
          });
        } else {
          toolCalls = parseToolCalls(iterContent);
        }

        // A response is empty only if ALL of these are true:
        //   - no prose content (iterContent is blank after think-tag stripping)
        //   - no thinking / reasoning content (iterThinking is blank)
        //   - no text-parsed tool calls
        //   - no native function-calling tool calls (nativeToolCalls from the API)
        // Native tool calls mean the model DID respond — via the FC API instead
        // of prose — so nativeToolCalls.length > 0 is always non-empty.
        if (
          !iterContent.trim() &&
          !iterThinking.trim() &&
          toolCalls.length === 0 &&
          nativeToolCalls.length === 0 &&
          !emptyRetried
        ) {
          // Budget starvation: when the stream ended with
          // `finish_reason: "length"` and no output, the model spent its
          // entire completion budget (DeepSeek's official thinking-mode
          // docs state reasoning tokens count against max_tokens). Retry
          // once with the model's documented maximum output tokens from
          // the models.dev registry — no invented values, no stripping
          // tools/thinking.
          if (lastFinishReason === "length" && !budgetRetried) {
            const reg = await peekModelInRegistry(usedApiModel ?? req.model, req.provider, { core: true });
            if (reg?.maxOutput !== undefined && (maxTokensUsed === undefined || maxTokensUsed < reg.maxOutput)) {
              budgetRetried = true;
              budgetMaxTokens = reg.maxOutput;
              continue;
            }
          }
          emptyRetried = true;
          const nudge = openaiTools.length > 0 || anthropicTools.length > 0
            ? "Your previous response was empty. If your API or model does not support tool definitions, please respond to the user in plain text instead."
            : "Your previous response was empty. Please respond or call a tool.";
          // Disable native tools for the retry — some providers/models
          // reject or get confused by tool definitions and return empty.
          if (openaiTools.length > 0 || anthropicTools.length > 0) {
            openaiTools = [];
            anthropicTools = [];
            setToolsRejected(conversation.id, req.provider, req.model);
            // Also disable thinking — if a model has both issues (tool rejection
            // and empty responses with thinking), we want to eliminate both
            // variables on the retry rather than erroring out.
            forceDisableThinking = true;
            // Also swap to text-fallback system prompt so the model knows
            // to output tool calls as JSON text rather than the native API.
            if (baseSystemPrompt === NATIVE_SYSTEM_PROMPT) {
              baseSystemPrompt = buildTextFallbackSystemPrompt(enabledTools, mode);
              systemPrompt = baseSystemPrompt + toolSection + capabilitiesBlock + envBlock + discoveryBlock + missionBlock;
            }
          } else {
            // No tools were present — empty might be thinking-related.
            // Only disable thinking as a fallback when tools weren't involved.
            forceDisableThinking = true;
          }
          try {
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "user",
                content: nudge,
              },
            });
          } catch {
            /* ignore persist errors */
          }
          continue;
        }
        if (
          !iterContent.trim() &&
          !iterThinking.trim() &&
          toolCalls.length === 0 &&
          nativeToolCalls.length === 0 &&
          emptyRetried
        ) {
          // Third fallback: strip all non-essential system prompt blocks.
          // Some models (e.g. via some gateways) reject or ignore prompts that
          // include capability/discovery/env blocks they don't understand.
          // If we haven't tried this yet, strip everything but base + toolSection.
          if (!emptyBarePromptTried) {
            emptyBarePromptTried = true;
            baseSystemPrompt = buildTextFallbackSystemPrompt(enabledTools, mode);
            systemPrompt = baseSystemPrompt + toolSection;
            forceDisableThinking = true;
            openaiTools = [];
            anthropicTools = [];
            setToolsRejected(conversation.id, req.provider, req.model);
            try {
              await db.message.create({
                data: {
                  conversationId: conversation.id,
                  role: "user",
                  content: "Your previous response was empty. Please respond directly in plain text without any special formatting.",
                },
              });
            } catch {
              /* ignore persist errors */
            }
            continue;
          }
          const lengthNote =
            lastFinishReason === "length"
              ? " The stream ended with finish_reason \"length\": the model exhausted its max_tokens output budget — reasoning tokens count against it (DeepSeek's official thinking-mode docs). Raise the model's output limit or reduce thinking effort."
              : "";
          emit({
            type: "error",
            message:
              "The model returned an empty response after retrying. The model may not support this mode or the request was too large. Try a different model or clear the conversation." +
              lengthNote,
            code: "EMPTY_RESPONSE",
          });
          break;
        }

        // If the model produced no parseable tool call but the response
        // looks like a malformed tool attempt, give it a chance to retry with
        // the canonical format. Fires up to 2 times per run (not just iter 0)
        // because the model may narrate edits on later iterations too (e.g.
        // after reading a file, it shows the fixed code instead of calling
        // edit_file). SKIP this nudge if we got native tool calls (they're
        // always well-formed — no need to nudge).
        if (
          nativeToolCalls.length === 0 &&
          toolCalls.length === 0 &&
          nudged < 2 &&
          detectToolAttempt(iterContent)
        ) {
          nudged++;
          totalTokensOut += estimateTokens(iterContent);
          // Persist the botched attempt so the next iteration's history
          // includes it for self-correction.
          try {
            await db.message.update({
              where: { id: assistantMsg.id },
              data: {
                content: iterContent,
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                latencyMs: Date.now() - startedAt,
              },
            });
            // Mirror into the run cache — this row was already loaded (empty
            // content) and the delta fetch cannot see content updates.
            pendingRowUpdates.set(assistantMsg.id, { content: iterContent });
          } catch {
            /* ignore persist errors */
          }
          // Append the nudge as a tool-role message — the next iteration's
          // history will include it, prompting the model to retry using
          // the canonical ```tool_call fenced format.
          try {
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "tool",
                content: TOOL_NUDGE_MESSAGE,
                toolCallId: `${assistantMsg.id}-nudge`,
              },
            });
          } catch {
            /* ignore persist errors */
          }
          // Don't add iterContent to fullContent — this iteration is not
          // the final answer. The loop continues to the next iteration.
          continue;
        }

        let cleaned =
          collapseDuplicateLines(
            stripToolCallBlocks(iterContent) ||
            (toolCalls.length ? "" : iterContent),
          );

        // Fallback: If the model produced 0 prose tokens (cleaned is empty) and 0 tool calls,
        // but generated text in iterThinking (e.g. Gemini 3.1 Flash Lite emitting its final response text in reasoning channel),
        // use iterThinking as the fallback prose content so the response is visible to the user instead of stopping silently.
        if (!cleaned.trim() && toolCalls.length === 0 && iterThinking.trim()) {
          cleaned = iterThinking.trim();
        }

        if (cleaned) {
          fullContent += (fullContent ? "\n\n" : "") + cleaned;
          totalTokensOut += estimateTokens(cleaned);
        }

        // Cross-iteration convergence check: detect when the model is
        // producing identical text output across consecutive iterations
        // (the "output loop" pattern — same planning paragraph repeated).
        const convergence = convergenceDetector.record(cleaned);
        if (convergence === "warn") {
          // First repeat — inject a system-level correction. Strip the
          // duplicate text from the accumulated response.
          if (cleaned && fullContent.endsWith(cleaned)) {
            fullContent = fullContent.slice(0, -(cleaned.length)).replace(/\n\n$/, "");
          }
          try {
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "user",
                content:
                  "[SYSTEM ERROR: Output loop detected. You produced identical " +
                  "text output in consecutive iterations — you are not making " +
                  "progress. CHANGE your approach, use different tools, or " +
                  "provide your final answer. Do NOT repeat the same plan.]",
              },
            });
          } catch { /* best-effort */ }
        } else if (convergence === "break") {
          // Third consecutive identical output — force-terminate.
          if (cleaned && fullContent.endsWith(cleaned)) {
            fullContent = fullContent.slice(0, -(cleaned.length)).replace(/\n\n$/, "");
          }
          emit({
            type: "delta",
            content:
              "\n\n---\n⚠️ **Agent terminated**: identical output detected " +
              "in 3 consecutive iterations. Please review and retry with " +
              "a refined prompt or break the task into smaller steps.",
          });
          break;
        }

        // No tool calls → this iteration is the final answer, UNLESS the model
        // only emitted reasoning/thinking without outputting prose or tools
        // (e.g. model says "Let me read the remaining config files..." but stops mid-turn).
        if (toolCalls.length === 0) {
          // Completion-integrity nudge now fires at the loop top (see near
          // iterSystemPrompt); the post-hoc variant re-answered after an
          // already-streamed summary, duplicating it.
          // Subagents handed to the background delivery watcher either way, so
          // the model is NEVER asked to wait on them: once we hit a turn the
          // model did not use for real work (no tools, no prose) while reports
          // are still undelivered, hand off immediately and end the run. The
          // delivery watcher posts each report as a user message and publishes
          // the wake event; the client's sentinel autoWake run then synthesizes
          // the final answer. This prevents the "subagent is still running,
          // let me check once more" stall loop in the main conversation.
          const breakDrained = await persistQueuedSubagentReports(user.id, conversation.id, emit);
          // Backdated report rows (createdAt anchored to session completion)
          // can sort below the delta cursor, so the next loadHistoryOnce would
          // silently skip them and a queued-turn continuation would reason
          // without them. Mirror the created rows into the run cache now —
          // id-deduped, because a recent row may legitimately be re-yielded by
          // the next cursor delta.
          for (const row of breakDrained) {
            if (cachedRows.some((c) => c.id === row.id)) continue;
            const rr = toCachedRow(row);
            const idx = cachedRows.findIndex(
              (c) => c.createdAt > row.createdAt
                || (c.createdAt.getTime() === row.createdAt.getTime() && c.id > row.id),
            );
            if (idx === -1) cachedRows.push(rr);
            else cachedRows.splice(idx, 0, rr);
            tokenMemo.delete(row.id);
          }
          const pendingSubagentsNow = getSubagents(user.id, conversation.id);
          const undeliveredNow = pendingSubagentsNow.filter(
            (sa) => !isSubagentReportDelivered(user.id, conversation.id, sa.id),
          );
          const waitingOnSubagents = undeliveredNow.length > 0;
          if (waitingOnSubagents) {
            void deferSubagentDelivery(user.id, conversation.id, undeliveredNow.map((sa) => sa.id));
          }

          if (!cleaned.trim() && iterThinking.trim() && !thinkingOnlyNudged && !waitingOnSubagents) {
            // Budget exhaustion with thinking-only output (see the empty
            // response ladder above): raise to the documented registry max
            // and retry before nudging — the model needs headroom to finish
            // thinking AND answer.
            if (lastFinishReason === "length" && !budgetRetried) {
              const reg = await peekModelInRegistry(usedApiModel ?? req.model, req.provider, { core: true });
              if (reg?.maxOutput !== undefined && (maxTokensUsed === undefined || maxTokensUsed < reg.maxOutput)) {
                budgetRetried = true;
                budgetMaxTokens = reg.maxOutput;
                continue;
              }
            }
            thinkingOnlyNudged = true;
            try {
              await db.message.create({
                data: {
                  conversationId: conversation.id,
                  role: "user",
                  content: "Please proceed and output your response or execute the necessary tools.",
                },
              });
            } catch {
              /* ignore persist errors */
            }
            continue;
          }

          // Before breaking, the subagent deferral above already handed any
          // pending subagents to the background delivery watcher, so this final
          // break simply ends the run. No blocking await, no polling rounds.
          // Reports drained here (or in the finally) arrived after the model's
          // final answer — the finally fires a wake so they get synthesized.
          drainedAfterAnswer += breakDrained.length;

          // Real queuing (user→main loop): a turn drained at this iteration's
          // top WAS in history, so this final answer just responded to it —
          // clear the pending marker and finish. A turn queued DURING this
          // iteration's streaming was never in history, so the loop must
          // continue one more iteration to pick it up and answer it — never
          // break while a queued turn is unanswered. Check the late queue
          // first: a turn queued mid-iteration wins over the drained marker.
          const lateQueued = takeQueuedUserTurns(user.id, conversation.id);
          if (lateQueued.length > 0) {
            queuedTurnsPending = [...queuedTurnsPending, ...lateQueued];
            // Late turns postdate the run's answer row — persist this answer
            // into the active row and rotate to a fresh empty row so the next
            // iteration's answer lands BELOW the queued turns.
            if (fullContent.trim() || fullThinking.trim() || segments.length > 0) {
              try {
                await db.message.update({
                  where: { id: assistantMsg.id },
                  data: {
                    content: fullContent,
                    thinking: fullThinking || null,
                    toolCalls: allToolCalls.length ? JSON.stringify(allToolCalls) : null,
                    segments: segments.length ? JSON.stringify(segments) : null,
                    tokensIn: 0,
                    tokensOut: 0,
                    latencyMs: 0,
                    promptTokens: 0,
                    cacheWrites: 0,
                    cacheReads: 0,
                  },
                });
                // Mirror into the run cache so the next iteration's history
                // includes this answer (the delta fetch cannot see updates).
                pendingRowUpdates.set(assistantMsg.id, {
                  content: fullContent,
                  thinking: fullThinking || null,
                  toolCalls: allToolCalls.length ? JSON.stringify(allToolCalls) : null,
                });
              } catch {
                /* best-effort persist */
              }
              try { emit({ type: "done", messageId: assistantMsg.id }); } catch {}
              const rotated = await db.message.create({
                data: {
                  conversationId: conversation.id,
                  role: "assistant",
                  content: "",
                  provider: req.provider,
                  model: req.model,
                },
              });
              try { emit({ type: "start", messageId: rotated.id }); } catch {}
              // Mirror into the run cache, positioned after the queued turns.
              if (!cachedRows.some((c) => c.id === rotated.id)) {
                const rr = toCachedRow(rotated);
                const idx = cachedRows.findIndex(
                  (c) => c.createdAt > rotated.createdAt
                    || (c.createdAt.getTime() === rotated.createdAt.getTime() && c.id > rotated.id),
                );
                if (idx === -1) cachedRows.push(rr);
                else cachedRows.splice(idx, 0, rr);
                tokenMemo.delete(rotated.id);
              }
              assistantMsg = rotated;
              fullContent = "";
              fullThinking = "";
              segments.length = 0;
              allToolCalls = [];
            } else {
              // Nothing produced this iteration, so the next iteration's
              // answer to the queued turns would land in THIS row — which
              // predates them. Bump its createdAt so the transcript (and the
              // model history) keep the question-above-answer order.
              try {
                await db.message.update({
                  where: { id: assistantMsg.id },
                  data: { createdAt: new Date() },
                });
              } catch {
                /* best-effort */
              }
              const bumpIdx = cachedRows.findIndex((c) => c.id === assistantMsg.id);
              if (bumpIdx >= 0) {
                const [moved] = cachedRows.splice(bumpIdx, 1);
                moved.createdAt = new Date();
                const insIdx = cachedRows.findIndex(
                  (c) => c.createdAt > moved.createdAt
                    || (c.createdAt.getTime() === moved.createdAt.getTime() && c.id > moved.id),
                );
                if (insIdx === -1) cachedRows.push(moved);
                else cachedRows.splice(insIdx, 0, moved);
                tokenMemo.delete(moved.id);
              }
            }
            continue;
          }
          if (queuedTurnsPending.length > 0) {
            // Every pending turn was drained before this iteration and the
            // model just produced a final answer over history containing it —
            // the run answered the queue. Report the ids in `done` so the
            // client's fallback re-sender can drop them.
            answeredQueuedTurns.push(...queuedTurnsPending);
            queuedTurnsPending = [];
            break;
          }
          break;
        }

        // BEFORE executing the tools, so the next iteration's history includes
        // the proper `tool_calls` field. Without this, if the tool execution
        // crashes or the stream drops mid-execution, the assistant message
        // would have NO `toolCalls` field — and `toOpenAIMessagesWithTools`
        // (used by the free tier + BYOK OpenAI-compat) wouldn't reconstruct
        // the `tool_calls` on the assistant turn. The model would then see a
        // dangling `tool`-role message (the tool result) with no matching
        // `tool_use` — which some providers reject (400) and others silently
        // misinterpret (causing the model to echo the tool result as text).
        // We use the SAME toolCallId scheme as the execution pass below:
        // `${assistantMsg.id}-tc-${batchStartLen + i + 1}` so the IDs match
        // the `tool_call_id` on the persisted tool-result messages.
        {
          const batchStartLen0 = allToolCalls.length;
          const toolCallsForPersist = toolCalls.map((tc, i) => ({
            id: `${assistantMsg.id}-tc-${batchStartLen0 + i + 1}`,
            name: tc.toolName,
            args: tc.args,
            thought_signature: tc.thought_signature,
            thoughtSignature: tc.thoughtSignature,
          }));
          try {
            await db.message.update({
              where: { id: assistantMsg.id },
              data: {
                content: fullContent,
                toolCalls: JSON.stringify(toolCallsForPersist),
                segments: segments.length ? JSON.stringify(segments) : null,
              },
            });
            // Mirror into the run cache (content + tool calls) so subsequent
            // iterations see the updated row without a re-read.
            pendingRowUpdates.set(assistantMsg.id, {
              content: fullContent,
              toolCalls: JSON.stringify(toolCallsForPersist),
            });
          } catch {
            /* ignore persist errors — best-effort */
          }
        }

        // Tool batch execution: interleaved pipeline — each tool is permission-checked
        // and executed immediately before moving to the next, so tool_call_start events
        // stream to the client as each tool's permission resolves (not after the entire
        // batch is screened). The persistence post-pass remains separate.

        interface ToolBatchEntry {
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          action: PermissionAction | null;
          /** True when permission was granted (allow or ask→allow). */
          allowed: boolean;
          /** Populated for denied entries. */
          denyReason?: string;
          /** Populated by the execution pass for allowed entries. */
          result?: { ok: boolean; result: unknown };
          durationMs?: number;
          thought_signature?: string;
          thoughtSignature?: string;
        }

        const batch: ToolBatchEntry[] = [];
        const batchStartLen = allToolCalls.length;

        // Load permission configuration and workspace once per tool batch.
        let batchPermConfig = await getPermissions(user.id);
        const batchWs = await resolveWs(user.id, conversation.id).catch(() => null);
        const batchRootDir = batchWs?.rootDir;

        const executeSingleEntry = async (entry: ToolBatchEntry) => {
          // The card appears NOW, immediately before this tool runs (or is
          // denied) — interleaved with permission evaluation.
          emit({ type: "tool_call_start", toolCallId: entry.toolCallId, name: entry.toolName });
          emit({
            type: "tool_call_args",
            toolCallId: entry.toolCallId,
            argsDelta: JSON.stringify(entry.args),
          });
          if (!entry.allowed) {
            const denyReason = entry.denyReason ?? "Permission denied.";
            emit({
              type: "tool_call_result",
              toolCallId: entry.toolCallId,
              result: { error: denyReason },
              ok: false,
            });
            emit({ type: "tool_call_end", toolCallId: entry.toolCallId });
            return;
          }
          if (signal?.aborted) {
            entry.result = { ok: false, result: { error: "Agent turn stopped by user." } };
            entry.durationMs = 0;
            emit({ type: "tool_call_result", toolCallId: entry.toolCallId, result: entry.result.result, ok: false });
            emit({ type: "tool_call_end", toolCallId: entry.toolCallId });
            return;
          }
          const isBrowserTool = entry.toolName.startsWith("browser_");
          if (isBrowserTool) {
            emit({ type: "ui_action", action: "switch_panel", panel: "browser" });
          }
          const t0 = Date.now();
          const r = await runTool(entry.toolName, entry.args, {
            userId: user.id,
            conversationId: conversation.id,
            toolCallId: entry.toolCallId,
            emit,
            provider: req.provider,
            model: req.model,
            thinkingLevel: req.thinkingLevel,
            checkpointId: preTurnCheckpointId,
            signal,
            rootDir: batchRootDir,
            onProgress: (text) => {
              emit({ type: "command_output", toolCallId: entry.toolCallId, text, running: true });
            },
          });

          // Duplicate Read Interceptor: catch repeated reads of the exact
          // same line range. Full-file reads carry no range fields; range
          // reads report the actual clamped 1-based startLine/endLine.
          if (entry.toolName === "read_file" && r.ok && typeof r.result === "object" && r.result !== null) {
            const resObj = r.result as Record<string, unknown>;
            const pathKey = String(resObj.path ?? entry.args?.path ?? entry.args?.TargetFile ?? "");
            if (pathKey) {
              const isRangeRead = typeof resObj.startLine === "number" && typeof resObj.endLine === "number";
              const rangeKey = isRangeRead ? `${resObj.startLine}-${resObj.endLine}` : "full";
              const readKey = `${pathKey}:${rangeKey}`;
              const prevReads = sessionReadTracker.get(conversation.id) ?? new Set<string>();
              if (prevReads.has(readKey) && typeof resObj.content === "string") {
                resObj.note = `[System Note: You have already inspected this line range of ${pathKey}. Do not re-read identical ranges. Formulate your edit and call edit_file or run_command now.]`;
              }
              prevReads.add(readKey);
              sessionReadTracker.set(conversation.id, prevReads);
            }
          }

          // Clear read tracker when a write or edit tool modifies a file
          if (isWriteTool(entry.toolName)) {
            sessionReadTracker.delete(conversation.id);
          }

          entry.result = r;
          entry.durationMs = Date.now() - t0;
          emit({ type: "command_output", toolCallId: entry.toolCallId, text: "", running: false });
          emit({ type: "tool_call_result", toolCallId: entry.toolCallId, result: r.result, ok: r.ok });
          emit({ type: "tool_call_end", toolCallId: entry.toolCallId });
        };

        // Interleaved: evaluate permission → execute → emit for each tool
        // sequentially, so each tool card appears in the UI as soon as its
        // permission is resolved.
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const toolCallId = `${assistantMsg.id}-tc-${batchStartLen + i + 1}`;

          if (mode === "architect" && tc.toolName === "spawn_subagent") {
            // Architect mode: enforce read-only tool access by clipping allowedTools.
            const requested = Array.isArray(tc.args?.allowedTools)
              ? (tc.args.allowedTools as unknown[])
              : [];
            tc.args = {
              ...tc.args,
              allowedTools: requested.filter((t) =>
                ARCHITECT_READ_ONLY_TOOLS.has(t as string),
              ),
            };
          }

          // Evaluate tool action permission ("deny" blocks, "ask" prompts user, "allow" executes).
          let permissionMode: PermissionMode = "ask";
          try {
            permissionMode = await evaluateToolPermission(user.id, tc.toolName, mode, batchPermConfig);
          } catch (e) {
            console.error("[perms] evaluation failed, failing CLOSED (ask):", e);
            permissionMode = "ask"; // fail-closed: ask the user on errors
          }
          const action = actionForTool(tc.toolName);

          const entry: ToolBatchEntry = {
            toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            action,
            allowed: false,
            thought_signature: tc.thought_signature,
            thoughtSignature: tc.thoughtSignature,
          };

          if (mode === "chat") {
            entry.allowed = false;
            entry.denyReason = "Tool execution is disabled in Chat mode. Switch to Agent or Architect mode to use tools.";
          } else if (mode === "architect" && !ARCHITECT_ALLOWED_TOOLS.has(tc.toolName)) {
            entry.allowed = false;
            entry.denyReason = `Tool '${tc.toolName}' is blocked in Architect mode (Architect mode is read-only for planning & architecture). Switch to Agent mode to modify files or execute commands.`;
          } else if (permissionMode === "deny") {
            entry.allowed = false;
            entry.denyReason = `Permission denied for ${action ?? tc.toolName}.`;
            try {
              await audit(
                user.id,
                "tool_denied",
                JSON.stringify({ tool: tc.toolName, action }),
              );
            } catch {
              /* ignore audit failures */
            }
          } else if (permissionMode === "ask") {
            const target = buildPermissionTarget(tc.toolName, action, tc.args);
            const { id: approvalId, promise: approvalPromise } =
              createPendingApproval({
                userId: user.id,
                conversationId: conversation.id,
                messageId: assistantMsg.id,
                toolCallId,
                toolName: tc.toolName,
                action,
                target,
                args: tc.args,
              });
            emit({
              type: "tool_call_permission",
              toolCallId,
              toolName: tc.toolName,
              action: action ?? tc.toolName,
              target,
              approvalId,
            });
            let decision: PermissionDecision;
            try {
              decision = await raceWithAbort(approvalPromise, signal);
            } catch {
              // Stream aborted: cancel pending approvals for conversation and treat as denied.
              cancelPendingForConversation(conversation.id);
              decision = "deny";
            }
            try {
              await audit(
                user.id,
                "tool_permission_decision",
                JSON.stringify({
                  tool: tc.toolName,
                  action,
                  decision,
                  approvalId,
                }),
              );
            } catch {
              /* ignore audit failures */
            }
            if (decision === "always_allow") {
              // Refresh permission snapshot after always_allow so subsequent batch calls skip prompting.
              batchPermConfig = await refreshPermissionsConfig(
                user.id,
                decision,
                batchPermConfig,
              );
            }
            if (decision === "deny") {
              entry.allowed = false;
              entry.denyReason = "Permission denied by the user.";
            } else {
              // decision === "allow" | "always_allow": fall through to execute.
              entry.allowed = true;
            }
          } else {
            entry.allowed = true;
          }

          batch.push(entry);

          // Immediately execute this tool — the card appears in the UI now.
          await executeSingleEntry(entry);
        }

        for (const entry of batch) {
          const { toolCallId, toolName, args } = entry;

          if (entry.allowed && entry.result) {
            const result = entry.result;
            const durationMs = entry.durationMs ?? 0;

            allToolCalls.push({
              id: toolCallId,
              name: toolName,
              args,
              status: result.ok ? "done" : "error",
              result: result.result,
              thought_signature: entry.thought_signature,
              thoughtSignature: entry.thoughtSignature,
            });

            segments.push({
              kind: "tool_call",
              id: `seg-tc-${toolCallId}`,
              toolCallId,
            });

            try {
              await db.toolExecution.create({
                data: {
                  conversationId: conversation.id,
                  toolName,
                  input: JSON.stringify(args).slice(0, 8000),
                  output: JSON.stringify(result.result).slice(0, 8000),
                  status: result.ok ? "success" : "error",
                  durationMs,
                },
              });
            } catch {
              /* ignore persist errors */
            }

            // Build and persist full tool result into conversation history for subsequent iterations.
            let resultContent: string;
            if (!result.ok) {
              if (typeof result.result === "object" && result.result !== null && "error" in result.result) {
                const errVal = (result.result as any).error;
                resultContent = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
              } else {
                resultContent = JSON.stringify(result.result);
              }
            } else if (toolName === "read_file" && typeof result.result === "object" && result.result !== null) {
              const r = result.result as { path?: string; content?: string; size?: number; lines?: number; note?: string };
              const content = r.content ?? "";
              resultContent = `File: ${r.path ?? "?"} (${r.size ?? "?"} bytes, ${r.lines ?? "?"} lines)\n\n--- FILE CONTENT START ---\n${content}\n--- FILE CONTENT END ---`;
              // Carry duplicate-read warning note to inform model of redundant inspection.
              if (typeof r.note === "string" && r.note.length > 0) {
                resultContent += `\n\n${r.note}`;
              }
            } else if (toolName === "write_file" && typeof result.result === "object" && result.result !== null) {
              const r = result.result as { path?: string; bytes?: number; created?: boolean };
              resultContent = `${r.created ? "Created" : "Wrote"} ${r.path ?? "file"} (${r.bytes ?? "?"} bytes). File written successfully.`;
            } else if (toolName === "edit_file" && typeof result.result === "object" && result.result !== null) {
              const r = result.result as { path?: string; occurrences?: number };
              resultContent = `Edited ${r.path ?? "file"} — ${r.occurrences ?? 1} replacement${(r.occurrences ?? 1) > 1 ? "s" : ""} made. File updated successfully.`;
            } else if (toolName === "multi_edit" && typeof result.result === "object" && result.result !== null) {
              const r = result.result as { path?: string; editsApplied?: number; occurrences?: number };
              resultContent = `Multi-edited ${r.path ?? "file"} — ${r.editsApplied ?? 0} edits (${r.occurrences ?? 0} total replacements). File updated successfully.`;
            } else if (toolName === "run_command" && typeof result.result === "object" && result.result !== null) {
              const r = result.result as { exitCode?: number; stdout?: string; stderr?: string; command?: string; started?: boolean; commandId?: string; note?: string; error?: string; status?: string };
              if (r.status === "running" || r.started) {
                const stdout = r.stdout ?? "";
                const stderr = r.stderr ?? "";
                resultContent = `Command "${r.command ?? "?"}" is STILL RUNNING in background (id: ${r.commandId ?? "?"}). ${r.note ?? "Command is running in background."}\n\n--- PARTIAL STDOUT ---\n${stdout || "(no output so far)"}\n${stderr.trim() ? `--- PARTIAL STDERR ---\n${stderr}\n` : ""}`;
              } else if (r.error) {
                resultContent = `Command failed: ${r.error}`;
              } else {
                const stdout = r.stdout ?? "";
                const stderr = r.stderr ?? "";
                resultContent = `Command: ${r.command ?? "?"} (${r.status === "failed" ? "FAILED" : "completed"})\nExit code: ${r.exitCode ?? 0}\n\n--- STDOUT ---\n${stdout || "(no output)"}\n${stderr.trim() ? `--- STDERR ---\n${stderr}\n` : ""}`;
              }
            } else if (toolName === "list_directory") {
              resultContent = JSON.stringify(result.result);
            } else if (toolName === "grep") {
              resultContent = JSON.stringify(result.result);
            } else if (toolName === "glob") {
              resultContent = JSON.stringify(result.result);
            } else if (toolName === "web_search" || toolName === "http_fetch") {
              resultContent = JSON.stringify(result.result);
            } else if (toolName === "get_subagent") {
              resultContent = JSON.stringify(result.result);
            } else {
              resultContent = JSON.stringify(result.result);
            }
            // Cap what the model sees (not what's stored/audited).
            // The SSE event already sent the full result to the frontend.
            const rawModelResultContent = (await truncateToolOutput(resultContent, user.id)).content;
            const modelResultContent = appendVerificationHint(toolName, result.ok, rawModelResultContent);
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "tool",
                content: `<tool_result tool="${toolName}" ok="${result.ok}">${modelResultContent}</tool_result>`,
                toolCallId,
              },
            });
          } else {
            // Persist denied tool result to history so model can select alternative approach.
            const denyReason = entry.denyReason ?? "Permission denied.";
            const deniedByUser = denyReason.includes("by the user");
            deniedToolCallIds.add(toolCallId);

            allToolCalls.push({
              id: toolCallId,
              name: toolName,
              args,
              status: "error",
              result: { error: denyReason },
              thought_signature: entry.thought_signature,
              thoughtSignature: entry.thoughtSignature,
            });

            segments.push({
              kind: "tool_call",
              id: `seg-tc-${toolCallId}`,
              toolCallId,
            });

            try {
              await db.toolExecution.create({
                data: {
                  conversationId: conversation.id,
                  toolName,
                  input: JSON.stringify(args).slice(0, 8000),
                  output: JSON.stringify({
                    error: denyReason,
                    decision: "deny",
                  }).slice(0, 8000),
                  status: "error",
                  durationMs: 0,
                },
              });
            } catch {
              /* ignore persist errors */
            }

            // Standardize denied tool result in XML format.
            await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "tool",
                content: deniedByUser
                  ? `<tool_result tool="${toolName}" ok="false">Denied by the user. Choose a different approach or ask the user to grant permission.</tool_result>`
                  : `<tool_result tool="${toolName}" ok="false">Denied by permissions: ${denyReason} Choose a different approach or ask the user to grant permission.</tool_result>`,
                toolCallId,
              },
            });
          }
        }

        // Persist the assistant message progressively.
        try {
          await db.message.update({
            where: { id: assistantMsg.id },
            data: {
              content: fullContent,
              thinking: fullThinking || null,
              toolCalls: JSON.stringify(allToolCalls),
            },
          });
          // Mirror into the run cache — the next iteration rebuilds history
          // from cache and must see this content, not the empty stub.
          pendingRowUpdates.set(assistantMsg.id, {
            content: fullContent,
            thinking: fullThinking || null,
            toolCalls: JSON.stringify(allToolCalls),
          });
        } catch {
          /* best-effort persist */
        }
        // Loop continues — the model will see the tool results next iteration.
        const midLoopDrained = await persistQueuedSubagentReports(user.id, conversation.id, emit);
        for (const row of midLoopDrained) {
          if (cachedRows.some((c) => c.id === row.id)) continue;
          const rr = toCachedRow(row);
          const idx = cachedRows.findIndex(
            (c) => c.createdAt > row.createdAt
              || (c.createdAt.getTime() === row.createdAt.getTime() && c.id > row.id),
          );
          if (idx === -1) cachedRows.push(rr);
          else cachedRows.splice(idx, 0, rr);
          tokenMemo.delete(row.id);
        }

        if (midLoopDrained.length > 0) {
          if (fullContent.trim() || fullThinking.trim() || segments.length > 0 || allToolCalls.length > 0) {
            try {
              await db.message.update({
                where: { id: assistantMsg.id },
                data: {
                  content: fullContent,
                  thinking: fullThinking || null,
                  toolCalls: allToolCalls.length ? JSON.stringify(allToolCalls) : null,
                  segments: segments.length ? JSON.stringify(segments) : null,
                  tokensIn: 0,
                  tokensOut: 0,
                  latencyMs: 0,
                  promptTokens: 0,
                  cacheWrites: 0,
                  cacheReads: 0,
                },
              });
            } catch {
              /* best-effort persist */
            }
            try { emit({ type: "done", messageId: assistantMsg.id }); } catch {}
            const rotated = await db.message.create({
              data: {
                conversationId: conversation.id,
                role: "assistant",
                content: "",
                provider: req.provider,
                model: req.model,
              },
            });
            try { emit({ type: "start", messageId: rotated.id }); } catch {}
            if (!cachedRows.some((c) => c.id === rotated.id)) {
              const rr = toCachedRow(rotated);
              const idx = cachedRows.findIndex(
                (c) => c.createdAt > rotated.createdAt
                  || (c.createdAt.getTime() === rotated.createdAt.getTime() && c.id > rotated.id),
              );
              if (idx === -1) cachedRows.push(rr);
              else cachedRows.splice(idx, 0, rr);
              tokenMemo.delete(rotated.id);
            }
            assistantMsg = rotated;
            fullContent = "";
            fullThinking = "";
            segments.length = 0;
            allToolCalls = [];
          } else {
            try {
              await db.message.update({
                where: { id: assistantMsg.id },
                data: { createdAt: new Date() },
              });
            } catch {}
            const bumpIdx = cachedRows.findIndex((c) => c.id === assistantMsg.id);
            if (bumpIdx >= 0) {
              const [moved] = cachedRows.splice(bumpIdx, 1);
              moved.createdAt = new Date();
              const insIdx = cachedRows.findIndex(
                (c) => c.createdAt > moved.createdAt
                  || (c.createdAt.getTime() === moved.createdAt.getTime() && c.id > moved.id),
              );
              if (insIdx === -1) cachedRows.push(moved);
              else cachedRows.splice(insIdx, 0, moved);
              tokenMemo.delete(moved.id);
            }
          }
        }
      }

      // If a `run_command` was started in the background and has finished,
      // inject its output as a tool result so the LLM sees it next iteration.
      const completedCmd = getCompletedCommand(user.id, conversation.id);
      if (completedCmd) {
        acknowledgeCompletedCommand(user.id, conversation.id);
        const cmdToolCallId = `bg-cmd-${Date.now()}`;
        const cmdOk = !completedCmd.exitCode || completedCmd.exitCode === 0;
        const resultContent = `Command: ${completedCmd.command} (${cmdOk ? "completed" : "FAILED"})\nExit code: ${completedCmd.exitCode ?? "?"}\n\n--- STDOUT ---\n${completedCmd.stdout}\n${completedCmd.stderr.trim() ? `--- STDERR ---\n${completedCmd.stderr}\n` : ""}`;
        try {
          await db.message.create({
            data: {
              conversationId: conversation.id,
              role: "tool",
              content: `<tool_result tool="command_completed" ok="${cmdOk}">${(await truncateToolOutput(resultContent, user.id)).content}</tool_result>`,
              toolCallId: cmdToolCallId,
            },
          });
        } catch {
          /* ignore persist errors */
        }
      }

      // Final persist of the assistant message.
      // Grounded Context: when the provider reported usage on at least one
      // iteration, persist the measured totals instead of the BPE estimate.
      const finalWindow = windowTokens();
      const finalTokensIn = finalWindow.tokensIn;
      const finalTokensOut = finalWindow.tokensOut;
      // Use provider-measured prompt tokens when available; fallback to last measured or 0.
      const finalPromptTokens = lastPromptTokensEstimated ? lastMeasuredPromptTokens : lastPromptTokens;
      // Persist empty rotated stubs as "(no response)" to avoid orphaned ghost bubbles.
      try {
        await db.message.update({
          where: { id: assistantMsg.id },
          data: {
            content: fullContent || "(no response)",
            thinking: fullThinking || null,
            toolCalls: allToolCalls.length
              ? JSON.stringify(allToolCalls)
              : null,
            segments: segments.length
              ? JSON.stringify(segments)
              : null,
            tokensIn: finalTokensIn,
            tokensOut: finalTokensOut,
            promptTokens: finalPromptTokens,
            cacheWrites: measuredCacheWrites,
            cacheReads: measuredCacheReads,
            latencyMs: Date.now() - startedAt,
          },
        });
        // Mirror the finalized assistant message into the run cache — the
        // delta fetch cannot see content updates to already-loaded rows.
        pendingRowUpdates.set(assistantMsg.id, {
          content: fullContent || "(no response)",
          thinking: fullThinking || null,
          toolCalls: allToolCalls.length ? JSON.stringify(allToolCalls) : null,
        });
      } catch {
        /* best-effort persist */
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error during chat.";
      // An exception skips the final persist above, so attribute the run's
      // accumulated token/latency stats to the active row here — otherwise a
      // queue rotation followed by a stream error leaves every row at 0
      // (rotations persist 0s by design; the final persist is their offset).
      try {
        const catchWindow = windowTokens();
        await db.message.update({
          where: { id: assistantMsg.id },
          data: {
            tokensIn: catchWindow.tokensIn,
            tokensOut: catchWindow.tokensOut,
            promptTokens: lastPromptTokensEstimated ? lastMeasuredPromptTokens : lastPromptTokens,
            cacheWrites: measuredCacheWrites,
            cacheReads: measuredCacheReads,
            latencyMs: Date.now() - startedAt,
          },
        });
      } catch {
        /* best-effort persist */
      }
      // Safety net: if the loop blew up while a permission prompt was in
      // flight, cancel any dangling pending approvals so the 120s timers
      // (APPROVAL_TTL_MS) don't keep firing (and so the user's UI doesn't
      // show a stale prompt for a dead conversation).
      try {
        cancelPendingForConversation(req.conversationId);
        cancelPendingQuestionsForConversation(req.conversationId);
      } catch {
        /* ignore */
      }
      try {
        emit({ type: "error", message: msg, code: "EXECUTOR_ERROR" });
      } catch {
        /* emit may be closed */
      }
    } finally {
      // Task 38-F.3: clear the heartbeat interval so we don't leak a timer
      // after the run ends (the interval would otherwise keep firing every
      // 5s until the JS process exits, since setInterval keeps the loop alive).
      clearInterval(heartbeatInterval);
      // Drain once more (before releasing the gate): catches completions that
      // raced the final break. Draining while the gate is still up makes this
      // run the sole delivery owner — the watcher won't post these ids
      // concurrently (it gates its posts on isRunActive), and the delivered
      // re-check below makes any overlap harmless. Inside this finally (not
      // after it) so abort/error exits are covered too, not just the success
      // break.
      try {
        drainedAfterAnswer += (await persistQueuedSubagentReports(user.id, conversation.id, emit)).length;
      } catch {
        /* drain failures are handled per-entry inside the helper */
      }
      // Drop the active-run gate so the watcher can post + wake normally.
      unregisterActiveRun(user.id, conversation.id);
      // Real queuing: any user turns still queued at run teardown were never
      // picked up — drop the in-memory marker so it can't leak; the rows are
      // already durable in the DB and the client's fallback re-sends them.
      clearQueuedUserTurns(user.id, conversation.id);
      // Drain once more now the gate is down: catches completions that
      // enqueued DURING the first drain's awaits (the queue was emptied
      // before they landed) and posts anything the watcher handed over.
      try {
        drainedAfterAnswer += (await persistQueuedSubagentReports(user.id, conversation.id, emit)).length;
      } catch {
        /* drain failures are handled per-entry inside the helper */
      }
      // Recheck deferred entries now that the gate is down: reports that
      // completed mid-run and never reached the queue are posted here, and
      // the entry's own completion fires the wake.
      try {
        recheckDeferredDelivery(user.id, conversation.id);
      } catch {
        /* ignore — the watcher remains subscribed for later completions */
      }
      // Safety net for EVERY exit path (not just the final-answer break):
      // hand any still-undelivered subagents to the background watcher so
      // their reports land even when the run ended via max iterations or an
      // exception. The break already defers, so this is idempotent for the
      // normal path. Skipped on abort — the user stopped the run, and an
      // autoWake sentinel would be a fresh turn they didn't ask for.
      if (!signal?.aborted) {
        try {
          const undeliveredAtTeardown = getSubagents(user.id, conversation.id).filter(
            (sa) => !isSubagentReportDelivered(user.id, conversation.id, sa.id),
          );
          if (undeliveredAtTeardown.length > 0) {
            deferSubagentDelivery(user.id, conversation.id, undeliveredAtTeardown.map((sa) => sa.id));
          }
        } catch {
          /* ignore — the watcher remains best-effort */
        }
      }
      // Reports drained after the model's final answer were never reasoned
      // over; if nothing else is pending, wake the client's sentinel so they
      // get synthesized (the deferred-watcher path fires its own wake later).
      // Never wake on an abort — the user explicitly stopped the run; an
      // autoWake sentinel would be a fresh agent turn they didn't ask for.
      if (drainedAfterAnswer > 0 && !signal?.aborted) {
        const undeliveredNow = getSubagents(user.id, conversation.id).filter(
          (sa) => !isSubagentReportDelivered(user.id, conversation.id, sa.id),
        );
        if (undeliveredNow.length === 0) {
          try {
            grantAndPublishWake(user.id, conversation.id);
          } catch {
            /* ignore — the report rows are persisted regardless */
          }
        }
      }
    }

    // Usage + done
    const effTokensIn = windowTokens().tokensIn;
    const effTokensOut = windowTokens().tokensOut;
    // Mirror the persisted `promptTokens` exactly: an estimate that
    // survives only in this SSE event (the flag has no DB column) would
    // show a "~" reading here and a different value after reload — the
    // ring must not receive data that contradicts what is persisted.
    const effPromptTokens = lastPromptTokensEstimated ? lastMeasuredPromptTokens : lastPromptTokens;
    try {
      emit({
        type: "usage",
        tokensIn: effTokensIn,
        tokensOut: effTokensOut,
        promptTokens: effPromptTokens,
        cacheWrites: measuredCacheWrites,
        cacheReads: measuredCacheReads,
        model: req.model,
        provider: req.provider,
        estimated: lastPromptTokensEstimated,
      });
    } catch {
      /* a throwing usage emit must not swallow the done event */
    }
    emit({ type: "done", messageId: assistantMsg.id, final: true, preTurnCheckpointId, queuedAnsweredIds: answeredQueuedTurns });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Unknown error during chat.";
    try {
      cancelPendingForConversation(req.conversationId);
      cancelPendingQuestionsForConversation(req.conversationId);
    } catch {
      /* ignore */
    }
    try {
      emit({ type: "error", message: msg, code: "EXECUTOR_ERROR" });
    } catch {
      /* emit may be closed */
    }
  }
}

export async function testProvider(
  provider: ProviderId,
  apiKey?: string,
  baseUrlOverride?: string,
  model?: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const t0 = Date.now();
  try {
    if (!apiKey) {
      return { ok: false, error: "No API key provided." };
    }
    const info = PROVIDERS[provider];
    const baseUrl = (baseUrlOverride || info?.baseUrl || "").replace(/\/$/, "");

    if (provider === "anthropic") {
      const testModel = (model && model !== "auto") ? model : (info?.models?.[0]?.id || DEFAULT_FALLBACK_MODEL);
      const resp = await safeProviderFetch(baseUrl + "/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: testModel,
          max_tokens: 4,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
        };
      }
      return { ok: true, latencyMs: Date.now() - t0 };
    }

    // 1. Try GET /models first for OpenAI-compatible providers
    try {
      const modelsResp = await safeProviderFetch(baseUrl + "/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (modelsResp.ok) {
        return { ok: true, latencyMs: Date.now() - t0 };
      }
      if (modelsResp.status === 401 || modelsResp.status === 403) {
        const text = await modelsResp.text().catch(() => "");
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: `HTTP ${modelsResp.status}: Invalid API Key. ${text.slice(0, 200)}`,
        };
      }
    } catch {
      /* fallback to POST /chat/completions below if GET /models is unreachable */
    }

    // 2. Fallback: try POST /chat/completions with models from request/catalog
    const catalogModels = (info?.models || []).map((m) => m.id);
    const candidates = Array.from(
      new Set([model, ...catalogModels].filter((m): m is string => Boolean(m && m !== "auto"))),
    );

    if (candidates.length === 0) {
      // If endpoint was reachable (GET /models didn't 401/403) and no specific model exists to test,
      // consider key valid based on network connectivity.
      return { ok: true, latencyMs: Date.now() - t0 };
    }

    let lastError = "";
    for (const testM of candidates) {
      const resp = await safeProviderFetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: testM,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 4,
        }),
      });
      if (resp.ok) {
        return { ok: true, latencyMs: Date.now() - t0 };
      }
      if (resp.status === 401 || resp.status === 403) {
        const text = await resp.text().catch(() => "");
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: `HTTP ${resp.status}: Invalid API Key. ${text.slice(0, 200)}`,
        };
      }
      const text = await resp.text().catch(() => "");
      lastError = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
    }

    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: lastError || "Failed to connect to provider.",
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "Test failed.",
    };
  }
}

/** Reads workspace rules and guidelines (AGENTS.md, GEMINI.md, .agents/rules/*.md) from root directory. */
async function loadWorkspaceRules(rootDir?: string | null): Promise<string> {
  if (!rootDir) return "";
  const loadedRules: string[] = [];

  try {
    const candidates = ["AGENTS.md", "GEMINI.md"];
    for (const file of candidates) {
      const p = path.join(/* turbopackIgnore: true */ rootDir, file);
      try {
        const content = await fsPromises.readFile(/* turbopackIgnore: true */ p, "utf-8");
        if (content.trim()) {
          loadedRules.push(`### File: ${file}\n${content.trim()}`);
        }
      } catch {}
    }

    const rulesDir = path.join(rootDir, ".agents", "rules");
    try {
      const files = await fsPromises.readdir(rulesDir);
      for (const f of files) {
        if (f.endsWith(".md") || f.endsWith(".txt")) {
          const content = await fsPromises.readFile(path.join(rulesDir, f), "utf-8");
          if (content.trim()) {
            loadedRules.push(`### File: .agents/rules/${f}\n${content.trim()}`);
          }
        }
      }
    } catch {}
  } catch {}

  if (loadedRules.length === 0) return "";
  return `\n\n<user_rules>\n# Workspace Rules & Guidelines (Auto-driven from workspace root AGENTS.md / rules)\nThe following project-specific instructions MUST be followed during all code edits, plans, and responses:\n\n${loadedRules.join("\n\n")}\n</user_rules>`;
}

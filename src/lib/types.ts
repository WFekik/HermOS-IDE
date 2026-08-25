// Shared TypeScript contracts between frontend & backend.

import type { ModelReasoningCapabilities, ThinkingLevel } from "@/lib/reasoning";

export type ProviderId =
  | "puter"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "groq"
  | "nvidia"
  | "mistral"
  | "together"
  | "gemini"
  | "zen"
  | "custom"
  | (string & {});

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  docsUrl?: string;
  baseUrl?: string;
  requiresKey: boolean;
  free?: boolean;
  supportsVision?: boolean;
  models: ModelInfo[];
  icon?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  /** Billing rate in USD per 1M tokens (input `in`, output `out`), from live provider /models metadata. */
  pricing?: { in: number; out: number };
  modalities?: string[];
  description?: string;
  /** Persisted per-model enablement from the provider config (absent = enabled). */
  enabled?: boolean;
  /**
   * Live per-model reasoning capabilities captured from provider `/models`
   * metadata (e.g. OpenRouter's `reasoning` object) and persisted on the
   * model config. Absent means "unknown" — the provider's reasoning scheme
   * (see `src/lib/reasoning/schemes.ts`) then applies as the default. The
   * frontend should hide or disable the per-model thinking-level selector
   * when the resolved scheme is `"none"`.
   */
  reasoning?: ModelReasoningCapabilities;
}

export type Role = "user" | "assistant" | "tool" | "system";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status?: string;
  result?: unknown;
  thought_signature?: string;
  thoughtSignature?: string;
}

/**
 * Chat attachment metadata. The full bytes live on the server under
 * UPLOADS_ROOT (see `src/lib/paths.ts`); this DTO carries the id used to
 * fetch them and a client-side preview descriptor. Round-tripped via
 * `MessageDTO.attachments`.
 */
export interface AttachmentDTO {
  id: string;
  name: string;
  /** MIME type (e.g. "image/png", "application/pdf", "text/plain"). */
  type: string;
  /** Size in bytes. */
  size: number;
  /**
   * True when the message received from the server actually carried the
   * attachment (vs. a transient client-only chip that hasn't been uploaded
   * yet). Used by the renderer to decide whether to show a download link.
   */
  persisted?: boolean;
}

export interface TodoItemDTO {
  id: string;
  text?: string;
  content?: string;
  status?: string;
  completed?: boolean;
  createdAt?: string;
  completedAt?: string | null;
  priority?: "low" | "medium" | "high";
  activeStep?: string | null;
}

export interface MessageDTO {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  model?: string;
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  promptTokens?: number;
  cacheWrites?: number;
  cacheReads?: number;
  latencyMs?: number;
  segments?: any[];
  attachments?: AttachmentDTO[];
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  systemPrompt?: string | null;
  mode: AgentMode;
  pinned: boolean;
  workspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: MessageDTO[];
  isAgentRunning?: boolean;
}

export type AgentMode = "agent" | "chat" | "architect";

export interface AgentPresetDTO {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  systemPrompt: string;
  provider: ProviderId;
  model: string;
  tools?: string[];
  temperature?: number;
  isBuiltin?: boolean;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  provider: ProviderId;
  model: string;
  mode?: AgentMode;
  systemPrompt?: string;
  /** Thinking level for this request — canonical vocabulary, see `src/lib/reasoning/types.ts`. */
  thinkingLevel?: ThinkingLevel;
  mcpServerIds?: string[];
  enabledTools?: string[];
  temperature?: number;
  /**
   * Attachment ids the client already uploaded via
   * `POST /api/conversations/[id]/attachments`. The executor resolves
   * these to file paths on disk and passes the bytes (or an inline
   * description) to the model. Up to 20 attachments, each up to 50 MB.
   */
  attachmentIds?: string[];
  /** Runtime environment capabilities detected on the client (PWA app vs browser). */
  capabilities?: string[];
  /** Context governance overrides from user settings (retention policies). */
  contextConfig?: Partial<{
    pruneProtectTokens: number;
    compactionBuffer: number;
    outputTokenCap: number;
    tailTurns: number;
  }>;
  editMessageId?: string;
  messageId?: string;
  /** Optional iteration cap for agent loop execution (default: uncapped). */
  maxIterations?: number;
  /**
   * Internal sentinel run launched by the client when a deferred subagent
   * delivery completes (`wake` SSE event). The executor skips persisting a
   * user-role message for this request and instead synthesizes the final
   * answer from the freshly-delivered `<subagent_report>` messages.
   */
  autoWake?: boolean;
}

// SSE event stream from /api/agents/chat
export type ChatStreamEvent =
  | { type: "start"; messageId: string }
  | { type: "delta"; content: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_args"; toolCallId: string; argsDelta: string }
  | {
      type: "tool_call_permission";
      toolCallId: string;
      toolName: string;
      /** Permission action (e.g. "command.run") or the tool name as fallback. */
      action: string;
      /** Human-readable summary, e.g. `run \`ls -la\``. */
      target: string;
      /** Pending-approval registry id the client uses to resolve. */
      approvalId: string;
    }
  | {
      type: "tool_call_question";
      questionId: string;
      toolCallId: string;
      questions: Array<{
        question: string;
        options?: string[];
        isMultiSelect?: boolean;
      }>;
      question?: string;
      options?: string[];
      isMultiSelect?: boolean;
    }
  | { type: "tool_call_result"; toolCallId: string; result: unknown; ok: boolean }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "thinking"; content: string }
  /** Reset the thinking field on retry (clears partial content from a failed attempt). */
  | { type: "thinking_reset" }
  /** Emitted before first delta when middle messages are trimmed to fit model context window. */
  | { type: "context_trimmed"; dropped: number; keptTokens: number; activePromptTokens?: number; via?: "command" | "auto" | "overflow" }
  | {
      type: "usage";
      tokensIn: number;
      tokensOut: number;
      promptTokens: number;
      cacheWrites?: number;
      cacheReads?: number;
      model: string;
      provider: string;
      /** True when promptTokens is an estimated pre-stream count rather than measured usage. */
      estimated?: boolean;
    }
  /** Emitted during long-running tool calls (e.g. terminal) for live output streaming. */
  | { type: "command_output"; toolCallId: string; text: string; running: boolean }
  | { type: "stream_heartbeat"; ts: number }
  | { type: "done"; messageId: string; final?: boolean; preTurnCheckpointId?: string; queuedAnsweredIds?: string[] }
  | { type: "error"; message: string; code?: string }
  | { type: "rate_limit_retry"; retryAfterMs: number; attempt: number; maxAttempts: number; conversationId: string }
  /** Instructs the client to perform a UI action (e.g. switch a panel tab).
   *  The server cannot call useAppStore directly (different process/context),
   *  so it signals the client through the SSE stream instead. */
  | { type: "ui_action"; action: "switch_panel"; panel: string }
  | { type: "ui_action"; action: "sync_selection" };

export interface ProviderKeyDTO {
  provider: ProviderId;
  hasKey: boolean;
  keyHint?: string;
  baseUrl?: string;
  models?: string[];
  modelsConfig?: Array<{ id: string; enabled?: boolean; thinkingLevel?: string }>;
  isActive: boolean;
}

export interface SaveKeyRequest {
  provider: ProviderId;
  apiKey: string;
  baseUrl?: string;
  models?: string[];
}

export type McpTransport = "stdio" | "sse" | "streamable-http";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerDTO {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  status: "connected" | "disconnected" | "error";
  lastError?: string;
  tools?: McpTool[];
  createdAt: string;
}

export interface CreateMcpServerRequest {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface PluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: "api" | "script";
  endpoint?: string;
  command?: string;
  pluginId?: string;
  pluginName?: string;
}

export interface PluginDTO {
  id: string;
  name: string;
  description?: string;
  type: "plugin" | "skill";
  version: string;
  source: string;
  enabled: boolean;
  manifest?: Record<string, unknown>;
  createdAt: string;
}

export interface TerminalRequest {
  command: string;
  shell: "bash" | "pwsh" | "cmd" | "zsh";
  cwd?: string;
}

export interface TerminalResponse {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  blocked?: boolean;
  reason?: string;
}

export interface UserDTO {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  provider: string;
  role: string;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

import type { ChatStreamEvent } from "@/lib/types";
import type { WorkspaceInfo } from "@/lib/workspace";

/**
 * Shared tool types (import type only — erased at runtime, never part of the
 * tools ↔ subagent-executor import cycle). That cycle is safe: both sides
 * only call each other at request time, never at module top level.
 */
export type ToolCtx = {
  userId: string;
  conversationId: string;
  /** Parent conversation of a subagent session. When set, checkpoints, todos, and workspace resolution scope to the parent conversation. */
  parentConversationId?: string;
  toolCallId?: string;
  /** Optional callback for emitting SSE events directly from interactive tools (e.g. ask_question). */
  emit?: (event: ChatStreamEvent) => void;
  /** Optional callback for streaming progress during long-running tools (e.g. command execution). */
  onProgress?: (text: string) => void;
  /** Provider and model of the invoking agent (used by subagent tools). */
  provider?: string;
  model?: string;
  /** Thinking level from the parent agent, passed through to spawned subagents. */
  thinkingLevel?: string;
  signal?: AbortSignal;
  /** If set, snapshot modified files into this checkpoint before writing. */
  checkpointId?: string;
  /**
   * Active workspace rootDir. When set, lock keys are canonicalized against
   * it so every spelling of the same physical file maps to one key.
   */
  rootDir?: string;
  /** Active workspace snapshot to avoid repetitive DB lookups. */
  workspace?: WorkspaceInfo;
  /** Whether execution outside workspace is explicitly permitted. */
  userAllowedOutsideWorkspace?: boolean;
  /** Mode of the invoking agent; architect mode keeps spawned subagents read-only. */
  agentMode?: "agent" | "chat" | "architect";
};

export type ToolResult = { ok: boolean; result: unknown };

export type ToolHandler = (
  args: unknown,
  ctx?: ToolCtx,
) => Promise<ToolResult> | ToolResult;

/** Minimal registry interface for future per-domain tool registration (fs/shell/browser/office/subagent). */
export interface ToolRegistry {
  register(name: string, handler: ToolHandler): void;
  get(name: string): ToolHandler | undefined;
}

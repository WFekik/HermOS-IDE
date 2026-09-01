"use client";

import { create } from "zustand";
import { toast } from "sonner";
import { apiGet, apiPost, apiPatch, apiDelete, ApiRequestError } from "@/lib/api-client";
import type {
  AgentMode,
  AgentPresetDTO,
  ConversationDTO,
  McpServerDTO,
  MessageDTO,
  PluginDTO,
  ProviderId,
  ProviderInfo,
  ProviderKeyDTO,
  ToolCall,
  TodoItemDTO,
  UserDTO,
  CreateMcpServerRequest,
  SaveKeyRequest,
  TerminalRequest,
  TerminalResponse,
} from "@/lib/types";
import type { PendingQuestionDTO } from "@/lib/question-prompt";
import type { PendingApprovalDTO } from "@/lib/permissions-prompt";
import { isTauri, getWorkspaceRoot } from "@/lib/tauri";
import { parsePartialJson } from "@/lib/utils";
import { DEFAULT_CONTEXT_CONFIG, type ContextConfig } from "@/lib/ai/context";
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings } from "@/lib/security-types";

const SECURITY_SETTINGS_KEY = "hermos_security_settings_v1";

const DEFAULT_LOCAL_USER: UserDTO = {
  id: "desktop-user",
  email: "desktop@hermos.local",
  name: "Local Developer",
  role: "admin",
  provider: "local",
};

let tabSyncChannel: BroadcastChannel | null = null;
function getTabSyncChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!tabSyncChannel) {
    try {
      tabSyncChannel = new BroadcastChannel("hermos_tab_sync");
    } catch {
      tabSyncChannel = null;
    }
  }
  return tabSyncChannel;
}

export function broadcastTabSync(type: "refresh_conversations" | "refresh_plugins" | "refresh_workspaces"): void {
  try {
    getTabSyncChannel()?.postMessage({ type });
  } catch {}
}

function loadSecuritySettings(): SecuritySettings {
  if (typeof window === "undefined") return { ...DEFAULT_SECURITY_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SECURITY_SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SECURITY_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SECURITY_SETTINGS };
}

/* ---------------------------------------------------------------------------
 * Lazy conversations
 *
 * Conversations are created client-side as "pending" placeholders and only
 * persisted (POST /api/conversations) when the first message is sent — so
 * switching projects or clicking "New conversation" never produces empty DB
 * rows, and an unsent draft survives navigating away and back.
 * ------------------------------------------------------------------------- */

/** Client-side placeholder id prefix for conversations that are not yet persisted. */
export const PENDING_CONVERSATION_PREFIX = "pending-";

/** Draft storage key used while no conversation is active at all (fresh boot). */
const FRESH_DRAFT_KEY = "__fresh__";

export function isPendingConversationId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(PENDING_CONVERSATION_PREFIX);
}

interface PendingConversationSeed {
  title?: string;
  preset?: AgentPresetDTO;
  provider?: ProviderId;
  model?: string;
  mode?: AgentMode;
  systemPrompt?: string;
  workspaceId?: string;
}

/** A lazily-created conversation that exists only client-side until first send materializes it. */
export interface PendingConversation extends ConversationDTO {
  createOpts?: PendingConversationSeed;
  /** When false, entering this chat must not adopt a draft typed in the fresh state. */
  adoptFresh?: boolean;
}

const PENDING_CONVERSATIONS_KEY = "hermos:pending-conversations";
const COMPOSER_DRAFTS_KEY = "hermos:composer-drafts";
const MAX_STORED_DRAFTS = 20;

function loadPendingConversations(): PendingConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PENDING_CONVERSATIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Drop entries older than 7 days — abandoned drafts shouldn't haunt forever.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return arr.filter(
      (p): p is PendingConversation =>
        p &&
        typeof p.id === "string" &&
        p.id.startsWith(PENDING_CONVERSATION_PREFIX) &&
        typeof p.title === "string" &&
        (!p.createdAt || new Date(p.createdAt).getTime() > cutoff),
    );
  } catch {
    return [];
  }
}

function savePendingConversations(list: PendingConversation[]): void {
  if (typeof window === "undefined") return;
  try {
    if (list.length === 0) window.localStorage.removeItem(PENDING_CONVERSATIONS_KEY);
    else window.localStorage.setItem(PENDING_CONVERSATIONS_KEY, JSON.stringify(list));
  } catch {}
}

function loadComposerDrafts(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Object.keys(out).length >= MAX_STORED_DRAFTS) break;
      if (typeof v === "string" && v.trim().length > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveComposerDrafts(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(map).filter(([, v]) => v.trim().length > 0);
    if (entries.length === 0) window.localStorage.removeItem(COMPOSER_DRAFTS_KEY);
    else {
      const trimmed = Object.fromEntries(entries.slice(-MAX_STORED_DRAFTS));
      window.localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(trimmed));
    }
  } catch {}
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: string; // accumulated JSON arg delta
  parsedArgs?: Record<string, unknown>;
  result?: unknown;
  ok?: boolean;
  status: "running" | "done" | "error";
  /** Real-time command output (stdout/stderr) accumulated during execution. */
  liveOutput?: string;
}

/** Sequential segment of an assistant message (thinking, text, or tool_call). */
export type MessageSegment =
  | { kind: "thinking"; id: string; content: string }
  | { kind: "text"; id: string; content: string }
  | { kind: "tool_call"; id: string; toolCallId: string };

/** Augmented message used in the UI with live tool-call tracking. */
export interface UIMessage extends MessageDTO {
  liveToolCalls?: LiveToolCall[];
  /** True when promptTokens is estimated rather than provider-measured. */
  promptTokensEstimated?: boolean;
  /** Chronological segments (thinking/text/tool_call) for ordered rendering. */
  segments?: MessageSegment[];
  streaming?: boolean;
  thinking?: string;
  error?: string;
}

export type RightPanelTab =
  | "files"
  | "artifacts"
  | "outline"
  | "mcp"
  | "plugins"
  | "skills"
  | "terminal"
  | "browser"
  | "office"
  | "subagents"
  | "git";

export interface ComposerDraft {
  text: string;
}

/** User workspace list entry surfaced in the workspace switcher. */
export interface WorkspaceListItem {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt?: string;
  /** Absolute filesystem path to the workspace root (desktop only). */
  rootDir?: string;
}

/**
 * Git DTOs for the git panel. Leaf types (GitFileStatus, GitFileChange) are
 * single-sourced from lib/git.ts — the canonical server-side definitions the
 * /api/git/* routes serialize. Aggregate/UI types below are compile-time tied
 * to their server counterparts so drift fails `tsc`.
 */
export type { GitFileStatus, GitFileChange } from "@/lib/git";
import type {
  GitBranch as ServerGitBranch,
  GitStatus as ServerGitStatus,
  GitWorktree as ServerGitWorktree,
} from "@/lib/git";

export interface GitCommit {
  /** Full commit hash. */
  hash: string;
  /** Abbreviated hash (first 7–8 chars). */
  shortHash: string;
  /** First line of the commit message. */
  message: string;
  /** Author name/email (optional — backend may omit). */
  author?: string;
  /** ISO date string. */
  date?: string;
}

/** UI branch entry: superset of the server shape (`remote` arrives optional). */
export interface GitBranch {
  name: string;
  current: boolean;
  remote?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** ISO date of the branch tip commit (optional). */
  lastCommit?: string;
}

/** UI worktree entry: superset of the server shape ({ path, branch, head, bare }). */
export interface GitWorktree {
  /** Absolute or workspace-relative path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
  head?: string;
  bare?: boolean;
  /** True for the main worktree (the workspace root). */
  isMain?: boolean;
  isLocked?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  /** Current branch name (empty when HEAD is detached). */
  branch?: string;
  /** Commits ahead of upstream. */
  ahead?: number;
  /** Commits behind upstream. */
  behind?: number;
  staged?: import("@/lib/git").GitFileChange[];
  modified?: import("@/lib/git").GitFileChange[];
  untracked?: import("@/lib/git").GitFileChange[];
  commits?: GitCommit[];
  branches?: GitBranch[];
  worktrees?: GitWorktree[];
  /** Full unified-diff text (all unstaged + staged changes). */
  diff?: string;
}

// Compile-time drift guards: any breaking change to the canonical server
// shapes in lib/git.ts must be reconciled here or these fail to compile.
type AssertServerGitBranchCompatible = ServerGitBranch extends GitBranch ? true : never;
type AssertServerGitWorktreeCompatible = ServerGitWorktree extends GitWorktree ? true : never;
type AssertServerGitStatusCompatible = Omit<
  ServerGitStatus,
  "clean"
> extends Pick<GitStatus, "branch" | "ahead" | "behind" | "staged" | "modified" | "untracked">
  ? true
  : never;

/** Named workspace snapshot used by Keep/Undo to restore state after edits. */
export interface Checkpoint {
  id: string;
  conversationId: string;
  label: string;
  fileCount: number;
  createdAt: string;
}

/** State configuration for the Keep/Undo file changes bar. */

/** Subagent lifecycle statuses. */
export type SubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Subagent {
  id: string;
  userId?: string;
  conversationId: string;
  name: string;
  task: string;
  systemPrompt?: string | null;
  status: SubagentStatus;
  progress?: number | null;
  result?: string | null;
  error?: string | null;
  partial?: { content: string; thinking?: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** State tracking for in-flight Office document generation. */
export interface OfficeGenState {
  generating: boolean;
  /** Last generation's output path (cleared on next generation). */
  lastPath: string | null;
  /** Last generation's document type (for the progress label). */
  lastType: "presentation" | "document" | "pdf" | null;
}

export type PermissionDecision = "allow-once" | "always-allow" | "deny";

export interface PermissionPromptState {
  /** Unique id for this prompt (used to dedupe + auto-dismiss timers). */
  id: string;
  /** Conversation ID that triggered the prompt (if known). */
  conversationId?: string;
  /** Permission action key, e.g. "file.write" / "command.run". */
  action: string;
  /** Human-readable target, e.g. "src/math.ts" or "cat src/math.ts". */
  target: string;
  /** Tool-call id that triggered the prompt (for backend correlation). */
  toolCallId?: string;
  /** Optional tool name (e.g. "edit_file", "run_command"). */
  toolName?: string;
  /** Resolver invoked with the user's permission decision. */
  resolve: (decision: PermissionDecision) => void;
  /** Created timestamp — used by the UI to render a countdown. */
  createdAt: number;
}

export interface QuestionItemState {
  question: string;
  options?: string[];
  isMultiSelect?: boolean;
}

export interface QuestionPromptState {
  id: string;
  toolCallId: string;
  conversationId: string;
  questions: QuestionItemState[];
  question?: string;
  options?: string[];
  isMultiSelect?: boolean;
  createdAt: number;
}

interface AppState {
  /* Auth */
  currentUser: UserDTO | null;
  authLoading: boolean;
  authChecked: boolean;

  /* Catalog (immutable) */
  providers: ProviderInfo[];

  /* BYOK */
  providerKeys: ProviderKeyDTO[];

  /* Conversations */
  conversations: ConversationDTO[];
  activeConversationId: string | null;
  messages: UIMessage[];

  /** Per-conversation message cache across all loaded conversations. */
  messagesByConversation: Record<string, UIMessage[]>;

  /** Queued-turn IDs answered in the last run to avoid re-sending. */
  queuedAnsweredByConversation: Record<string, string[]>;

  /* Streaming */
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamError: string | null;
  rateLimitRetry: {
    retryAfterMs: number;
    attempt: number;
    maxAttempts: number;
    conversationId: string;
    startedAt: number;
  } | null;

  /** Per-conversation streaming state for parallel conversation streams. */
  streamingStateByConversation: Record<
    string,
    { isStreaming: boolean; streamingMessageId: string | null }
  >;

  /* Right panel */
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab;
  activeArtifactPath: string | null;
  artifactsList: string[];
  /** Left sidebar collapsed to a narrow rail (shows icons only). */
  sidebarCollapsed: boolean;
  /** Selected project/workspace ID in the sidebar (null = show all). */
  selectedProjectId: string | null;
  /** Set of workspace IDs whose project group is collapsed in the sidebar. */
  collapsedProjects: string[];

  /* Settings */
  settingsOpen: boolean;
  settingsTab: string;

  /* Composer / model state */
  composerMode: AgentMode;
  selectedProvider: ProviderId;
  selectedModel: string;
  systemPrompt: string;
  enabledTools: string[];
  composerDraft: string;
  /** Unsent composer drafts keyed by conversation id ("__fresh__" = no active conversation). */
  composerDrafts: Record<string, string>;
  /** Conversations created lazily client-side; not persisted until the first message is sent. */
  pendingConversations: PendingConversation[];
  thinkingLevel: string;
  thinkingExpanded: Record<string, boolean>;
  scrollPositions: Record<string, number>;

  /* Catalogs */
  mcpServers: McpServerDTO[];
  plugins: PluginDTO[];
  skills: PluginDTO[];
  agentPresets: AgentPresetDTO[];

  /* Browser */
  browserAgentActive: boolean;
  setBrowserAgentActive: (active: boolean) => void;

  /* Loading flags */
  loadingConversations: boolean;
  loadingMessages: boolean;

  /* Theme (ephemeral UI state; persistence lives in the theme provider) */
  commandOpen: boolean;

  /* Keyboard shortcuts overlay */
  shortcutsOpen: boolean;

  /* Find-in-files overlay (⌘⇧F) — global workspace grep modal */
  findInFilesOpen: boolean;
  setFindInFilesOpen: (v: boolean) => void;
  toggleFindInFilesOpen: () => void;

  /** Workspace-relative paths open as editor tabs (capped by LRU eviction). */
  openFiles: string[];
  /** Per-project open files. Keyed by workspaceId. */
  openFilesByProject: Record<string, string[]>;
  /** The path of the currently-visible tab. null when no tab is open. */
  activeFileTab: string | null;
  /** Per-project active file tab. Keyed by workspaceId. */
  activeFileTabByProject: Record<string, string | null>;
  /** Open or focus a file tab, evicting the oldest non-active tab if at cap. */
  openFileTab: (path: string) => void;
  /** Close a file tab and focus the adjacent remaining tab if active. */
  closeFileTab: (path: string) => void;
  /** Focus an already-open tab. No-op if the path isn't in openFiles. */
  setActiveFileTab: (path: string) => void;
  /** Close every open tab. */
  closeAllFileTabs: () => void;

  /** Whether the editor auto-refreshes open files via file-watch SSE. */
  fileWatchEnabled: boolean;
  setFileWatchEnabled: (v: boolean) => void;
  toggleFileWatchEnabled: () => void;
  /** Connection status of the workspace file-watch EventSource stream. */
  fileWatchConnected: boolean;
  setFileWatchConnected: (v: boolean) => void;

  /** UI density: comfortable (default) or compact. Persisted to localStorage. */
  density: "comfortable" | "compact";
  /** UI font size in px (12-18, default 14). Persisted to localStorage. */
  fontSize: number;
  setDensity: (d: "comfortable" | "compact") => void;
  setFontSize: (s: number) => void;

  /** Enterprise-tunable context retention config. Persisted to localStorage. */
  contextConfig: ContextConfig;
  setContextConfig: (cfg: Partial<ContextConfig>) => void;

  /** Security, Privacy & Secret Redaction settings (Cursor & Antigravity grade). Persisted to localStorage. */
  securitySettings: SecuritySettings;
  setSecuritySettings: (cfg: Partial<SecuritySettings>) => void;

  /** Fetch and reconcile server-authoritative security settings. */
  refreshSecuritySettings: () => Promise<void>;

  /** Whether the dual-pane split editor is currently open. */
  splitEditorOpen: boolean;
  /** File path displayed in the right pane of the split editor. */
  splitEditorFile: string | null;
  /** Focused pane in the split editor ("left" | "right"). */
  splitEditorActive: "left" | "right";
  /** Open or close the split editor. Clears splitEditorFile on close. */
  setSplitEditorOpen: (v: boolean) => void;
  /** Toggle the split editor open/closed. */
  toggleSplitEditor: () => void;
  /** Set the right-pane file in the split editor and track it in openFiles. */
  setSplitEditorFile: (path: string | null) => void;
  /** Set which side of the split editor currently has focus. */
  setSplitEditorActive: (side: "left" | "right") => void;

  /** Trim details when middle messages were dropped to fit the context window. */
  contextTrimmed: { dropped: number; keptTokens: number; activePromptTokens?: number } | null;
  setContextTrimmed: (info: { dropped: number; keptTokens: number; activePromptTokens?: number } | null) => void;
  /** The checkpoint created before the latest agent run (so Undo can revert to it). */
  preTurnCheckpointId: string | null;
  setPreTurnCheckpoint: (id: string | null) => void;

  /** Recent command palette command IDs (capped at 5, persisted in localStorage). */
  recentCommands: string[];
  /** Push a command id onto the recent-commands list (deduped, capped at 5). */
  pushRecentCommand: (id: string) => void;
  /** Clear the recent-commands list (used by logout). */
  clearRecentCommands: () => void;

  activeTodosByConversation: Record<string, TodoItemDTO[]>;
  /** Recent workspace checkpoints for the active conversation. */
  checkpoints: Checkpoint[];
  checkpointsLoading: boolean;
  refreshCheckpoints: (conversationId: string) => Promise<void>;
  /** Creates a workspace checkpoint snapshot labelled with `label`. */
  createCheckpoint: (
    conversationId: string,
    label: string,
    toolCallIds?: string[],
  ) => Promise<Checkpoint | null>;

  /** Subagents spawned for the active conversation. */
  subagents: Subagent[];
  subagentsLoading: boolean;
  subagentsError: string | null;
  subagentsConversationId: string | null;
  activeSubagentId: string | null;
  setActiveSubagentId: (id: string | null) => void;
  refreshSubagents: (conversationId: string) => Promise<void>;
  /** Set subagents directly from SSE data (no API call). */
  setSubagents: (conversationId: string, list: Subagent[]) => void;
  /** Store-action replacement for direct setState in subagents panel (HMR-safe). */
  setSubagentsForConversation: (conversationId: string, list: Subagent[]) => void;
  prepareSubagentsStream: (conversationId: string) => void;
  clearSubagentsForPending: () => void;
  createSubagent: (
    conversationId: string,
    name: string,
    task: string,
    systemPrompt?: string,
  ) => Promise<Subagent | null>;
  deleteSubagent: (id: string) => Promise<void>;
  setThinkingLevel: (level: string) => void;
  setThinkingExpanded: (id: string, open: boolean) => void;
  saveScrollPosition: (conversationId: string, pos: number) => void;
  /** True while a checkpoint is being created (for the TaskProgress indicator). */
  checkpointCreating: boolean;

  /** State tracking for in-flight Office document generation. */
  officeGenerating: boolean;
  officeLastPath: string | null;
  officeLastType: "presentation" | "document" | "pdf" | null;
  setOfficeGenerating: (
    generating: boolean,
    opts?: { path?: string; type?: "presentation" | "document" | "pdf" },
  ) => void;

  /* Editing a sent user message — when set, the composer is in edit mode */
  editingMessageId: string | null;

  /** Pending tool-call permission prompt requiring user decision. */
  permissionPrompt: PermissionPromptState | null;
  permissionPromptsByConversation: Record<string, PermissionPromptState>;
  setPermissionPrompt: (prompt: PermissionPromptState | null, conversationId?: string) => void;
  resolvePermissionPrompt: (id: string, decision: PermissionDecision) => void;

  /** Pending agent question prompt requiring user answer. */
  questionPrompt: QuestionPromptState | null;
  questionPromptsByConversation: Record<string, QuestionPromptState>;
  setQuestionPrompt: (prompt: QuestionPromptState | null, conversationId?: string) => void;
  resolveQuestionPrompt: (
    id: string,
    payload: {
      answers?: Array<{
        questionIndex?: number;
        question?: string;
        selectedOptions?: string[];
        text?: string;
      }>;
      selectedOptions?: string[];
      text?: string;
    },
  ) => Promise<void>;
  /** Best-effort recovery of a pending agent question after a page refresh. */
  recoverQuestionPrompt: (conversationId: string) => Promise<void>;
  /** Best-effort recovery of a pending tool permission prompt after a page refresh. */
  recoverPermissionPrompt: (conversationId: string) => Promise<void>;

  /** Server-side conversation search with client fallback on 404. */
  searchConversations: (q: string) => Promise<ConversationDTO[] | null>;

  /** Bulk conversation selection mode and selected conversation IDs. */
  bulkSelectMode: boolean;
  selectedConversationIds: Set<string>;
  bulkDeleting: boolean;
  setBulkSelectMode: (v: boolean) => void;
  toggleConversationSelected: (id: string) => void;
  setConversationSelected: (id: string, selected: boolean) => void;
  selectAllConversations: () => void;
  clearSelectedConversations: () => void;
  /** Bulk-delete conversations with single-delete fallback. */
  bulkDeleteConversations: (ids: string[]) => Promise<number>;

  /** Workspaces owned by the current user and active workspace state. */
  workspaces: WorkspaceListItem[];
  activeWorkspace: WorkspaceListItem | null;
  workspacesLoading: boolean;
  refreshWorkspaces: () => Promise<void>;
  /** Switch active workspace and refresh workspace/git status. */
  switchWorkspace: (
    workspaceId: string,
    name?: string,
    opts?: { skipAutoSelectConversation?: boolean },
  ) => Promise<boolean>;
  renameWorkspace: (workspaceId: string, newName: string) => Promise<boolean>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;

  /** Per-workspace git status shared by the top bar and Git panel. */
  gitStatus: GitStatus | null;
  gitStatusLoading: boolean;
  gitStatusError: string | null;
  refreshGitStatus: () => Promise<void>;

  /** UI request flag to trigger the OpenFolderDialog across panel tabs. */
  openFolderDialogRequested: boolean;
  requestOpenFolderDialog: () => void;
  clearOpenFolderDialogRequest: () => void;

  hydrate: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshMessages: (conversationId: string) => Promise<void>;
  refreshProviderKeys: () => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshPresets: () => Promise<void>;
  refreshProviders: () => Promise<void>;

  logout: () => Promise<void>;

  selectConversation: (id: string) => Promise<void>;
  createConversation: (opts?: {
    title?: string;
    preset?: AgentPresetDTO;
    provider?: ProviderId;
    model?: string;
    mode?: AgentMode;
    systemPrompt?: string;
    workspaceId?: string;
  }) => Promise<ConversationDTO | null>;
  /**
   * Ensure a conversation id refers to a persisted DB row — lazily materializes
   * a pending conversation on first message. Returns the real id, or null when
   * there is nothing to send into.
   */
  ensureRealConversation: (conversationId?: string) => Promise<string | null>;
  renameConversation: (id: string, title: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;

  /* streaming mutations */
  appendDelta: (messageId: string, delta: string, conversationId?: string) => void;
  setThinking: (messageId: string, content: string, conversationId?: string) => void;
  resetThinking: (messageId: string, conversationId?: string) => void;
  startToolCall: (toolCallId: string, name: string, conversationId?: string) => void;
  appendToolCallArgs: (toolCallId: string, delta: string, conversationId?: string) => void;
  finishToolCall: (toolCallId: string, result: unknown, ok: boolean, conversationId?: string) => void;
  endToolCall: (toolCallId: string, conversationId?: string) => void;
  /** Append real-time command output to a running tool call's card. */
  appendCommandOutput: (toolCallId: string, text: string, running: boolean, conversationId?: string) => void;

  /** Segment-aware streaming mutations updating chronological message segments. */
  appendSegmentText: (messageId: string, delta: string, conversationId?: string) => void;
  appendSegmentThinking: (messageId: string, delta: string, conversationId?: string) => void;
  pushSegmentToolCall: (messageId: string, toolCallId: string, conversationId?: string) => void;

  applyUsage: (
    messageId: string,
    tokensIn: number,
    tokensOut: number,
    model: string,
    provider: string,
    conversationId?: string,
    promptTokens?: number,
    cacheWrites?: number,
    cacheReads?: number,
    /** True when `promptTokens` is a live estimate (see ChatStreamEvent.usage.estimated). */
    estimated?: boolean,
  ) => void;
  clearMessageUsage: (messageId: string, conversationId?: string) => void;
  setStreaming: (v: boolean, conversationId?: string) => void;
  setStreamingMessageId: (id: string | null, conversationId?: string) => void;
  setStreamError: (e: string | null) => void;
  setRateLimitRetry: (
    data: {
      retryAfterMs: number;
      attempt: number;
      maxAttempts: number;
      conversationId: string;
      startedAt: number;
    } | null,
  ) => void;
  finalizeStreamingMessage: (messageId: string, conversationId?: string) => void;
  appendAssistantPlaceholder: (messageId: string, conversationId?: string) => void;
  appendUserMessage: (msg: MessageDTO, conversationId?: string) => void;
  appendAssistantError: (messageId: string, message: string, conversationId?: string) => void;
  /** Record queued-turn ids the just-finished run answered (done event). */
  markQueuedAnswered: (conversationId: string, ids: string[]) => void;
  /** Clear a conversation's answered-id report once the fallback consumed it. */
  clearQueuedAnswered: (conversationId: string) => void;

  /* UI controls */
  setRightPanelOpen: (v: boolean) => void;
  setRightPanelTab: (t: RightPanelTab) => void;
  setActiveArtifactPath: (path: string | null) => void;
  setArtifactsList: (paths: string[]) => void;
  addArtifact: (path: string) => void;
  removeArtifact: (path: string) => void;
  setSettingsOpen: (v: boolean) => void;
  setSettingsTab: (t: string) => void;
  setCommandOpen: (v: boolean) => void;
  setShortcutsOpen: (v: boolean) => void;
  toggleShortcutsOpen: () => void;
  setEditingMessageId: (id: string | null) => void;
  setComposerMode: (m: AgentMode) => void;
  setSelectedProvider: (p: ProviderId) => void;
  setSelectedModel: (m: string) => void;
  /** Apply provider/model selection and persist to active conversation. */
  applyChatModelSelection: (p: ProviderId, m: string) => Promise<void>;
  toggleSidebar: () => void;
  selectProject: (id: string | null) => Promise<void>;
  toggleProjectCollapse: (id: string) => void;
  setSystemPrompt: (s: string) => void;
  setEnabledTools: (t: string[]) => void;
  setComposerDraft: (s: string) => void;

  /* Message actions: copy / regenerate / edit / branch */
  /** Remove a single message (rollback for a failed optimistic append). */
  removeMessage: (messageId: string, conversationId?: string) => void;
  removeMessageAndAfter: (messageId: string) => void;
  /** Remove all messages strictly AFTER messageId, keeping the target itself. */
  removeMessagesAfter: (messageId: string) => void;
  updateMessageContent: (messageId: string, content: string) => void;
  persistMessageEdit: (
    conversationId: string,
    messageId: string,
    content: string,
  ) => Promise<boolean>;
  branchConversation: (messageId: string) => Promise<string | null>;
  findPrecedingUserMessage: (messageId: string) => UIMessage | null;

  /* MCP */
  createMcpServer: (req: CreateMcpServerRequest) => Promise<McpServerDTO | null>;
  deleteMcpServer: (id: string) => Promise<void>;
  connectMcpServer: (id: string) => Promise<void>;
  disconnectMcpServer: (id: string) => Promise<void>;

  /* Plugins */
  installPlugin: (p: Partial<PluginDTO> & { name: string }) => Promise<PluginDTO | null>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;

  /* BYOK */
  saveProviderKey: (req: SaveKeyRequest) => Promise<void>;
  removeProviderKey: (provider: ProviderId) => Promise<void>;
  testProviderKey: (provider: ProviderId) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

  /* Terminal */
  runTerminal: (req: TerminalRequest) => Promise<TerminalResponse | null>;

  /* Hydration of selected provider/model defaults from active conversation */
  syncSelectionFromActive: () => void;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are HermOS, a highly realistic, strict, and powerful agentic IDE assistant. Be concise, precise, and correct. Avoid hallucinations, mock/placeholder code, stubs, and AI slop. Use modern stacks (Next.js, React, Vite, Node.js) for building new projects instead of basic HTML/JS/CSS. If the user makes incorrect assumptions, point them out and offer honest, correct paths forward.";

/** Maximum open editor tabs before LRU eviction. */
const MAX_OPEN_TABS = 10;

/** Cap live command output buffering to prevent unbounded memory growth. */
const MAX_LIVE_OUTPUT_CHARS = 200_000;
/** Cap streamed thinking/text segments to prevent unbounded buffering. */
const MAX_SEGMENT_CHARS = 500_000;

/* localStorage preference persistence helpers. */

const RECENT_COMMANDS_KEY = "hermos:recent-commands";
const FILE_WATCH_KEY = "hermos:file-watch-enabled";
const DENSITY_KEY = "hermos:density";
const FONT_SIZE_KEY = "hermos:font-size";
const CONTEXT_CONFIG_KEY = "hermos:context-config";
const MAX_RECENT_COMMANDS = 5;

function loadRecentCommands(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, MAX_RECENT_COMMANDS);
  } catch {
    return [];
  }
}

function loadFileWatchEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(FILE_WATCH_KEY);
    if (raw === null) return true; // default: enabled
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

function loadDensity(): "comfortable" | "compact" {
  if (typeof window === "undefined") return "comfortable";
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY);
    if (raw === "compact") return "compact";
    return "comfortable";
  } catch {
    return "comfortable";
  }
}

function loadFontSize(): number {
  if (typeof window === "undefined") return 14;
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_KEY);
    if (raw === null) return 14;
    const n = parseInt(raw, 10);
    if (n >= 12 && n <= 18) return n;
    return 14;
  } catch {
    return 14;
  }
}

function loadContextConfig(): ContextConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CONTEXT_CONFIG };
  try {
    const raw = window.localStorage.getItem(CONTEXT_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONTEXT_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      pruneProtectTokens: typeof parsed.pruneProtectTokens === "number" && parsed.pruneProtectTokens >= 1000 ? parsed.pruneProtectTokens : DEFAULT_CONTEXT_CONFIG.pruneProtectTokens,
      compactionBuffer: typeof parsed.compactionBuffer === "number" && parsed.compactionBuffer >= 1000 ? parsed.compactionBuffer : DEFAULT_CONTEXT_CONFIG.compactionBuffer,
      outputTokenCap: typeof parsed.outputTokenCap === "number" && parsed.outputTokenCap >= 1000 ? parsed.outputTokenCap : DEFAULT_CONTEXT_CONFIG.outputTokenCap,
      tailTurns: typeof parsed.tailTurns === "number" && parsed.tailTurns >= 1 && parsed.tailTurns <= 10 ? parsed.tailTurns : DEFAULT_CONTEXT_CONFIG.tailTurns,
    };
  } catch {
    return { ...DEFAULT_CONTEXT_CONFIG };
  }
}

/** In-flight materializations of pending conversations (dedupes rapid double-sends). */
const ensureRealConversationInFlight = new Map<string, Promise<string | null>>();

export const useAppStore = create<AppState>((set, get) => ({
  currentUser: DEFAULT_LOCAL_USER,
  authLoading: false,
  authChecked: true,
  providers: [],
  providerKeys: [],

  conversations: [],
  activeConversationId: null,
  messages: [],
  messagesByConversation: {},
  queuedAnsweredByConversation: {},

  isStreaming: false,
  streamingMessageId: null,
  streamError: null,
  rateLimitRetry: null,
  streamingStateByConversation: {},

  rightPanelOpen: false,
  rightPanelTab: "files",
  activeArtifactPath: null,
  artifactsList: [],
  activeTodosByConversation: {},
  sidebarCollapsed: true,
  selectedProjectId: null,
  collapsedProjects: [],

  settingsOpen: false,
  settingsTab: "providers",

  composerMode: "agent",
  selectedProvider: "puter",
  selectedModel: "auto",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  enabledTools: [],
  composerDraft: "",
  composerDrafts: {},
  pendingConversations: [],
  thinkingLevel: "default",
  thinkingExpanded: {},
  scrollPositions: {},

  mcpServers: [],
  plugins: [],
  skills: [],
  agentPresets: [],

  browserAgentActive: false,
  setBrowserAgentActive: (active) => set({ browserAgentActive: active }),

  loadingConversations: false,
  loadingMessages: false,
  commandOpen: false,
  shortcutsOpen: false,
  findInFilesOpen: false,

  editingMessageId: null,
  permissionPrompt: null,
  permissionPromptsByConversation: {},
  questionPrompt: null,
  questionPromptsByConversation: {},

  /* Open file tabs (workspace panel) — empty until the user opens a file */
  openFiles: [],
  openFilesByProject: {},
  activeFileTab: null,
  activeFileTabByProject: {},

  /* File watch — enabled by default; the editor opens an EventSource on
     /api/workspace/watch while a file is open. The user can toggle this
     from the editor header (Eye / EyeOff button). */
  fileWatchEnabled: loadFileWatchEnabled(),
  fileWatchConnected: false,

  /* Appearance — persisted to localStorage */
  density: loadDensity(),
  fontSize: loadFontSize(),

  /* Context governance — persisted to localStorage */
  contextConfig: loadContextConfig(),

  /* Security, Privacy & Secret Redaction settings — persisted to localStorage */
  securitySettings: loadSecuritySettings(),

  /* Split editor — closed by default. The user opens it via the
     "Split editor" button in the editor header or the ⌘\ shortcut. */
  splitEditorOpen: false,
  splitEditorFile: null,
  splitEditorActive: "left",

  /* Context-trimmed indicator — null until the backend emits a
     `context_trimmed` SSE event for the active conversation. */
  contextTrimmed: null,
  preTurnCheckpointId: null,

  /* Recent commands (command palette) — loaded from localStorage. Empty
     on first load (no entries yet). The palette pushes a command id onto
     this list whenever the user runs a command. */
  recentCommands: loadRecentCommands(),

  /* Checkpoints */
  checkpoints: [],
  checkpointsLoading: false,

  /* Subagents (per active conversation) — empty until refreshed */
  subagents: [],
  subagentsLoading: false,
  subagentsError: null,
  subagentsConversationId: null,
  activeSubagentId: null,
  checkpointCreating: false,

  /* Office generation — idle until the Office panel runs a generation */
  officeGenerating: false,
  officeLastPath: null,
  officeLastType: null,

  /* Bulk-select */
  bulkSelectMode: false,
  selectedConversationIds: new Set<string>(),
  bulkDeleting: false,

  /* Workspaces (switcher) — empty until the first hydrate / switcher open. */
  workspaces: [],
  activeWorkspace: null,
  workspacesLoading: false,

  /* Git status — null until the first refresh succeeds (or sets isRepo=false). */
  gitStatus: null,
  gitStatusLoading: false,
  gitStatusError: null,

  /* Open-folder dialog request — false until the ProjectSelector
     sets it. The WorkspacePanel consumes it on mount. */
  openFolderDialogRequested: false,

  hydrate: async () => {
    await get().refreshAuth();
    if (!get().currentUser) return;
    // Restore lazily-created conversations and unsent drafts from a previous
    // session before any component reads them.
    set({
      pendingConversations: loadPendingConversations(),
      composerDrafts: loadComposerDrafts(),
    });
    // Fire all refreshes in parallel for snappy startup.
    await Promise.all([
      get().refreshProviders(),
      get().refreshProviderKeys(),
      get().refreshConversations(),
      get().refreshMcpServers(),
      get().refreshPlugins(),
      get().refreshSkills(),
      get().refreshPresets(),
      // Best-effort workspace and git status refresh
      get().refreshWorkspaces(),
      get().refreshGitStatus(),
      get().refreshSecuritySettings(),
    ]);

    // Cross-tab synchronization listener
    const ch = getTabSyncChannel();
    if (ch && !ch.onmessage) {
      ch.onmessage = (event) => {
        const type = event.data?.type;
        if (type === "refresh_conversations") {
          get().refreshConversations();
          // Another tab may have materialized a pending conversation — reload
          // ours so this tab doesn't re-create the same chat on send.
          set({ pendingConversations: loadPendingConversations() });
        }
        if (type === "refresh_plugins") get().refreshPlugins();
        if (type === "refresh_workspaces") get().refreshWorkspaces();
      };
    }
    // Desktop: fetch active workspace root via Tauri
    if (isTauri()) {
      const activeWs = get().activeWorkspace;
      if (activeWs?.id) {
        getWorkspaceRoot(activeWs.id).then((rootDir) => {
          if (rootDir) {
            set((s) => ({
              workspaces: s.workspaces.map((w) =>
                w.id === activeWs.id ? { ...w, rootDir } : w
              ),
              activeWorkspace: s.activeWorkspace?.id === activeWs.id
                ? { ...s.activeWorkspace!, rootDir }
                : s.activeWorkspace,
            }));
          }
        });
      }
    }
  },

  refreshAuth: async () => {
    try {
      const data = await apiGet<{ user: UserDTO | null }>("/api/auth/me");
      const user = data?.user ?? DEFAULT_LOCAL_USER;
      set({ currentUser: user, authChecked: true, authLoading: false });
    } catch {
      set({ currentUser: DEFAULT_LOCAL_USER, authChecked: true, authLoading: false });
    }
  },

  logout: async () => {
    // Settle any pending permission approvals server-side (deny) before
    // dropping the cards, so awaiting closures don't hang forever across a
    // re-login.
    const pendingPrompts = Object.values(get().permissionPromptsByConversation);
    for (const p of pendingPrompts) {
      void get().resolvePermissionPrompt(p.id, "deny");
    }
    const singlePrompt = get().permissionPrompt;
    if (singlePrompt && !pendingPrompts.some((p) => p.id === singlePrompt.id)) {
      void get().resolvePermissionPrompt(singlePrompt.id, "deny");
    }
    set({
      conversations: [],
      messages: [],
      activeConversationId: null,
      providerKeys: [],
      mcpServers: [],
      plugins: [],
      skills: [],
      agentPresets: [],
      // Clear bulk-select on logout
      bulkSelectMode: false,
      selectedConversationIds: new Set<string>(),
      bulkDeleting: false,
      // Close ephemeral overlays so they don't survive a re-login.
      findInFilesOpen: false,

      // Close open file tabs on logout
      openFiles: [],
      openFilesByProject: {},
      activeFileTab: null,
      activeFileTabByProject: {},
      // Reset split editor on logout
      splitEditorOpen: false,
      splitEditorFile: null,
      splitEditorActive: "left",
      // Reset file-watch connection state
      fileWatchConnected: false,
      // Clear the context-trimmed indicator so the next user starts fresh.
      contextTrimmed: null,
      // Clear the recent-commands list so the next user starts fresh.
      recentCommands: [],
      // Clear checkpoints so the next user starts clean.
      checkpoints: [],
      // Clear background task states on logout
      subagents: [],
      subagentsConversationId: null,
      subagentsError: null,
      checkpointCreating: false,
      officeGenerating: false,
      officeLastPath: null,
      officeLastType: null,
      preTurnCheckpointId: null,
      // Clear workspaces and git status
      workspaces: [],
      activeWorkspace: null,
      workspacesLoading: false,
      gitStatus: null,
      gitStatusLoading: false,
      gitStatusError: null,
      // Clear pending open-folder dialog requests
      openFolderDialogRequested: false,

      // Clear per-conversation caches and streaming state so no data from
      // the previous session leaks into the next one.
      messagesByConversation: {},
      streamingStateByConversation: {},
      activeTodosByConversation: {},
      queuedAnsweredByConversation: {},
      // Drop lazy conversations and unsent drafts from the previous session.
      pendingConversations: [],
      composerDrafts: {},
      isStreaming: false,
      streamingMessageId: null,
      // Drop any pending permission/question prompts.
      permissionPrompt: null,
      permissionPromptsByConversation: {},
      questionPrompt: null,
      questionPromptsByConversation: {},
      // Reset composer + message-edit state.
      composerDraft: "",
      editingMessageId: null,
      rateLimitRetry: null,
      streamError: null,
    });
    try {
      window.localStorage.removeItem(PENDING_CONVERSATIONS_KEY);
      window.localStorage.removeItem(COMPOSER_DRAFTS_KEY);
    } catch {}
  },

  refreshWorkspaces: async () => {
    set({ workspacesLoading: true });
    try {
      // Fetch active workspace and workspace list in parallel
      const [infoRes, listRes] = await Promise.all([
        apiGet<{ workspace: { id: string; name: string; isActive?: boolean; rootDir?: string } | null }>(
          "/api/workspace",
        ).catch(() => null),
        apiPost<{ workspaces: Array<{ id: string; name: string; isActive?: boolean; updatedAt?: string; rootDir?: string }> }>(
          "/api/workspace",
          { action: "list" },
        ).catch(() => null),
      ]);
      const active = infoRes?.workspace ?? null;
      const list: WorkspaceListItem[] = (listRes?.workspaces ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        isActive: active ? w.id === active.id : !!w.isActive,
        updatedAt: w.updatedAt,
        rootDir: w.rootDir,
      }));
      // If the active workspace isn't in the list (race), append it.
      const activeItem: WorkspaceListItem | null = active
        ? list.find((w) => w.id === active.id) ?? {
            id: active.id,
            name: active.name,
            isActive: true,
            rootDir: active.rootDir,
          }
        : list.find((w) => w.isActive) ?? null;
      set({ workspaces: list, activeWorkspace: activeItem, workspacesLoading: false });
    } catch {
      set({ workspacesLoading: false });
    }
  },

  switchWorkspace: async (workspaceId, name, opts) => {
    // Switch workspace with fallback to open-by-name on 404/405
    let switched = false;
    let rootDir: string | undefined;
    try {
      const res = await apiPost<{ workspace: { id: string; name: string; isActive: boolean; rootDir?: string } }>("/api/workspace/switch", { workspaceId });
      switched = true;
      rootDir = res.workspace?.rootDir;
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        let fallbackName = name;
        if (!fallbackName) {
          const w = get().workspaces.find((x) => x.id === workspaceId);
          if (!w) return false;
          fallbackName = w.name;
        }
        try {
          const res = await apiPost<{ workspace: { id: string; name: string; isActive: boolean; rootDir?: string } }>("/api/workspace", { action: "open", name: fallbackName });
          switched = true;
          rootDir = res.workspace?.rootDir;
        } catch {
          switched = false;
        }
      } else {
        switched = false;
      }
    }
    if (switched) {
      const s = get();
      const prevId = s.selectedProjectId;
      const updatedOpenFilesByProject = prevId
        ? { ...s.openFilesByProject, [prevId]: s.openFiles }
        : s.openFilesByProject;
      const updatedActiveFileTabByProject = prevId
        ? { ...s.activeFileTabByProject, [prevId]: s.activeFileTab }
        : s.activeFileTabByProject;

      // Restore target project's open files and active file tab
      const targetFiles = updatedOpenFilesByProject[workspaceId] ?? [];
      const savedTab = updatedActiveFileTabByProject[workspaceId] ?? null;
      const targetTab =
        targetFiles.length > 0
          ? savedTab && targetFiles.includes(savedTab)
            ? savedTab
            : targetFiles[0]
          : null;
      const targetWorkspace = s.workspaces.find((w) => w.id === workspaceId);
      set((s) => ({
        workspaces: s.workspaces.map((w) => ({
          ...w,
          isActive: w.id === workspaceId,
        })),
        activeWorkspace: targetWorkspace ? { ...targetWorkspace, rootDir } : s.activeWorkspace,
        selectedProjectId: workspaceId,
        openFilesByProject: updatedOpenFilesByProject,
        activeFileTabByProject: updatedActiveFileTabByProject,
        openFiles: targetFiles,
        activeFileTab: targetTab,
        gitStatus: null,
        gitStatusError: null,
      }));
      const convs = get().conversations;
      const activeId = get().activeConversationId;
      const activePending = isPendingConversationId(activeId)
        ? get().pendingConversations.find((p) => p.id === activeId)
        : undefined;
      // The active pending chat already belongs to the target workspace —
      // keep it (and its unsent draft) instead of rebinding.
      if (!(activePending && activePending.workspaceId === workspaceId)) {
        const localActive = activeId ? convs.find((c) => c.id === activeId) : undefined;
        // Resolve active conversation workspace binding server-side if not in
        // memory. Pending ids have no DB row — skip the lookup for them.
        let activeConv = localActive;
        if (!localActive && activeId && !activePending) {
          try {
            const data = await apiGet<{ conversation: ConversationDTO }>(
              `/api/conversations/${encodeURIComponent(activeId)}`,
            );
            activeConv = data?.conversation ?? undefined;
          } catch {
            // Server error — treat as unattached (falls through below).
          }
        }
        if (!activeConv || activeConv.workspaceId !== workspaceId) {
          if (opts?.skipAutoSelectConversation) {
            // Caller will bind active conversation directly
          } else {
            // Bind most recently updated conversation for this workspace
            let matchingConv = convs.find((c) => c.workspaceId === workspaceId);
            if (!matchingConv) {
              try {
                const data = await apiGet<{ conversations: ConversationDTO[] }>(
                  "/api/conversations",
                  { query: { workspaceId, limit: "1" } },
                );
                matchingConv = data?.conversations?.[0];
              } catch {
                // Server error — fall through to createConversation below.
              }
            }
            if (matchingConv) {
              void get().selectConversation(matchingConv.id);
            } else {
              // No conversation for this workspace yet — bind a lazily-created
              // pending one instead of writing an empty row to the DB. It only
              // materializes once the user actually sends a message.
              void get()
                .createConversation({ workspaceId })
                .then((created) => {
                  if (!created) set({ activeConversationId: null, messages: [] });
                });
            }
          }
        }
      }
      void get().refreshWorkspaces();
      void get().refreshGitStatus();
    }
    return switched;
  },

  renameWorkspace: async (workspaceId, newName) => {
    try {
      const res = await apiPost<{ workspace: WorkspaceListItem }>("/api/workspace", {
        action: "rename", workspaceId, newName,
      });
      const updated = res.workspace;
      set((s) => ({
        workspaces: s.workspaces.map((w) => w.id === workspaceId ? { ...w, name: updated.name } : w),
        activeWorkspace: s.activeWorkspace?.id === workspaceId ? { ...s.activeWorkspace, name: updated.name } : s.activeWorkspace,
      }));
      return true;
    } catch {
      return false;
    }
  },

  deleteWorkspace: async (workspaceId) => {
    try {
      await apiPost("/api/workspace", { action: "delete", workspaceId });
      const s = get();
      const isActive = s.activeWorkspace?.id === workspaceId;
      set((s) => {
        const { [workspaceId]: _tab, ...restTabs } = s.activeFileTabByProject;
        const { [workspaceId]: _files, ...restFiles } = s.openFilesByProject;
        return {
          workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
          activeWorkspace: s.activeWorkspace?.id === workspaceId ? null : s.activeWorkspace,
          selectedProjectId: s.selectedProjectId === workspaceId ? null : s.selectedProjectId,
          activeFileTabByProject: restTabs,
          openFilesByProject: restFiles,
        };
      });
      if (isActive) {
        void get().refreshWorkspaces();
      }
      return true;
    } catch {
      return false;
    }
  },

  refreshGitStatus: async () => {
    if (get().gitStatusLoading) return;
    set({ gitStatusLoading: true });
    try {
      const data = await apiGet<{ isRepo: boolean; status: ServerGitStatus | null }>(
        "/api/git/status",
      );
      const status = data?.status ?? null;
      // Merge isRepo into the status object so the panel can check it.
      const merged = data?.isRepo
        ? (status ? { ...status, isRepo: true } : null)
        : { isRepo: false };
      set({
        gitStatus: merged,
        gitStatusLoading: false,
        gitStatusError: null,
      });
    } catch (e) {
      // Graceful fallback when git endpoints are unavailable (404/405)
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        set({
          gitStatus: null,
          gitStatusLoading: false,
          gitStatusError: "Git unavailable",
        });
        return;
      }
      set({
        gitStatus: null,
        gitStatusLoading: false,
        gitStatusError: e instanceof ApiRequestError ? e.message : "Failed to load git status",
      });
    }
  },

  requestOpenFolderDialog: () => set({ openFolderDialogRequested: true }),
  clearOpenFolderDialogRequest: () => set({ openFolderDialogRequested: false }),

  refreshProviders: async () => {
    try {
      const data = await apiGet<{ providers: ProviderInfo[] }>("/api/providers");
      set({ providers: data?.providers ?? [] });
    } catch (e) {
      console.error("[store] refreshProviders failed:", e);
    }
  },

  refreshProviderKeys: async () => {
    try {
      const data = await apiGet<{ keys: ProviderKeyDTO[] }>("/api/providers/keys");
      set({ providerKeys: data?.keys ?? [] });
    } catch {
      // ignore
    }
  },

  refreshConversations: async () => {
    set({ loadingConversations: true });
    try {
      const data = await apiGet<{ conversations: ConversationDTO[] }>("/api/conversations");
      const convs = data?.conversations ?? [];
      const runningPatch: Record<string, { isStreaming: boolean; streamingMessageId: string | null }> = {};
      for (const c of convs) {
        if (c.isAgentRunning) {
          runningPatch[c.id] = {
            isStreaming: true,
            streamingMessageId: get().streamingStateByConversation[c.id]?.streamingMessageId ?? null,
          };
        }
      }
      set((s) => ({
        conversations: convs,
        loadingConversations: false,
        streamingStateByConversation: {
          ...s.streamingStateByConversation,
          ...runningPatch,
        },
        isStreaming: s.activeConversationId && runningPatch[s.activeConversationId] ? true : s.isStreaming,
      }));
    } catch {
      set({ loadingConversations: false });
    }
  },

  refreshMessages: async (conversationId: string) => {
    if (get().activeConversationId === conversationId) {
      set({ loadingMessages: true });
    }
    try {
      // The backend returns the full conversation with messages embedded.
      const data = await apiGet<{ conversation: ConversationDTO }>(
        `/api/conversations/${encodeURIComponent(conversationId)}`,
      );
      const isRunning = data?.conversation?.isAgentRunning ?? false;
      const curStreamingState = get().streamingStateByConversation[conversationId];
      if (isRunning && !curStreamingState?.isStreaming) {
        get().setStreaming(true, conversationId);
      } else if (!isRunning && curStreamingState?.isStreaming) {
        get().setStreaming(false, conversationId);
      }
      const list = (data?.conversation?.messages ?? []).filter(
        (m) => m.role !== "tool",
      );
      // Restore assistant live tool calls from persisted data
      const withToolCalls = list.map((m) => {
        const msg: UIMessage = { ...m, streaming: false };
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          msg.liveToolCalls = m.toolCalls.map((tc: any) => {
            let parsedArgs = tc.args;
            let argsStr = "";
            if (typeof tc.args === "string") {
              argsStr = tc.args;
              try {
                parsedArgs = JSON.parse(tc.args);
              } catch {
                parsedArgs = {};
              }
            } else if (tc.args && typeof tc.args === "object") {
              parsedArgs = tc.args;
              argsStr = JSON.stringify(tc.args);
            } else {
              argsStr = JSON.stringify(tc.args ?? {});
              parsedArgs = tc.args ?? {};
            }
            return {
              id: tc.id || `tc-${Math.random()}`,
              name: tc.name,
              args: argsStr,
              parsedArgs,
              status: (tc.status || "done") as any,
              result: tc.result,
            };
          });
        }
        return msg;
      });

      set((s) => {
        const existing = s.messagesByConversation[conversationId] ?? (conversationId === s.activeConversationId ? s.messages : []);
        const seen = new Set<string>();
        const merged: UIMessage[] = [];

        const localByServerId = new Map(existing.map((e) => [e.id, e]));
        const matchedLocalIds = new Set<string>();

        const localAssistantMsgs = existing.filter((e) => e.role === "assistant" && e.liveToolCalls?.length);

        for (const m of withToolCalls) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          let local = localByServerId.get(m.id);
          
          if (!local && m.role === "assistant") {
            // Match assistant message by matching tool call ID or position
            local = localAssistantMsgs.find(
              (l) => !matchedLocalIds.has(l.id) && l.liveToolCalls?.some((ltc) => m.toolCalls?.some((stc) => stc.id === ltc.id))
            );
          }

          if (local) {
            matchedLocalIds.add(local.id);
            // Merge liveToolCalls: preserve local liveToolCalls and their details/results
            let mergedTc: LiveToolCall[] = m.liveToolCalls || [];
            if (local.liveToolCalls && local.liveToolCalls.length > 0) {
              const localTcMap = new Map(local.liveToolCalls.map((t) => [t.id, t]));
              if (m.liveToolCalls && m.liveToolCalls.length > 0) {
                mergedTc = m.liveToolCalls.map((stc) => {
                  const ltc = localTcMap.get(stc.id);
                  return (ltc && ltc.result !== undefined)
                    ? ltc
                    : { ...stc, result: ltc?.result ?? stc.result, status: ltc?.status ?? stc.status };
                });
              } else {
                mergedTc = local.liveToolCalls;
              }
            }
            merged.push({
              ...m,
              streaming: local.streaming ?? false,
              segments: local.segments ?? m.segments,
              liveToolCalls: mergedTc.length > 0 ? mergedTc : (local.liveToolCalls ?? m.liveToolCalls),
            });
          } else if (m.role === "user") {
            // Match local user message by content to preserve local state
            const localUser = existing.find(
              (e) =>
                e.role === "user" &&
                e.content === m.content &&
                !matchedLocalIds.has(e.id),
            );
            if (localUser) {
              matchedLocalIds.add(localUser.id);
              // Use the server id for stable keying, but keep local state.
              merged.push({ ...localUser, id: m.id });
            } else {
              merged.push(m);
            }
          } else {
            merged.push(m);
          }
        }
        // Preserve local-only messages not yet persisted
        for (const local of existing) {
          if (!seen.has(local.id) && !matchedLocalIds.has(local.id)) {
            merged.push(local);
          }
        }
        const detectedArtifacts: string[] = [];
        for (const m of merged) {
          if (m.liveToolCalls && m.liveToolCalls.length > 0) {
            for (const tc of m.liveToolCalls) {
              const isArtifactCreateOrWrite = tc.name === "create_artifact" || tc.name === "write_file" || tc.name === "write_to_file";
              const isArtifactEdit = tc.name === "edit_file" || tc.name === "multi_edit";
              const r = typeof tc.result === "object" && tc.result ? (tc.result as Record<string, unknown>) : undefined;
              const pathVal = (r?.path ?? tc.parsedArgs?.path ?? tc.parsedArgs?.targetFile ?? tc.parsedArgs?.TargetFile ?? r?.targetFile ?? "") as string;
              const isArtifactEditHit = isArtifactEdit && r?.isArtifact === true && !!pathVal;
              if (
                (isArtifactCreateOrWrite && pathVal && (pathVal.endsWith(".md") || pathVal.endsWith(".markdown") || pathVal.includes("artifact") || pathVal.includes("implementation_plan") || pathVal.includes("walkthrough"))) ||
                isArtifactEditHit
              ) {
                detectedArtifacts.push(pathVal);
              }
            }
          }

        }

        const patch: Partial<AppState> = {
          messagesByConversation: {
            ...s.messagesByConversation,
            [conversationId]: merged,
          },
        };

        if (conversationId === s.activeConversationId) {
          patch.loadingMessages = false;
          patch.messages = merged;
          if (detectedArtifacts.length > 0) {
            const currentList = s.artifactsList ?? [];
            const combined = Array.from(new Set([...detectedArtifacts, ...currentList]));
            patch.artifactsList = combined;
            if (!s.activeArtifactPath) {
              patch.activeArtifactPath = detectedArtifacts[0];
            }
          }
        }

        return patch;
      });
    } catch {
      set((s) => ({
        ...(conversationId === s.activeConversationId ? { loadingMessages: false } : {}),
        messagesByConversation: {
          ...s.messagesByConversation,
          [conversationId]: s.messagesByConversation[conversationId] ?? (conversationId === s.activeConversationId ? s.messages : []),
        },
      }));
    }
  },

  refreshMcpServers: async () => {
    try {
      const data = await apiGet<{ servers: McpServerDTO[] }>("/api/mcp/servers");
      set({ mcpServers: data?.servers ?? [] });
    } catch (e) {
      console.error("[store] refreshMcpServers failed:", e);
    }
  },

  refreshPlugins: async () => {
    try {
      const data = await apiGet<{ plugins: PluginDTO[] }>("/api/plugins");
      // Filter plugins and exclude internal system rows
      set({ plugins: (data?.plugins ?? []).filter((p) => p.type === "plugin" && !p.name.startsWith("__")) });
    } catch (e) {
      console.error("[store] refreshPlugins failed:", e);
    }
  },

  refreshSkills: async () => {
    try {
      const data = await apiGet<{ skills: PluginDTO[] }>("/api/skills");
      set({ skills: data?.skills ?? [] });
    } catch (e) {
      console.error("[store] refreshSkills failed:", e);
    }
  },

  refreshPresets: async () => {
    try {
      const data = await apiGet<{ presets: AgentPresetDTO[] }>("/api/agents/presets");
      set({ agentPresets: data?.presets ?? [] });
    } catch (e) {
      console.error("[store] refreshPresets failed:", e);
    }
  },

  selectConversation: async (id: string) => {
    const prevId = get().activeConversationId;
    const prevDraft = get().composerDraft;

    // Cache previous conversation messages and streaming state
    if (prevId && prevId !== id) {
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [prevId]: s.messages,
        },
        streamingStateByConversation: {
          ...s.streamingStateByConversation,
          [prevId]: {
            isStreaming: s.isStreaming,
            streamingMessageId: s.streamingMessageId,
          },
        },
      }));
    }

    // Stash the unsent draft under the conversation being left so it can be
    // restored when the user returns to it.
    if (prevId !== id) {
      set((s) => {
        const drafts = { ...s.composerDrafts, [prevId ?? FRESH_DRAFT_KEY]: prevDraft };
        return { composerDrafts: drafts };
      });
      saveComposerDrafts(get().composerDrafts);
    }

    // Pending conversations have no DB row — restore their draft locally and
    // skip every server round-trip.
    if (isPendingConversationId(id)) {
      const targetWsId = get().pendingConversations.find((p) => p.id === id)?.workspaceId;
      if (targetWsId && targetWsId !== get().selectedProjectId) {
        await get().switchWorkspace(targetWsId, undefined, { skipAutoSelectConversation: true });
      }
      // Adopt text typed while no conversation existed at all, so clicking
      // "New conversation" after typing in a fresh session brings the text back.
      let draft = get().composerDrafts[id] ?? "";
      if (!draft.trim()) {
        const adoptFresh = get().pendingConversations.find((p) => p.id === id)?.adoptFresh;
        if (adoptFresh !== false) {
          const fresh = get().composerDrafts[FRESH_DRAFT_KEY] ?? "";
          if (fresh.trim()) {
            draft = fresh;
            set((s) => {
              const { [FRESH_DRAFT_KEY]: _f, ...rest } = s.composerDrafts;
              return { composerDrafts: rest };
            });
            saveComposerDrafts(get().composerDrafts);
          }
        }
      }
      set({
        activeConversationId: id,
        contextTrimmed: null,
        preTurnCheckpointId: null,
        activeSubagentId: null,
        rateLimitRetry: null,
        editingMessageId: null,
        messages: [],
        isStreaming: false,
        streamingMessageId: null,
        composerDraft: draft,
      });
      return;
    }

    // Switch project if target conversation belongs to a different workspace
    const targetConv = get().conversations.find((c) => c.id === id);
    const targetWsId = targetConv?.workspaceId;
    if (targetWsId && targetWsId !== get().selectedProjectId) {
      await get().switchWorkspace(targetWsId, undefined, { skipAutoSelectConversation: true });
    }

    set({ activeConversationId: id });
    // Reset conversation-scoped transient state
    set({
      contextTrimmed: null,
      preTurnCheckpointId: null,
      activeSubagentId: null,
      rateLimitRetry: null,
      editingMessageId: null,
    });

    const cached = get().messagesByConversation[id];
    const streamingState = get().streamingStateByConversation[id];
    set({
      messages: cached ?? [],
      isStreaming: streamingState?.isStreaming ?? false,
      streamingMessageId: streamingState?.streamingMessageId ?? null,
      composerDraft: get().composerDrafts[id] ?? "",
      permissionPrompt: get().permissionPromptsByConversation[id] ?? null,
      questionPrompt: get().questionPromptsByConversation[id] ?? null,
    });

    // Dismiss any active toast notifications for this conversation since the user has now focused it
    const activePerm = get().permissionPromptsByConversation[id];
    if (activePerm?.id && typeof toast?.dismiss === "function") {
      toast.dismiss(`perm-${activePerm.id}`);
    }
    const activeQuest = get().questionPromptsByConversation[id];
    if (activeQuest?.id && typeof toast?.dismiss === "function") {
      toast.dismiss(`quest-${activeQuest.id}`);
    }

    // Always refresh from server in background for up-to-date data
    void get().refreshMessages(id);
    get().syncSelectionFromActive();
    void get().refreshCheckpoints(id);
    void get().refreshSubagents(id);
    // Recover a pending agent question (e.g. after a page refresh) so the
    // answer can still be submitted before the server-side TTL expires.
    void get().recoverQuestionPrompt(id);
    void get().recoverPermissionPrompt(id);
  },

  syncSelectionFromActive: () => {
    const { conversations, activeConversationId } = get();
    const c = conversations.find((x) => x.id === activeConversationId);
    if (!c) return;
    const tl = get().thinkingLevel ?? "default";
    set({
      selectedProvider: c.provider,
      selectedModel: c.model,
      composerMode: c.mode,
      systemPrompt: c.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      thinkingLevel: tl,
    });
  },

  createConversation: async (opts) => {
    try {
      const wsId = opts?.workspaceId ?? get().selectedProjectId ?? get().activeWorkspace?.id ?? undefined;
      // Lazy creation (opencode-style sessions): "New conversation" never
      // writes a DB row. Reuse an existing pending conversation for the
      // workspace so repeated clicks return to the same chat — preserving any
      // unsent draft — instead of accumulating empty conversations.
      if (!opts?.preset && !opts?.title) {
        const reusable = get().pendingConversations.find(
          (p) => (p.workspaceId ?? undefined) === wsId,
        );
        if (reusable) {
          await get().selectConversation(reusable.id);
          return reusable;
        }
      }
      const now = new Date().toISOString();
      const pending: PendingConversation = {
        id: `${PENDING_CONVERSATION_PREFIX}${crypto.randomUUID()}`,
        title: opts?.title ?? "New conversation",
        provider: opts?.provider ?? get().selectedProvider,
        model: opts?.model ?? get().selectedModel,
        mode: opts?.mode ?? get().composerMode,
        systemPrompt: opts?.systemPrompt ?? get().systemPrompt,
        pinned: false,
        workspaceId: wsId ?? null,
        createdAt: now,
        updatedAt: now,
        createOpts: opts ? { ...opts } : undefined,
        // Plain "New conversation" adopts a draft typed in the fresh state;
        // titled/preset creations start clean.
        adoptFresh: !opts?.title && !opts?.preset,
      };
      set((s) => ({ pendingConversations: [pending, ...s.pendingConversations] }));
      savePendingConversations(get().pendingConversations);
      await get().selectConversation(pending.id);
      return pending;
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Failed to create conversation";
      set({ streamError: msg });
      return null;
    }
  },

  ensureRealConversation: async (conversationId) => {
    const id = conversationId ?? get().activeConversationId;
    if (!id) return null;
    // Already persisted — nothing to do.
    if (!isPendingConversationId(id)) return id;
    const inflight = ensureRealConversationInFlight.get(id);
    if (inflight) return inflight;
    const exec = (async () => {
      try {
        const pending = get().pendingConversations.find((p) => p.id === id);
        if (!pending) {
          // Cross-tab race: another tab may have materialized this pending chat.
          // Refresh conversations and fall back to an existing real row for this workspace.
          try {
            await get().refreshConversations();
          } catch {}
          const wsId = get().selectedProjectId ?? get().activeWorkspace?.id ?? undefined;
          const convs = get().conversations;
          const fallback =
            (wsId ? convs.find((c) => c.workspaceId === wsId) : undefined) ?? convs[0] ?? null;
          if (fallback) {
            const isActive = get().activeConversationId === id;
            set((s) => {
              const { [id]: _d, ...restDrafts } = s.composerDrafts;
              return {
                pendingConversations: s.pendingConversations.filter((p) => p.id !== id),
                activeConversationId: isActive ? fallback.id : s.activeConversationId,
                composerDrafts: restDrafts,
              };
            });
            savePendingConversations(get().pendingConversations);
            saveComposerDrafts(get().composerDrafts);
            if (isActive) {
              void get().refreshMessages(fallback.id);
            }
            broadcastTabSync("refresh_conversations");
            return fallback.id;
          }
          return null;
        }
        const opts = pending.createOpts;
        const body: Record<string, unknown> = {
          title: opts?.title ?? pending.title ?? "New conversation",
          provider: opts?.provider ?? pending.provider,
          model: opts?.model ?? pending.model,
          mode: opts?.mode ?? pending.mode,
          systemPrompt: opts?.systemPrompt ?? pending.systemPrompt,
          workspaceId:
            opts?.workspaceId ??
            pending.workspaceId ??
            get().selectedProjectId ??
            get().activeWorkspace?.id ??
            undefined,
        };
        if (opts?.preset) {
          body.provider = opts.preset.provider;
          body.model = opts.preset.model;
          body.systemPrompt = opts.preset.systemPrompt;
          body.mode = "agent";
          if (opts.preset.tools) body.enabledTools = opts.preset.tools;
        }
        const res = await apiPost<{ conversation: ConversationDTO }>("/api/conversations", body);
        const created = res.conversation;
        set((s) => {
          const isActive = s.activeConversationId === id;
          const { [id]: _d, ...restDrafts } = s.composerDrafts;
          return {
            conversations: [created, ...s.conversations],
            pendingConversations: s.pendingConversations.filter((p) => p.id !== id),
            activeConversationId: isActive ? created.id : s.activeConversationId,
            // First message clears the composer draft.
            composerDraft: isActive ? "" : s.composerDraft,
            composerDrafts: restDrafts,
            messages: isActive ? [] : s.messages,
          };
        });
        savePendingConversations(get().pendingConversations);
        saveComposerDrafts(get().composerDrafts);
        broadcastTabSync("refresh_conversations");
        return created.id;
      } catch (e) {
        const msg = e instanceof ApiRequestError ? e.message : "Failed to create conversation";
        set({ streamError: msg });
        return null;
      } finally {
        ensureRealConversationInFlight.delete(id);
      }
    })();
    ensureRealConversationInFlight.set(id, exec);
    return exec;
  },

  renameConversation: async (id, title) => {
    // Pending conversations aren't persisted — update the local placeholder only.
    if (isPendingConversationId(id)) {
      set((s) => ({
        pendingConversations: s.pendingConversations.map((c) =>
          c.id === id ? { ...c, title } : c,
        ),
      }));
      savePendingConversations(get().pendingConversations);
      return;
    }
    try {
      const res = await apiPatch<{ conversation: ConversationDTO }>(
        `/api/conversations/${encodeURIComponent(id)}`,
        { title },
      );
      const updated = res.conversation;
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
      }));
      broadcastTabSync("refresh_conversations");
    } catch {
      // ignore
    }
  },

  togglePin: async (id) => {
    if (isPendingConversationId(id)) return; // nothing persisted to pin
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    try {
      const res = await apiPatch<{ conversation: ConversationDTO }>(
        `/api/conversations/${encodeURIComponent(id)}`,
        { pinned: !conv.pinned },
      );
      const updated = res.conversation;
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
      broadcastTabSync("refresh_conversations");
    } catch {
      // ignore
    }
  },

  deleteConversation: async (id) => {
    // Pending conversations have no DB row — just drop the local placeholder.
    if (isPendingConversationId(id)) {
      set((s) => {
        const isActive = s.activeConversationId === id;
        const { [id]: _d, ...restDrafts } = s.composerDrafts;
        return {
          pendingConversations: s.pendingConversations.filter((p) => p.id !== id),
          activeConversationId: isActive ? null : s.activeConversationId,
          messages: isActive ? [] : s.messages,
          composerDrafts: restDrafts,
        };
      });
      savePendingConversations(get().pendingConversations);
      saveComposerDrafts(get().composerDrafts);
      return;
    }
    try {
      await apiDelete(`/api/conversations/${encodeURIComponent(id)}`);
      set((s) => {
        const { [id]: _m, ...restMessages } = s.messagesByConversation;
        const { [id]: _ss, ...restStreaming } = s.streamingStateByConversation;
        const { [id]: _td, ...restTodos } = s.activeTodosByConversation;
        const { [id]: _th, ...restThinking } = s.thinkingExpanded;
        const { [id]: _sc, ...restScroll } = s.scrollPositions;
        const { [id]: _cd, ...restDrafts } = s.composerDrafts;
        const { [id]: _pp, ...restPerms } = s.permissionPromptsByConversation;
        const { [id]: _qp, ...restQuests } = s.questionPromptsByConversation;
        const isActive = s.activeConversationId === id;
        return {
          conversations: s.conversations.filter((c) => c.id !== id),
          activeConversationId: isActive ? null : s.activeConversationId,
          messages: isActive ? [] : s.messages,
          checkpoints: isActive ? [] : s.checkpoints,
          subagents: isActive ? [] : s.subagents,
          questionPrompt: isActive ? null : s.questionPrompt,
          permissionPrompt: isActive ? null : s.permissionPrompt,
          permissionPromptsByConversation: restPerms,
          questionPromptsByConversation: restQuests,
          messagesByConversation: restMessages,
          streamingStateByConversation: restStreaming,
          activeTodosByConversation: restTodos,
          thinkingExpanded: restThinking,
          scrollPositions: restScroll,
          composerDrafts: restDrafts,
        };
      });
      broadcastTabSync("refresh_conversations");
    } catch {
      // ignore
    }
  },

  appendAssistantPlaceholder: (messageId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      // Dedup against active and cached messages
      if (msgs.some((m) => m.id === messageId)) return s;
      if (convId === s.activeConversationId && s.messages.some((m) => m.id === messageId)) {
        return s;
      }
      const placeholder: UIMessage = {
        id: messageId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        streaming: true,
        liveToolCalls: [],
        segments: [],
      };
      const updated = [...msgs, placeholder];
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendUserMessage: (msg, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      // Dedup user messages by ID
      if (msgs.some((m) => m.id === msg.id)) return s;

      const updated = [...msgs, { ...msg, streaming: false }];
      updated.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendDelta: (messageId, delta, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      let nextContent = msgs[idx].content + delta;
      if (nextContent.length > MAX_SEGMENT_CHARS) {
        nextContent = "...[truncated]\n" + nextContent.slice(-MAX_SEGMENT_CHARS);
      }
      const updatedMsg = { ...msgs[idx], content: nextContent };
      const updated = msgs.slice();
      updated[idx] = updatedMsg;
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch as Partial<AppState>;
    });
  },

  setThinking: (messageId, content, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const updated = msgs.map((m) =>
        m.id === messageId
          ? { ...m, thinking: (m.thinking ?? "") + content }
          : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  resetThinking: (messageId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return s;
      const segments = (msg.segments ?? []).slice();
      const tail = segments[segments.length - 1];
      if (tail && tail.kind === "thinking") segments.pop();
      const updated = msgs.map((m) =>
        m.id === messageId ? { ...m, thinking: "", segments } : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  startToolCall: (toolCallId, name, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const streamingId = s.streamingStateByConversation[convId]?.streamingMessageId ?? s.streamingMessageId;
      if (!streamingId) return s;
      const updated = msgs.map((m) => {
        if (m.id !== streamingId) return m;
        const existing = m.liveToolCalls ?? [];
        if (existing.some((t) => t.id === toolCallId)) return m;
        const live: LiveToolCall = {
          id: toolCallId,
          name,
          args: "",
          status: "running",
        };
        return { ...m, liveToolCalls: [...existing, live] };
      });
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendToolCallArgs: (toolCallId, delta, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const streamingId = s.streamingStateByConversation[convId]?.streamingMessageId ?? s.streamingMessageId;
      if (!streamingId) return s;
      const updated = msgs.map((m) => {
        if (m.id !== streamingId) return m;
        const calls = (m.liveToolCalls ?? []).map((t) => {
          if (t.id === toolCallId) {
            const nextArgs = t.args + delta;
            return {
              ...t,
              args: nextArgs,
              parsedArgs: safeParseArgs(nextArgs),
            };
          }
          return t;
        });
        return { ...m, liveToolCalls: calls };
      });
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  finishToolCall: (toolCallId, result, ok, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const streamingId = s.streamingStateByConversation[convId]?.streamingMessageId ?? s.streamingMessageId;
      if (!streamingId) return s;

      let detectedArtifactPath: string | null = null;
      let detectedTodos: any[] | null = null;
      let detectedTodosCompleted = false;
      let detectedTodoClear = false;
      const updated = msgs.map((m) => {
        if (m.id !== streamingId) return m;
        const calls = (m.liveToolCalls ?? []).map((t) => {
          if (t.id !== toolCallId) return t;
          const parsed = safeParseArgs(t.args);
          const r = typeof result === "object" && result ? (result as Record<string, unknown>) : undefined;
          const filePath = (r?.path ?? parsed?.path ?? parsed?.TargetFile ?? r?.targetFile ?? "") as string;
          const isArtifactCreateOrWrite = t.name === "create_artifact" || t.name === "write_file" || t.name === "write_to_file";
          const isArtifactEditHit = (t.name === "edit_file" || t.name === "multi_edit") && r?.isArtifact === true && !!filePath;
          if (ok && ((isArtifactCreateOrWrite && filePath && (filePath.endsWith(".md") || filePath.endsWith(".markdown") || filePath.includes("artifact") || filePath.includes("implementation_plan") || filePath.includes("walkthrough"))) || isArtifactEditHit)) {
            detectedArtifactPath = filePath;
          }
          if (ok && t.name === "todo_clear") {
            detectedTodoClear = true;
          }
          if (ok && r?.todos && Array.isArray(r.todos)) {
            detectedTodos = r.todos as any[];
            const list = r.todos as any[];
            detectedTodosCompleted =
              list.length > 0 && list.every((t) => t.status === "completed");
          }
          return {
            ...t,
            result,
            ok,
            status: ok ? ("done" as const) : ("error" as const),
            parsedArgs: parsed,
          };
        });
        return { ...m, liveToolCalls: calls };
      });
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      if (detectedArtifactPath) {
        patch.artifactsList = Array.from(new Set([detectedArtifactPath, ...(s.artifactsList ?? [])]));
        if (convId === s.activeConversationId) {
          patch.activeArtifactPath = detectedArtifactPath;
          patch.rightPanelTab = "artifacts";
          patch.rightPanelOpen = true;
        }
      }
      if (detectedTodos) {
        if (detectedTodosCompleted) {
          // Clear completed todos matching backend auto-clear behavior
          const cleared = { ...(s.activeTodosByConversation ?? {}) };
          delete cleared[convId];
          patch.activeTodosByConversation = cleared;
        } else {
          patch.activeTodosByConversation = {
            ...(s.activeTodosByConversation ?? {}),
            [convId]: detectedTodos,
          };
        }
      } else if (detectedTodoClear) {
        const rested = { ...(s.activeTodosByConversation ?? {}) };
        delete rested[convId];
        patch.activeTodosByConversation = rested;
      }
      return patch;
    });
  },

  endToolCall: (toolCallId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const streamingId = s.streamingStateByConversation[convId]?.streamingMessageId ?? s.streamingMessageId;
      if (!streamingId) return s;
      const updated = msgs.map((m) => {
        if (m.id !== streamingId) return m;
        const calls = (m.liveToolCalls ?? []).map((t) =>
          t.id === toolCallId
            ? {
                ...t,
                status: t.status === "running" ? ("done" as const) : t.status,
                parsedArgs: t.parsedArgs ?? safeParseArgs(t.args),
              }
            : t,
        );
        return { ...m, liveToolCalls: calls };
      });
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendCommandOutput: (toolCallId, text, running, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const streamingId = s.streamingStateByConversation[convId]?.streamingMessageId ?? s.streamingMessageId;
      if (!streamingId) return s;
      const updated = msgs.map((m) => {
        if (m.id !== streamingId) return m;
        const calls = (m.liveToolCalls ?? []).map((t) => {
          if (t.id !== toolCallId) return t;
          const next = (t.liveOutput ?? "") + text;
          // Incremental cap: drop oldest content beyond threshold to prevent
          // unbounded buffering from long dev-server runs.
          const capped = next.length > MAX_LIVE_OUTPUT_CHARS
            ? "...[truncated]\n" + next.slice(-MAX_LIVE_OUTPUT_CHARS)
            : next;
          return { ...t, liveOutput: capped };
        });
        const finalCalls = !running
          ? calls.map((t) =>
              t.id === toolCallId && t.status === "running"
                ? { ...t, status: "done" as const }
                : t,
            )
          : calls;
        return { ...m, liveToolCalls: finalCalls };
      });
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  /* Segment-aware streaming: maintains interleaved thinking, text, and tool call segments in message state. */

  appendSegmentText: (messageId, delta, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return s;
      const segments = (msg.segments ?? []).slice();
      const tail = segments[segments.length - 1];
      if (tail && tail.kind === "text") {
        let next = tail.content + delta;
        if (next.length > MAX_SEGMENT_CHARS) next = "...[truncated]\n" + next.slice(-MAX_SEGMENT_CHARS);
        segments[segments.length - 1] = { kind: "text", id: tail.id, content: next };
      } else {
        let content = delta;
        if (content.length > MAX_SEGMENT_CHARS) content = content.slice(-MAX_SEGMENT_CHARS);
        segments.push({ kind: "text", id: `seg-${Math.random().toString(36).slice(2, 10)}`, content });
      }
      let nextContent = (msg.content ?? "") + delta;
      if (nextContent.length > MAX_SEGMENT_CHARS) nextContent = "...[truncated]\n" + nextContent.slice(-MAX_SEGMENT_CHARS);
      const updated = msgs.map((m) =>
        m.id === messageId ? { ...m, segments, content: nextContent, streaming: true } : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendSegmentThinking: (messageId, delta, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return s;
      const segments = (msg.segments ?? []).slice();
      const tail = segments[segments.length - 1];
      if (tail && tail.kind === "thinking") {
        let next = tail.content + delta;
        if (next.length > MAX_SEGMENT_CHARS) next = "...[truncated]\n" + next.slice(-MAX_SEGMENT_CHARS);
        segments[segments.length - 1] = { kind: "thinking", id: tail.id, content: next };
      } else {
        let content = delta;
        if (content.length > MAX_SEGMENT_CHARS) content = content.slice(-MAX_SEGMENT_CHARS);
        segments.push({ kind: "thinking", id: `seg-${Math.random().toString(36).slice(2, 10)}`, content });
      }
      let nextThinking = (msg.thinking ?? "") + delta;
      if (nextThinking.length > MAX_SEGMENT_CHARS) nextThinking = "...[truncated]\n" + nextThinking.slice(-MAX_SEGMENT_CHARS);
      const updated = msgs.map((m) => (m.id === messageId ? { ...m, segments, thinking: nextThinking } : m));
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  pushSegmentToolCall: (messageId, toolCallId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return s;
      const segments = (msg.segments ?? []).slice();
      // Don't double-push the same tool call.
      if (segments.some((seg) => seg.kind === "tool_call" && seg.toolCallId === toolCallId)) {
        return s;
      }
      segments.push({
        kind: "tool_call",
        id: `seg-${Math.random().toString(36).slice(2, 10)}`,
        toolCallId,
      });
      const updated = msgs.map((m) => (m.id === messageId ? { ...m, segments } : m));
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  applyUsage: (
      messageId,
      tokensIn,
      tokensOut,
      model,
      provider,
      conversationId?,
      promptTokens?,
      cacheWrites?,
      cacheReads?,
      estimated?,
    ) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const updated = msgs.map((m) =>
        m.id === messageId
          ? { ...m, tokensIn, tokensOut, promptTokens, cacheWrites, cacheReads, model, provider, promptTokensEstimated: estimated ?? false }
          : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      // Keep contextTrimmed set to preserve badge visibility
      return patch;
    });
  },

  clearMessageUsage: (messageId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const updated = msgs.map((m) =>
        m.id === messageId
          ? {
              ...m,
              tokensIn: undefined,
              tokensOut: undefined,
              promptTokens: undefined,
              cacheWrites: undefined,
              cacheReads: undefined,
              latencyMs: undefined,
              provider: undefined,
            }
          : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  finalizeStreamingMessage: (messageId, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      const updated = msgs.map((m) =>
        m.id === messageId
          ? {
              ...m,
              streaming: false,
              toolCalls: (m.liveToolCalls ?? []).map((t) => ({
                id: t.id,
                name: t.name,
                args: t.parsedArgs ?? safeParseArgs(t.args) ?? {},
              })) as ToolCall[],
            }
          : m,
      );
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  appendAssistantError: (messageId, message, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const msgs = s.messagesByConversation[convId] ?? (convId === s.activeConversationId ? s.messages : []);
      if (msgs.some((m) => m.id === messageId)) {
        const updated = msgs.map((m) =>
          m.id === messageId
            ? { ...m, error: message, streaming: false }
            : m,
        );
        const patch: Partial<AppState> = {
          messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
        };
        if (convId === s.activeConversationId) patch.messages = updated;
        return patch;
      }
      const err: UIMessage = {
        id: messageId,
        role: "assistant",
        content: "",
        error: message,
        streaming: false,
        createdAt: new Date().toISOString(),
      };
      const updated = [...msgs, err];
      const patch: Partial<AppState> = {
        messagesByConversation: { ...s.messagesByConversation, [convId]: updated },
      };
      if (convId === s.activeConversationId) patch.messages = updated;
      return patch;
    });
  },

  markQueuedAnswered: (conversationId, ids) => {
    if (!ids || ids.length === 0) return;
    set((s) => ({
      queuedAnsweredByConversation: {
        ...s.queuedAnsweredByConversation,
        [conversationId]: [...(s.queuedAnsweredByConversation[conversationId] ?? []), ...ids],
      },
    }));
  },

  clearQueuedAnswered: (conversationId) => {
    set((s) => ({
      queuedAnsweredByConversation: {
        ...s.queuedAnsweredByConversation,
        [conversationId]: [],
      },
    }));
  },

  setStreaming: (v, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const patch: Partial<AppState> = {
        streamingStateByConversation: {
          ...s.streamingStateByConversation,
          [convId]: { ...s.streamingStateByConversation[convId], isStreaming: v },
        },
      };
      // Resync global streaming flag with active conversation
      patch.isStreaming =
        convId === s.activeConversationId
          ? v
          : (s.streamingStateByConversation[s.activeConversationId ?? ""]?.isStreaming ?? false);
      return patch;
    });
  },
  setStreamingMessageId: (id, conversationId?) => {
    set((s) => {
      const convId = conversationId ?? s.activeConversationId ?? "";
      const patch: Partial<AppState> = {
        streamingStateByConversation: {
          ...s.streamingStateByConversation,
          [convId]: { ...s.streamingStateByConversation[convId], streamingMessageId: id },
        },
      };
      if (convId === s.activeConversationId) patch.streamingMessageId = id;
      else patch.streamingMessageId =
        s.streamingStateByConversation[s.activeConversationId ?? ""]?.streamingMessageId ?? null;
      return patch;
    });
  },
  setStreamError: (e) => set({ streamError: e }),
  setRateLimitRetry: (data) => set({ rateLimitRetry: data }),

  setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
  setRightPanelTab: (t) => set({ rightPanelTab: t, rightPanelOpen: true }),
  setActiveArtifactPath: (path) => set({ activeArtifactPath: path }),
  setArtifactsList: (paths) => {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of paths) {
      if (!p) continue;
      const key = p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || p;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }
    set({ artifactsList: unique });
  },
  addArtifact: (path) =>
    set((s) => {
      const key = (path ?? "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || path;
      const filtered = s.artifactsList.filter((p) => {
        const k = p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || p;
        return k !== key;
      });
      return {
        artifactsList: [path, ...filtered],
        activeArtifactPath: path,
        rightPanelTab: "artifacts",
        rightPanelOpen: true,
      };
    }),
  removeArtifact: (path) =>
    set((s) => {
      const targetKey = (path ?? "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || path;
      const nextList = s.artifactsList.filter((p) => {
        const k = p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || p;
        return k !== targetKey;
      });
      const activeKey = (s.activeArtifactPath ?? "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();
      const nextActive =
        activeKey === targetKey
          ? nextList.length > 0
            ? nextList[0]
            : null
          : s.activeArtifactPath;
      return {
        artifactsList: nextList,
        activeArtifactPath: nextActive,
      };
    }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  selectProject: async (id) => {
    if (!id) {
      // Deselect project — keep current workspace but stop filtering.
      set({ selectedProjectId: null });
      return;
    }
    // switchWorkspace now sets selectedProjectId, saves/restores file tabs,
    // clears old conversations, and auto-creates a new one.
    await get().switchWorkspace(id);
  },
  toggleProjectCollapse: (id) =>
    set((s) => ({
      collapsedProjects: s.collapsedProjects.includes(id)
        ? s.collapsedProjects.filter((x) => x !== id)
        : [...s.collapsedProjects, id],
    })),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettingsTab: (t) => set({ settingsTab: t, settingsOpen: true }),
  setCommandOpen: (v) => set({ commandOpen: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  toggleShortcutsOpen: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
  setFindInFilesOpen: (v) => set({ findInFilesOpen: v }),
  toggleFindInFilesOpen: () => set((s) => ({ findInFilesOpen: !s.findInFilesOpen })),

  openFileTab: (path) =>
    set((s) => {
      if (s.openFiles.includes(path)) {
        return { activeFileTab: path };
      }
      // Cap at MAX_OPEN_TABS — evict the oldest non-active tab (LRU).
      let next = s.openFiles.slice();
      if (next.length >= MAX_OPEN_TABS) {
        const victimIdx = next.findIndex(
          (p) => p !== s.activeFileTab && p !== s.splitEditorFile,
        );
        if (victimIdx >= 0) {
          next.splice(victimIdx, 1);
        } else {
          // All tabs are active (impossible since activeFileTab is one path)
          // — fall back to dropping the first one.
          next = next.slice(1);
        }
      }
      next.push(path);
      return { openFiles: next, activeFileTab: path };
    }),

  closeFileTab: (path) =>
    set((s) => {
      if (!s.openFiles.includes(path)) {
        // If the closed tab was somehow active, drop it too.
        return s.activeFileTab === path ? { activeFileTab: null } : s;
      }
      const next = s.openFiles.filter((p) => p !== path);
      // Focus adjacent tab when active tab is closed
      let nextActive = s.activeFileTab;
      if (s.activeFileTab === path) {
        if (next.length === 0) {
          nextActive = null;
        } else {
          const closedIdx = s.openFiles.indexOf(path);
          const clampIdx = Math.min(closedIdx, next.length - 1);
          nextActive = next[clampIdx] ?? next[0] ?? null;
        }
      }
      // Close split editor if split file tab was closed
      if (s.splitEditorFile === path) {
        return {
          openFiles: next,
          activeFileTab: nextActive,
          splitEditorOpen: false,
          splitEditorFile: null,
          splitEditorActive: "left",
        };
      }
      return { openFiles: next, activeFileTab: nextActive };
    }),

  setActiveFileTab: (path) =>
    set((s) => {
      if (!s.openFiles.includes(path)) return s;
      return { activeFileTab: path };
    }),

  closeAllFileTabs: () =>
    set({
      openFiles: [],
      openFilesByProject: {},
      activeFileTab: null,
      activeFileTabByProject: {},
      splitEditorOpen: false,
      splitEditorFile: null,
      splitEditorActive: "left",
    }),

  setFileWatchEnabled: (v) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(FILE_WATCH_KEY, v ? "1" : "0");
      }
    } catch {
      // ignore quota / private mode errors
    }
    set({ fileWatchEnabled: v });
  },
  toggleFileWatchEnabled: () => {
    const next = !get().fileWatchEnabled;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(FILE_WATCH_KEY, next ? "1" : "0");
      }
    } catch {
      // ignore
    }
    set({ fileWatchEnabled: next });
  },
  setFileWatchConnected: (v) => set({ fileWatchConnected: v }),

  setDensity: (d) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(DENSITY_KEY, d);
      }
    } catch { /* ignore */ }
    set({ density: d });
  },
  setFontSize: (s) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(FONT_SIZE_KEY, String(s));
      }
    } catch { /* ignore */ }
    set({ fontSize: s });
  },
  setContextConfig: (cfg) => {
    const next = { ...get().contextConfig, ...cfg };
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CONTEXT_CONFIG_KEY, JSON.stringify(next));
      }
    } catch { /* ignore */ }
    set({ contextConfig: next });
  },
  setSecuritySettings: (cfg) => {
    const next = { ...get().securitySettings, ...cfg };
    set({ securitySettings: next });
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SECURITY_SETTINGS_KEY, JSON.stringify(next));
      }
    } catch { /* ignore */ }
    // Persist settings to server with rollback on failure
    apiPatch<{ settings: SecuritySettings }>("/api/security/settings", cfg).catch(() => {
      void get().refreshSecuritySettings();
    });
  },

  refreshSecuritySettings: async () => {
    try {
      const data = await apiGet<{ settings: SecuritySettings }>("/api/security/settings");
      if (data?.settings) {
        set({ securitySettings: data.settings });
        try {
          if (typeof window !== "undefined") {
            window.localStorage.setItem(SECURITY_SETTINGS_KEY, JSON.stringify(data.settings));
          }
        } catch { /* ignore */ }
      }
    } catch {
      /* keep local cache when the server is unreachable */
    }
  },

  setSplitEditorOpen: (v) => {
    if (v) {
      // Opening the split: keep the current activeFileTab on the left,
      // clear any previous right-side file, default focus to the left.
      set({ splitEditorOpen: true, splitEditorFile: null, splitEditorActive: "left" });
    } else {
      // Closing the split: drop the right-side file and reset focus.
      set({ splitEditorOpen: false, splitEditorFile: null, splitEditorActive: "left" });
    }
  },
  toggleSplitEditor: () => {
    const next = !get().splitEditorOpen;
    if (next) {
      set({ splitEditorOpen: true, splitEditorFile: null, splitEditorActive: "left" });
    } else {
      set({ splitEditorOpen: false, splitEditorFile: null, splitEditorActive: "left" });
    }
  },
  setSplitEditorFile: (path) => {
    if (path === null) {
      set({ splitEditorFile: null });
      return;
    }
    // Push the path into openFiles (without making it the active tab)
    // so it appears in the tab bar with an "R" badge.
    set((s) => {
      if (s.openFiles.includes(path)) {
        return { splitEditorFile: path };
      }
      // Cap at MAX_OPEN_TABS — evict the oldest non-active, non-split tab.
      let next = s.openFiles.slice();
      if (next.length >= MAX_OPEN_TABS) {
        const victimIdx = next.findIndex(
          (p) => p !== s.activeFileTab && p !== s.splitEditorFile,
        );
        if (victimIdx >= 0) {
          next.splice(victimIdx, 1);
        } else {
          next = next.slice(1);
        }
      }
      next.push(path);
      return { openFiles: next, splitEditorFile: path };
    });
  },
  setSplitEditorActive: (side) => set({ splitEditorActive: side }),

  setContextTrimmed: (info) => set({ contextTrimmed: info }),

  setPreTurnCheckpoint: (id) => set({ preTurnCheckpointId: id }),

  pushRecentCommand: (id) => {
    const next = [id, ...get().recentCommands.filter((x) => x !== id)].slice(0, MAX_RECENT_COMMANDS);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
      }
    } catch {
      // ignore quota / private mode errors
    }
    set({ recentCommands: next });
  },
  clearRecentCommands: () => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(RECENT_COMMANDS_KEY);
      }
    } catch {
      // ignore
    }
    set({ recentCommands: [] });
  },

  refreshCheckpoints: async (conversationId) => {
    set({ checkpointsLoading: true });
    try {
      const data = await apiGet<{ checkpoints?: Checkpoint[] }>(
        "/api/checkpoints",
        { query: { conversationId } },
      );
      const list = (data?.checkpoints ?? []).slice().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      set({ checkpoints: list, checkpointsLoading: false });

      // Sync preTurnCheckpointId to latest checkpoint
      if (list.length > 0) {
        const current = get().preTurnCheckpointId;
        if (!current || !list.some((cp) => cp.id === current)) {
          set({ preTurnCheckpointId: list[0].id });
        }
      } else {
        set({ preTurnCheckpointId: null });
      }
    } catch (e) {
      // Fall back to empty checkpoints on error
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        set({ checkpoints: [], checkpointsLoading: false });
        return;
      }
      set({ checkpoints: [], checkpointsLoading: false });
    }
  },

  createCheckpoint: async (conversationId, label, toolCallIds) => {
    set({ checkpointCreating: true });
    try {
      const body: Record<string, unknown> = { conversationId, label };
      if (toolCallIds && toolCallIds.length > 0) {
        body.toolCallIds = toolCallIds;
      }
      const res = await apiPost<{ checkpoint: Checkpoint }>("/api/checkpoints", body, {
        timeoutMs: 5 * 60_000,
      });
      const created = res.checkpoint;
      set((s) => ({ checkpoints: [created, ...s.checkpoints] }));
      return created;
    } catch (e) {
      console.error("[createCheckpoint] failed:", e);
      // Graceful null return on 404/405 or failure
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        return null;
      }
      return null;
    } finally {
      set({ checkpointCreating: false });
    }
  },

  /** Set subagents directly from SSE data (no API call). */
  setSubagents: (conversationId, list) => {
    if (get().subagentsConversationId === conversationId) {
      const sorted = list.slice().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      set({ subagents: sorted, subagentsLoading: false, subagentsError: null });
    }
  },

  setSubagentsForConversation: (conversationId, list) => {
    const sorted = list.slice().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    set({ subagents: sorted, subagentsConversationId: conversationId, subagentsLoading: false, subagentsError: null });
  },

  prepareSubagentsStream: (conversationId) => {
    set({ subagentsConversationId: conversationId, subagentsLoading: true, subagentsError: null });
  },

  clearSubagentsForPending: () => {
    set({ subagents: [], subagentsLoading: false, subagentsError: null });
  },

  refreshSubagents: async (conversationId) => {
    // Track target conversation to ignore stale responses
    set({ subagentsLoading: true, subagentsConversationId: conversationId });
    try {
      const data = await apiGet<{ subagents?: Subagent[] }>(
        "/api/agents/subagents",
        { query: { conversationId } },
      );
      const list = (data?.subagents ?? []).slice().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      // Only commit if we're still on the same conversation.
      if (get().subagentsConversationId === conversationId) {
        set({ subagents: list, subagentsLoading: false, subagentsError: null });
      }
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        if (get().subagentsConversationId === conversationId) {
          set({
            subagents: [],
            subagentsLoading: false,
            subagentsError: "Subagents unavailable",
          });
        }
        return;
      }
      // Suppress persistent error banner on transient 429
      if (e instanceof ApiRequestError && e.status === 429) {
        if (get().subagentsConversationId === conversationId) {
          set({ subagentsLoading: false });
        }
        return;
      }
      if (get().subagentsConversationId === conversationId) {
        set({
          subagentsLoading: false,
          subagentsError:
            e instanceof ApiRequestError ? e.message : "Failed to load subagents",
        });
      }
    }
  },

  createSubagent: async (conversationId, name, task, systemPrompt) => {
    try {
      const body: Record<string, unknown> = {
        conversationId,
        name: name.trim(),
        task: task.trim(),
      };
      if (systemPrompt && systemPrompt.trim()) {
        body.systemPrompt = systemPrompt.trim();
      }
      const res = await apiPost<{ subagent: Subagent }>(
        "/api/agents/subagents",
        body,
      );
      const created = res.subagent;
      set((s) => {
        // Only prepend if we're still on the same conversation.
        if (s.subagentsConversationId !== conversationId) return s;
        return { subagents: [created, ...s.subagents] };
      });
      return created;
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        throw new Error("Subagents unavailable");
      }
      throw e;
    }
  },

  deleteSubagent: async (id) => {
    // Optimistic removal so the UI feels instant.
    const prev = get().subagents;
    set((s) => ({ subagents: s.subagents.filter((x) => x.id !== id) }));
    try {
      await apiDelete(`/api/agents/subagents/${encodeURIComponent(id)}`);
    } catch (e) {
      set({ subagents: prev });
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        throw new Error("Subagents unavailable");
      }
      throw e;
    }
  },

  setActiveSubagentId: (id) => set({ activeSubagentId: id }),

  setOfficeGenerating: (generating, opts) =>
    set((s) => ({
      officeGenerating: generating,
      officeLastPath: opts?.path ?? (generating ? null : s.officeLastPath),
      officeLastType: opts?.type ?? (generating ? null : s.officeLastType),
    })),

  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setComposerMode: (m) => set({ composerMode: m }),
  setSelectedProvider: (p) => set({ selectedProvider: p }),
  setSelectedModel: (m) => set({ selectedModel: m }),
  applyChatModelSelection: async (p, m) => {
    set({ selectedProvider: p, selectedModel: m });
    const convId = get().activeConversationId;
    if (!convId) return;
    // Pending conversations aren't persisted — keep the local record in sync
    // so materialization stores the model the user actually selected.
    if (isPendingConversationId(convId)) {
      set((s) => ({
        pendingConversations: s.pendingConversations.map((c) =>
          c.id === convId ? { ...c, provider: p, model: m } : c,
        ),
      }));
      savePendingConversations(get().pendingConversations);
      return;
    }
    try {
      await apiPatch(`/api/conversations/${encodeURIComponent(convId)}`, {
        provider: p,
        model: m,
      });
      await get().refreshConversations();
    } catch {
      /* best-effort — the local selection stays for the next request */
    }
  },
  setSystemPrompt: (s) => set({ systemPrompt: s }),
  setEnabledTools: (t) => set({ enabledTools: t }),
  setComposerDraft: (s) => {
    set((st) => {
      const key = st.activeConversationId ?? FRESH_DRAFT_KEY;
      return {
        composerDraft: s,
        composerDrafts: { ...st.composerDrafts, [key]: s },
      };
    });
    saveComposerDrafts(get().composerDrafts);
  },
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setThinkingExpanded: (id, open) => {
    set((s) => ({
      thinkingExpanded: {
        ...s.thinkingExpanded,
        [id]: open,
      },
    }));
  },
  saveScrollPosition: (conversationId, pos) => {
    set((s) => ({
      scrollPositions: {
        ...s.scrollPositions,
        [conversationId]: pos,
      },
    }));
  },

  setPermissionPrompt: (prompt, conversationId?) => {
    set((s) => {
      if (!prompt) {
        // When conversationId is omitted (undefined), clear ALL prompts globally across all sessions.
        if (conversationId === undefined) {
          return {
            permissionPromptsByConversation: {},
            permissionPrompt: null,
          };
        }
        // Specific conversation targeted
        const nextByConv = { ...s.permissionPromptsByConversation };
        if (conversationId) delete nextByConv[conversationId];
        return {
          permissionPromptsByConversation: nextByConv,
          permissionPrompt: conversationId === s.activeConversationId || !conversationId ? null : s.permissionPrompt,
        };
      }
      const convId = conversationId ?? prompt.conversationId ?? s.activeConversationId;
      const nextByConv = { ...s.permissionPromptsByConversation };
      if (convId) {
        nextByConv[convId] = { ...prompt, conversationId: convId };
      }
      return {
        permissionPromptsByConversation: nextByConv,
        permissionPrompt: convId === s.activeConversationId || !s.activeConversationId ? prompt : s.permissionPrompt,
      };
    });
  },

  resolvePermissionPrompt: async (id, decision) => {
    const current = Object.values(get().permissionPromptsByConversation).find((p) => p.id === id) ?? get().permissionPrompt;
    if (!current || current.id !== id) return;
    const convId = current.conversationId ?? get().activeConversationId;
    // Map store decision strings to the API's PermissionDecision format.
    const apiDecision =
      decision === "allow-once"
        ? "allow"
        : decision === "always-allow"
          ? "always_allow"
          : "deny";

    if (current.toolCallId && apiDecision === "deny") {
      const toolCallId = current.toolCallId;
      set((s) => {
        const targetConv = convId ?? s.activeConversationId;
        // Optimistic denial update for target conversation
        if (!targetConv) return {};
        const msgs = s.messagesByConversation[targetConv] ?? (targetConv === s.activeConversationId ? s.messages : []);
        const updated = msgs.map((m) => {
          if (!m.liveToolCalls) return m;
          const calls = m.liveToolCalls.map((t) =>
            t.id === toolCallId
              ? {
                  ...t,
                  status: "error" as const,
                  result: { error: "Permission denied by user." },
                }
              : t,
          );
          return { ...m, liveToolCalls: calls };
        });
        return {
          messagesByConversation: { ...s.messagesByConversation, [targetConv]: updated },
          // Keep active messages in sync with conversation cache only if targetConv is active
          ...(targetConv === s.activeConversationId ? { messages: updated } : {}),
        };
      });
    }

    // Persist permission decision to server
    try {
      await apiPost("/api/permissions/pending", { id, decision: apiDecision });
    } catch {
      // Server-side approval resolution fallback
    }
    try {
      // Resolve local UI promise
      current.resolve(decision);
    } catch {
      // resolver should never throw, but never let UI crash
    }
    set((s) => {
      const nextByConv = { ...s.permissionPromptsByConversation };
      if (convId) delete nextByConv[convId];
      for (const k of Object.keys(nextByConv)) {
        if (nextByConv[k]?.id === id) delete nextByConv[k];
      }
      return {
        permissionPromptsByConversation: nextByConv,
        permissionPrompt: s.permissionPrompt?.id === id ? null : s.permissionPrompt,
      };
    });
  },

  setQuestionPrompt: (prompt, conversationId?) => {
    set((s) => {
      if (!prompt) {
        // When conversationId is omitted (undefined), clear ALL prompts globally across all sessions.
        if (conversationId === undefined) {
          return {
            questionPromptsByConversation: {},
            questionPrompt: null,
          };
        }
        // Specific conversation targeted
        const nextByConv = { ...s.questionPromptsByConversation };
        if (conversationId) delete nextByConv[conversationId];
        return {
          questionPromptsByConversation: nextByConv,
          questionPrompt: conversationId === s.activeConversationId || !conversationId ? null : s.questionPrompt,
        };
      }
      const convId = conversationId ?? prompt.conversationId ?? s.activeConversationId;
      const nextByConv = { ...s.questionPromptsByConversation };
      if (convId) {
        nextByConv[convId] = { ...prompt, conversationId: convId };
      }
      return {
        questionPromptsByConversation: nextByConv,
        questionPrompt: convId === s.activeConversationId || !s.activeConversationId ? prompt : s.questionPrompt,
      };
    });
  },

  resolveQuestionPrompt: async (id, answer) => {
    const current = Object.values(get().questionPromptsByConversation).find((p) => p.id === id) ?? get().questionPrompt;
    if (!current || current.id !== id) return;
    const convId = current.conversationId ?? get().activeConversationId;

    try {
      await apiPost("/api/agents/questions/pending", { id, ...answer });
      set((s) => {
        const nextByConv = { ...s.questionPromptsByConversation };
        if (convId) delete nextByConv[convId];
        for (const k of Object.keys(nextByConv)) {
          if (nextByConv[k]?.id === id) delete nextByConv[k];
        }
        return {
          questionPromptsByConversation: nextByConv,
          questionPrompt: s.questionPrompt?.id === id ? null : s.questionPrompt,
        };
      });
    } catch (e) {
      // Entry already resolved server-side (timeout/stop) — settle locally.
      if (e instanceof ApiRequestError && e.status === 404) {
        set((s) => {
          const nextByConv = { ...s.questionPromptsByConversation };
          if (convId) delete nextByConv[convId];
          for (const k of Object.keys(nextByConv)) {
            if (nextByConv[k]?.id === id) delete nextByConv[k];
          }
          return {
            questionPromptsByConversation: nextByConv,
            questionPrompt: s.questionPrompt?.id === id ? null : s.questionPrompt,
          };
        });
        return;
      }
      // Transient failure — keep the card so the answer is not lost.
      toast.error("Failed to submit your answer. Please try again.");
    }
  },

  recoverQuestionPrompt: async (conversationId: string) => {
    if (get().questionPromptsByConversation[conversationId] || get().questionPrompt) return;
    try {
      const data = await apiGet<{ pending: PendingQuestionDTO[] }>(
        "/api/agents/questions/pending",
      );
      const match = data?.pending?.find((p) => p.conversationId === conversationId);
      if (match && !get().questionPromptsByConversation[conversationId]) {
        const qObj: QuestionPromptState = {
          id: match.id,
          toolCallId: match.toolCallId,
          conversationId: match.conversationId,
          questions: match.questions,
          question: match.questions[0]?.question,
          options: match.questions[0]?.options ?? [],
          isMultiSelect: match.questions[0]?.isMultiSelect ?? false,
          createdAt: match.createdAt,
        };
        set((s) => ({
          questionPromptsByConversation: {
            ...s.questionPromptsByConversation,
            [conversationId]: qObj,
          },
          questionPrompt: conversationId === s.activeConversationId || !s.activeConversationId ? qObj : s.questionPrompt,
        }));
      }
    } catch {
      // best-effort — ignore
    }
  },

  recoverPermissionPrompt: async (conversationId: string) => {
    if (get().permissionPromptsByConversation[conversationId] || get().permissionPrompt) return;
    try {
      const data = await apiGet<{ pending: PendingApprovalDTO[] }>(
        "/api/permissions/pending",
      );
      const match = data?.pending?.find((p) => p.conversationId === conversationId);
      if (match && !get().permissionPromptsByConversation[conversationId]) {
        const pObj: PermissionPromptState = {
          id: match.id,
          conversationId: match.conversationId,
          action: match.action || match.toolName || "action",
          target: match.target,
          toolCallId: match.toolCallId,
          toolName: match.toolName,
          createdAt: match.createdAt,
          resolve: (decision) => {
            void get().resolvePermissionPrompt(match.id, decision);
          },
        };
        set((s) => ({
          permissionPromptsByConversation: {
            ...s.permissionPromptsByConversation,
            [conversationId]: pObj,
          },
          permissionPrompt: conversationId === s.activeConversationId || !s.activeConversationId ? pObj : s.permissionPrompt,
        }));
      }
    } catch {
      // best-effort — ignore
    }
  },

  searchConversations: async (q) => {
    const query = q.trim();
    if (!query) return get().conversations;
    // Require >=3 characters for server-side search
    if (query.length < 3) return null;
    try {
      const data = await apiGet<{ conversations: ConversationDTO[] }>(
        "/api/conversations/search",
        { query: { q: query } },
      );
      return data?.conversations ?? [];
    } catch (e) {
      // Fall back to client-side search on failure
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        return null;
      }
      return null;
    }
  },

  setBulkSelectMode: (v) => {
    if (!v) {
      // Clear selection when exiting bulk mode
      set({ bulkSelectMode: false, selectedConversationIds: new Set<string>() });
    } else {
      set({ bulkSelectMode: true });
    }
  },

  toggleConversationSelected: (id) => {
    set((s) => {
      const next = new Set(s.selectedConversationIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedConversationIds: next };
    });
  },

  setConversationSelected: (id, selected) => {
    set((s) => {
      const next = new Set(s.selectedConversationIds);
      if (selected) next.add(id);
      else next.delete(id);
      return { selectedConversationIds: next };
    });
  },

  selectAllConversations: () => {
    set((s) => ({
      selectedConversationIds: new Set(s.conversations.map((c) => c.id)),
    }));
  },

  clearSelectedConversations: () => {
    set({ selectedConversationIds: new Set<string>() });
  },

  bulkDeleteConversations: async (ids) => {
    if (ids.length === 0) return 0;
    set({ bulkDeleting: true });
    let deleted = 0;
    try {
      // Try bulk delete endpoint with fallback to single-delete route
      try {
        const res = await fetch("/api/conversations/bulk", {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids }),
          credentials: "include",
        });
        if (!res.ok) {
          let message = `Bulk delete failed (${res.status})`;
          try {
            const env = (await res.json()) as { error?: string };
            if (env?.error) message = env.error;
          } catch {
            // not JSON — keep the generic message
          }
          throw new ApiRequestError(message, undefined, res.status);
        }
        deleted = ids.length;
      } catch {
        // Fallback: delete conversations sequentially
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              await apiDelete(`/api/conversations/${encodeURIComponent(id)}`);
              return true;
            } catch {
              return false;
            }
          }),
        );
        deleted = results.filter(Boolean).length;
      }

      // Clean up local conversation state and refresh
      const idSet = new Set(ids);
      set((s) => {
        // Build cleaned versions of all per-conversation maps in one pass.
        const cleanMap = <V>(rec: Record<string, V>): Record<string, V> => {
          const out: Record<string, V> = {};
          for (const k of Object.keys(rec)) {
            if (!idSet.has(k)) out[k] = rec[k];
          }
          return out;
        };
        return {
          conversations: s.conversations.filter((c) => !idSet.has(c.id)),
          activeConversationId:
            s.activeConversationId && idSet.has(s.activeConversationId)
              ? null
              : s.activeConversationId,
          messages:
            s.activeConversationId && idSet.has(s.activeConversationId)
              ? []
              : s.messages,
          selectedConversationIds: new Set<string>(),
          bulkSelectMode: false,
          messagesByConversation: cleanMap(s.messagesByConversation),
          streamingStateByConversation: cleanMap(s.streamingStateByConversation),
          activeTodosByConversation: cleanMap(s.activeTodosByConversation),
          thinkingExpanded: cleanMap(s.thinkingExpanded),
          scrollPositions: cleanMap(s.scrollPositions),
        };
      });

      // Best-effort refresh so the sidebar reflects the server-side truth.
      void get().refreshConversations();
      return deleted;
    } finally {
      set({ bulkDeleting: false });
    }
  },

  findPrecedingUserMessage: (messageId) => {
    const msgs = get().messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") return msgs[i];
    }
    return null;
  },

  removeMessage: (messageId, conversationId?) => {
    set((s) => {
      // Remove message from target conversation
      const convId = conversationId ?? s.activeConversationId ?? "";

      // Clean messages from both active list and per-conversation cache
      const filteredActive = s.messages.filter((m) => m.id !== messageId);
      const activeChanged = filteredActive.length !== s.messages.length;

      const prevConvList = convId ? (s.messagesByConversation[convId] ?? []) : [];
      const filteredConv = prevConvList.filter((m) => m.id !== messageId);
      const convChanged = filteredConv.length !== prevConvList.length;

      if (!activeChanged && !convChanged) return s;

      return {
        messages: activeChanged ? filteredActive : s.messages,
        messagesByConversation: convChanged && convId
          ? { ...s.messagesByConversation, [convId]: filteredConv }
          : s.messagesByConversation,
      };
    });
  },

  removeMessageAndAfter: (messageId) => {
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      const truncated = s.messages.slice(0, idx);
      const convId = s.activeConversationId ?? "";
      return {
        messages: truncated,
        messagesByConversation: convId
          ? { ...s.messagesByConversation, [convId]: truncated }
          : s.messagesByConversation,
      };
    });
  },

  removeMessagesAfter: (messageId) => {
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      // Keep messages[0..idx] inclusive — target stays, everything after is dropped.
      const truncated = s.messages.slice(0, idx + 1);
      const convId = s.activeConversationId ?? "";
      return {
        messages: truncated,
        messagesByConversation: convId
          ? { ...s.messagesByConversation, [convId]: truncated }
          : s.messagesByConversation,
      };
    });
  },

  updateMessageContent: (messageId, content) => {
    set((s) => {
      const updated = s.messages.map((m) =>
        m.id === messageId ? { ...m, content } : m,
      );
      const convId = s.activeConversationId ?? "";
      return {
        messages: updated,
        messagesByConversation: convId
          ? { ...s.messagesByConversation, [convId]: updated }
          : s.messagesByConversation,
      };
    });
  },

  persistMessageEdit: async (conversationId, messageId, content) => {
    // Persist edited message content to server
    try {
      await apiPatch(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        { content },
      );
      return true;
    } catch (e) {
      // Endpoint not ready yet — keep the optimistic local update.
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        return false;
      }
      // Other errors: keep local-only but signal that the server rejected it.
      return false;
    }
  },

  branchConversation: async (messageId) => {
    const state = get();
    const srcConvId = state.activeConversationId;
    if (!srcConvId) return null;
    try {
      // Server-side clone (conversation row + message prefix) in one
      // transaction — the branched history is durable immediately, so a
      // reload shows the full transcript.
      const res = await apiPost<{ conversation: ConversationDTO }>(
        `/api/conversations/${encodeURIComponent(srcConvId)}/branch`,
        { messageId },
      );
      const created = res.conversation;
      set((s) => ({ conversations: [created, ...s.conversations] }));
      broadcastTabSync("refresh_conversations");
      await get().selectConversation(created.id);
      return created.id;
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Failed to branch conversation";
      set({ streamError: msg });
      toast.error(msg);
      return null;
    }
  },

  createMcpServer: async (req) => {
    try {
      const res = await apiPost<{ server: McpServerDTO }>("/api/mcp/servers", req);
      // Refresh MCP server list from backend
      await get().refreshMcpServers();
      return res.server;
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Failed to create MCP server";
      set({ streamError: msg });
      return null;
    }
  },

  deleteMcpServer: async (id) => {
    try {
      await apiDelete(`/api/mcp/servers/${encodeURIComponent(id)}`);
      set((s) => ({ mcpServers: s.mcpServers.filter((x) => x.id !== id) }));
    } catch {
      // ignore
    }
  },

  connectMcpServer: async (id) => {
    try {
      const res = await apiPost<{ server: McpServerDTO }>(
        `/api/mcp/servers/${encodeURIComponent(id)}/connect`,
        {},
        { timeoutMs: 5 * 60_000 },
      );
      const updated = res.server;
      set((s) => ({ mcpServers: s.mcpServers.map((x) => (x.id === id ? updated : x)) }));
    } catch {
      // ignore
    }
  },

  disconnectMcpServer: async (id) => {
    // Optimistically mark disconnected locally, then reconcile with server.
    set((s) => ({
      mcpServers: s.mcpServers.map((x) =>
        x.id === id ? { ...x, status: "disconnected" as const, tools: [] } : x,
      ),
    }));
    try {
      await apiPost(`/api/mcp/servers/${encodeURIComponent(id)}/disconnect`, {});
    } catch {
      // ignore
    }
    await get().refreshMcpServers();
  },

  installPlugin: async (p) => {
    try {
      const body = {
        name: p.name,
        description: p.description ?? "",
        type: p.type ?? ("plugin" as const),
        source: p.source ?? "marketplace",
        manifest: p.manifest,
      };
      const res = await apiPost<{ plugin: PluginDTO }>("/api/plugins", body);
      await get().refreshPlugins();
      await get().refreshSkills();
      return res.plugin;
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Failed to install plugin";
      set({ streamError: msg });
      return null;
    }
  },

  togglePlugin: async (id, enabled) => {
    try {
      const res = await apiPost<{ plugin: PluginDTO }>(
        `/api/plugins/${encodeURIComponent(id)}/toggle`,
        { enabled },
      );
      const updated = res.plugin;
      set((s) => ({
        plugins: s.plugins.map((x) => (x.id === id ? updated : x)),
        skills: s.skills.map((x) => (x.id === id ? updated : x)),
      }));
    } catch {
      // ignore
    }
  },

  deletePlugin: async (id) => {
    try {
      await apiDelete(`/api/plugins/${encodeURIComponent(id)}`);
      set((s) => ({
        plugins: s.plugins.filter((x) => x.id !== id),
        skills: s.skills.filter((x) => x.id !== id),
      }));
    } catch {
      // ignore
    }
  },

  saveProviderKey: async (req) => {
    const res = await apiPost<{ key: ProviderKeyDTO }>("/api/providers/keys", req);
    const saved = res.key;
    set((s) => {
      const others = s.providerKeys.filter((k) => k.provider !== req.provider);
      return { providerKeys: [...others, saved] };
    });
  },

  removeProviderKey: async (provider) => {
    await apiDelete(`/api/providers/keys/${encodeURIComponent(provider)}`);
    set((s) => ({ providerKeys: s.providerKeys.filter((k) => k.provider !== provider) }));
  },

  testProviderKey: async (provider) => {
    try {
      const res = await apiPost<{ ok: boolean; latencyMs?: number; error?: string }>(
        "/api/providers/test",
        { provider },
        { timeoutMs: 2 * 60_000 },
      );
      return res ?? { ok: false, error: "No response" };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof ApiRequestError ? e.message : "Test failed",
      };
    }
  },

  runTerminal: async (req) => {
    try {
      // Execute terminal command with 10-minute timeout
      const res = await apiPost<TerminalResponse>("/api/terminal/run", req, {
        timeoutMs: 10 * 60_000,
      });
      return res;
    } catch (e) {
      return {
        ok: false,
        stdout: "",
        stderr: e instanceof ApiRequestError ? e.message : "Terminal request failed",
        exitCode: 1,
        command: req.command,
        blocked: false,
      };
    }
  },
}));

function safeParseArgs(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return parsePartialJson(raw);
  } catch {
    return undefined;
  }
}

export { DEFAULT_SYSTEM_PROMPT };


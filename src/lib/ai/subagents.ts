/**
 * Subagents public facade (OpenCode-style).
 *
 * The legacy `Subagent` / `SubagentMessage` types are kept stable for
 * downstream consumers (the API route, the panel, the session view).
 * They are derived projections of the rich internal `SubagentSession`
 * managed in subagent-session.ts and updated by the worker in
 * subagent-executor.ts.
 */
import {
  getSession,
  getSessions as _getSessions,
  deleteSession,
  type SubagentSession,
  type SubagentSessionMessage,
  type SubagentStatus as SessionStatus,
} from "./subagent-session";
import {
  spawnSubagent as _spawnSubagent,
  awaitSubagents as _awaitSubagents,
} from "./subagent-executor";
import { formatSubagentReportText } from "./subagent-queue";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface Subagent {
  id: string;
  userId?: string;
  conversationId: string;
  name: string;
  task: string;
  systemPrompt?: string | null;
  status: SubagentStatus;
  result?: string | null;
  error?: string | null;
  partial?: { content: string; thinking?: string };
  createdAt: number | string;
  updatedAt?: number | string;
  completedAt?: number;
}

export interface CreateSubagentOpts {
  name: string;
  task: string;
  systemPrompt?: string;
  allowedTools?: string[];
  provider?: string;
  model?: string;
  checkpointId?: string;
  thinkingLevel?: string;
}

/**
 * Public spawn — fire-and-forget; the worker runs in the background
 * and updates the in-memory session. The caller gets an immediate
 * placeholder DTO with the freshly-allocated id.
 */
export function createSubagent(
  userId: string,
  conversationId: string,
  opts: CreateSubagentOpts,
): Subagent {
  const { subagentId } = _spawnSubagent(userId, conversationId, opts);
  const session = getSession(userId, subagentId);
  if (!session) {
    // Realistically unreachable — but synthesize a sensible DTO so the
    // caller never sees crashes on this hot path.
    return {
      id: subagentId,
      conversationId,
      userId,
      name: opts.name,
      task: opts.task,
      systemPrompt: opts.systemPrompt ?? "",
      status: "running",
      createdAt: Date.now(),
    };
  }
  return sessionToSubagent(session);
}

/** Block until each subagent reaches a terminal state (completed | failed). */
export async function awaitSubagents(
  userId: string,
  ids: string[],
  timeoutMs = 1_800_000,
  signal?: AbortSignal,
): Promise<
  Array<{
    id: string;
    name: string;
    status: "completed" | "failed";
    report: Subagent["result"]; // formatted summary string
    findings?: Array<{ file?: string; action: string; evidence: string }>; // structured findings
    error: string | null;
  }>
> {
  const results = await _awaitSubagents(userId, ids, timeoutMs, signal);
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    report: r.report ? formatSubagentReportText(r.report) : undefined,
    findings: r.report ? r.report.findings : undefined,
    error: r.error,
  }));
}

/** Drop a subagent from the registry (admin only — caller ACLs first). */
export function deleteSubagent(userId: string, id: string): boolean {
  return deleteSession(userId, id);
}

/** Public ACL-checked list per conversation. */
export function getSubagents(userId: string, conversationId: string): Subagent[] {
  return _getSessions(userId, conversationId).map(sessionToSubagent);
}

/** Public ACL-checked single lookup. */
export function getSubagent(userId: string, id: string): Subagent | null {
  const session = getSession(userId, id);
  return session ? sessionToSubagent(session) : null;
}

/**
 * Structured report payload (formatted text + findings) for a single subagent.
 * Shared by `get_subagent` and the executor's auto-delivery path so the main
 * agent always receives the identical "completed" payload, whoever computed it.
 */
export function getSubagentStructuredReport(
  userId: string,
  id: string,
): { text: string; findings: Array<{ file?: string; action: string; evidence: string }> } | null {
  const session = getSession(userId, id);
  if (!session?.report) return null;
  return { text: formatSubagentReportText(session.report), findings: session.report.findings };
}

/** Public message-history read for the session-view modal. */
export function getSubagentMessages(
  userId: string,
  id: string,
): SubagentMessage[] | null {
  const session = getSession(userId, id);
  if (!session) return null;
  return session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls,
  }));
}

function sessionToSubagent(session: SubagentSession): Subagent {
  let result: string | undefined;
  if (session.formattedResultCache?.messageCount === session.messages.length) {
    result = session.formattedResultCache.text;
  } else {
    result = formatMessagesChronological(session.messages);
    session.formattedResultCache = { messageCount: session.messages.length, text: result };
  }
  return {
    id: session.id,
    conversationId: session.parentConversationId,
    userId: session.userId,
    name: session.name,
    task: session.task,
    systemPrompt: session.systemPrompt,
    status: mapStatus(session.status),
    result,
    error: session.error,
    partial: session.partial,
    createdAt: session.createdAt,
    updatedAt: session.completedAt ?? session.createdAt,
    completedAt: session.completedAt,
  };
}

function formatMessagesChronological(messages: SubagentSessionMessage[]): string | undefined {
  if (messages.length === 0) return undefined;
  const parts: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        parts.push(`> ${msg.content}`);
        break;
      case "user":
        parts.push(`**User:** ${msg.content}`);
        break;
      case "assistant": {
        const block: string[] = [];
        if (msg.thinking) {
          block.push(`**Thinking**\n\n${msg.thinking}`);
        }
        if (msg.content) {
          block.push(msg.content);
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            block.push(`**Tool call: \`${tc.name}\`**\n\`\`\`json\n${tc.arguments}\n\`\`\``);
          }
        }
        if (block.length > 0) parts.push(block.join("\n\n"));
        break;
      }
      case "tool": {
        parts.push(`**Tool result**\n\`\`\`\n${msg.content}\n\`\`\``);
        break;
      }
    }
  }
  return parts.join("\n\n---\n\n");
}

function mapStatus(s: SessionStatus): SubagentStatus {
  switch (s) {
    case "pending":
      return "pending";
    case "running":
    case "thinking":
    case "tool_exec":
    case "completing":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

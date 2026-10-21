/**
 * Runtime validation for permission prompt payloads crossing trust boundaries:
 * SSE frames and recovery API responses are untrusted input and must never be
 * written into the store unchecked.
 */

export const MAX_PERMISSION_ID_CHARS = 128;
export const MAX_PERMISSION_FIELD_CHARS = 200;
export const MAX_PERMISSION_TARGET_CHARS = 2_000;
/** Upper bound for a server-provided TTL — a bogus frame must not park the UI forever. */
export const MAX_PERMISSION_TTL_MS = 24 * 60 * 60_000;
/**
 * The approval id the resolve endpoint accepts. A frame with any other shape
 * would render a card that can never be answered (every POST would 400), so
 * such frames are rejected at the boundary.
 */
const APPROVAL_ID_PATTERN = /^pa_[0-9a-f]{16}$/;

export interface PermissionPromptEventFields {
  approvalId: string;
  action: string;
  target: string;
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
  /** Server-provided auto-deny window; absent means the standard main-agent TTL. */
  ttlMs?: number;
}

export interface ParsedSubagentPermissionEvent {
  sessionId: string;
  name?: string;
  /** Conversation the request belongs to — present on the user-scoped stream. */
  conversationId?: string;
  permission: PermissionPromptEventFields;
}

export interface ParsedPendingPermission extends PermissionPromptEventFields {
  conversationId: string;
  subagentId?: string;
  subagentName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(value, Date.now() + 5000);
  }
  return Date.now();
}

export function parsePermissionPromptEvent(
  raw: unknown,
): PermissionPromptEventFields | null {
  const record = asRecord(raw);
  if (!record) return null;
  const approvalId = boundedString(record.approvalId, MAX_PERMISSION_ID_CHARS);
  if (!approvalId || !APPROVAL_ID_PATTERN.test(approvalId)) return null;
  const toolName = boundedString(record.toolName, MAX_PERMISSION_FIELD_CHARS);
  const action = boundedString(record.action, MAX_PERMISSION_FIELD_CHARS);
  const target = boundedString(record.target, MAX_PERMISSION_TARGET_CHARS);
  const toolCallId = boundedString(record.toolCallId, MAX_PERMISSION_FIELD_CHARS);
  const fallback = toolName ?? action;
  const ttlMs =
    typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs > 0
      ? Math.min(record.ttlMs, MAX_PERMISSION_TTL_MS)
      : undefined;
  return {
    approvalId,
    action: action ?? fallback ?? "action",
    target: target ?? fallback ?? "action",
    toolCallId,
    toolName,
    createdAt: timestamp(record.createdAt),
    ttlMs,
  };
}

export function parseSubagentPermissionEvent(
  raw: unknown,
): ParsedSubagentPermissionEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId = boundedString(record.sessionId, MAX_PERMISSION_FIELD_CHARS);
  if (!sessionId) return null;
  const permission = parsePermissionPromptEvent(record.permission);
  if (!permission) return null;
  return {
    sessionId,
    name: boundedString(record.name, MAX_PERMISSION_FIELD_CHARS),
    conversationId: boundedString(record.conversationId, MAX_PERMISSION_FIELD_CHARS),
    permission,
  };
}

export function parsePendingApproval(raw: unknown): ParsedPendingPermission | null {
  const record = asRecord(raw);
  if (!record) return null;
  const conversationId = boundedString(
    record.conversationId,
    MAX_PERMISSION_FIELD_CHARS,
  );
  if (!conversationId) return null;
  // The recovery API exposes the id as `id`; SSE frames use `approvalId`.
  const prompt = parsePermissionPromptEvent({
    ...record,
    approvalId: record.approvalId ?? record.id,
  });
  if (!prompt) return null;
  const subagent = asRecord(record.subagent);
  return {
    ...prompt,
    conversationId,
    subagentId: subagent
      ? boundedString(subagent.id, MAX_PERMISSION_FIELD_CHARS)
      : undefined,
    subagentName: subagent
      ? boundedString(subagent.name, MAX_PERMISSION_FIELD_CHARS)
      : undefined,
  };
}

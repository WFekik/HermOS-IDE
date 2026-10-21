/**
 * In-memory registry of pending permission approvals for agent tool-call prompting.
 * Holds promises resolved by user decision or auto-denied after TTL/abort.
 */


import { randomBytes } from "crypto";

import type { PermissionAction } from "@/lib/permissions";
import { PERMISSION_APPROVAL_TTL_MS } from "@/lib/permissions-core";

export type PermissionDecision = "allow" | "deny" | "always_allow";
export type ApprovalStatus = "pending" | "resolved" | "expired" | "aborted";

export interface PendingApproval {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  action: PermissionAction | null;
  /** Human-readable summary, e.g. `run \`ls -la\``. */
  target: string;
  args: Record<string, unknown>;
  createdAt: number;
  status: ApprovalStatus;
  /** Set when the request originates from a background subagent. */
  subagent?: { id: string; name: string };
  /** Auto-deny window for this entry, from createdAt. */
  ttlMs: number;
  /** Resolves the awaited promise in the executor. */
  resolve: (decision: PermissionDecision) => void;
  /** Auto-deny timer (entry `ttlMs`). */
  timeout: NodeJS.Timeout;
}

/** Public shape returned to the API layer (no `resolve`/`timeout`). */
export interface PendingApprovalDTO {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  action: PermissionAction | null;
  target: string;
  args: Record<string, unknown>;
  createdAt: number;
  status?: ApprovalStatus;
  /** Auto-deny window for this entry, from createdAt. */
  ttlMs: number;
  subagent?: { id: string; name: string };
}

export interface CreatePendingInput {
  userId: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  action: PermissionAction | null;
  target: string;
  args: Record<string, unknown>;
  subagent?: { id: string; name: string };
  /** Override the default auto-deny window (subagent prompts allow longer review). */
  ttlMs?: number;
}

/** How long to wait for user decision before auto-denying (2 minutes / 120s). */
export const APPROVAL_TTL_MS = PERMISSION_APPROVAL_TTL_MS;

const VALID_DECISIONS: ReadonlySet<PermissionDecision> = new Set([
  "allow",
  "deny",
  "always_allow",
]);

const pendingById = new Map<string, PendingApproval>();

// Crypto-random suffix → collision-proof ids without a mutable counter.
function newId(): string {
  return `pa_${randomBytes(8).toString("hex")}`;
}

function toDTO(p: PendingApproval): PendingApprovalDTO {
  return {
    id: p.id,
    userId: p.userId,
    conversationId: p.conversationId,
    messageId: p.messageId,
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    action: p.action,
    target: p.target,
    args: p.args,
    createdAt: p.createdAt,
    status: p.status,
    ttlMs: p.ttlMs,
    subagent: p.subagent,
  };
}

/** Remove a pending entry, cancel timer, and settle promise with "deny". */
function expireEntry(entry: PendingApproval, reason: "expired" | "aborted" = "expired"): void {
  if (entry.status !== "pending") return;
  entry.status = reason;
  pendingById.delete(entry.id);
  clearTimeout(entry.timeout);
  try {
    entry.resolve("deny");
  } catch {
    /* ignore — promise may already be resolved */
  }
}

/** Lazy cleanup: drop entries past their TTL before inserting new ones. */
function purgeExpired(now: number): void {
  for (const entry of pendingById.values()) {
    if (now - entry.createdAt > entry.ttlMs) expireEntry(entry, "expired");
  }
}

/** Register a pending approval; returns unique id and promise resolved on decision/timeout. */
export function createPendingApproval(
  input: CreatePendingInput,
): { id: string; promise: Promise<PermissionDecision> } {
  purgeExpired(Date.now());
  const id = newId();
  const ttlMs = input.ttlMs ?? APPROVAL_TTL_MS;
  let resolveFn!: (decision: PermissionDecision) => void;
  const promise = new Promise<PermissionDecision>((resolve) => {
    resolveFn = resolve;
  });

  // Auto-deny after ttlMs so the executor never deadlocks.
  const timeout = setTimeout(() => {
    const entry = pendingById.get(id);
    if (!entry) return;
    expireEntry(entry, "expired");
  }, ttlMs);
  // Don't let the timer keep the event loop alive on shutdown.
  if (typeof timeout.unref === "function") timeout.unref();

  const entry: PendingApproval = {
    id,
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    action: input.action,
    target: input.target,
    args: input.args,
    createdAt: Date.now(),
    status: "pending",
    ttlMs,
    subagent: input.subagent,
    resolve: resolveFn,
    timeout,
  };
  pendingById.set(id, entry);
  return { id, promise };
}

/** Resolve a pending approval by id and verify user ownership. Returns true on success. */
export function resolvePendingApproval(
  userId: string,
  id: string,
  decision: PermissionDecision,
): boolean {
  if (!VALID_DECISIONS.has(decision)) return false;
  purgeExpired(Date.now());
  const entry = pendingById.get(id);
  if (!entry || entry.status !== "pending") return false;
  if (entry.userId !== userId) return false;
  entry.status = "resolved";
  pendingById.delete(id);
  clearTimeout(entry.timeout);
  try {
    entry.resolve(decision);
  } catch {
    /* ignore — promise may already be resolved (e.g. auto-deny race) */
  }
  return true;
}

/** Peek a pending approval by id (read-only, no resolution). */
export function peekPendingApproval(
  userId: string,
  id: string,
): PendingApprovalDTO | null {
  purgeExpired(Date.now());
  const entry = pendingById.get(id);
  if (!entry) return null;
  if (entry.userId !== userId) return null;
  return toDTO(entry);
}

/** List all pending approvals for a user (read-only). */
export function getPendingForUser(userId: string): PendingApprovalDTO[] {
  purgeExpired(Date.now());
  const out: PendingApprovalDTO[] = [];
  for (const entry of pendingById.values()) {
    if (entry.userId === userId) out.push(toDTO(entry));
  }
  // Newest first — the frontend usually cares about the most recent prompt.
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Cancel a single pending approval by its ID. */
export function cancelPendingApproval(id: string): void {
  const entry = pendingById.get(id);
  if (entry) expireEntry(entry);
}

/**
 * Deny pending approvals for a conversation on SSE stream abort.
 *
 * If `keepSubagentIds` is provided, those subagent workers keep their approvals.
 * If `opts?.excludeSubagents` is true, all subagent approvals are preserved
 * (used when only the main agent stream aborts).
 */
export function cancelPendingForConversation(
  conversationId: string,
  opts?: ReadonlySet<string> | { keepSubagentIds?: ReadonlySet<string>; excludeSubagents?: boolean },
): void {
  const keep = opts instanceof Set ? opts : (opts && "keepSubagentIds" in opts ? opts.keepSubagentIds : undefined);
  const excludeSubagents = opts && !(opts instanceof Set) && "excludeSubagents" in opts ? opts.excludeSubagents : false;
  for (const entry of pendingById.values()) {
    if (entry.conversationId !== conversationId) continue;
    if (excludeSubagents && entry.subagent) continue;
    if (entry.subagent && keep?.has(entry.subagent.id)) continue;
    expireEntry(entry);
  }
}

/** Test-only: clear everything. Not used in production paths. */
export function __clearAll(): void {
  for (const entry of pendingById.values()) {
    clearTimeout(entry.timeout);
  }
  pendingById.clear();
}

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  notFound,
  unauthorized,
  audit,
} from "@/app/api/_lib/helpers";
import {
  getPendingForUser,
  peekPendingApproval,
  resolvePendingApproval,
  type PermissionDecision,
} from "@/lib/permissions-prompt";
import {
  getPermissions,
  setPermissions,
  type PermissionAction,
  type PermissionRule,
} from "@/lib/permissions";

/**
 * Live permission prompt resolution endpoint.
 *
 * The agent executor (src/lib/ai/executor.ts), when it hits a tool whose
 * permission mode is "ask", emits a `tool_call_permission` SSE event and
 * registers a pending approval in the in-memory registry
 * (src/lib/permissions-prompt.ts). The frontend then POSTs here to resolve
 * it with one of:
 *   - "allow"         → execute this one tool call
 *   - "deny"          → block this one tool call
 *   - "always_allow"  → execute this call AND persist a new "allow" rule for
 *                       the action so future calls of the same action skip
 *                       the prompt entirely
 *
 * There is also a GET that lists the caller's currently-pending approvals
 * (useful if the SSE event was missed — e.g. on page reload mid-stream).
 *
 * Auth required throughout. 60/min/user rate limit. The registry is
 * per-process and entries are scoped by userId — callers can only resolve
 * their own pending approvals.
 */

export const dynamic = "force-dynamic";

const PENDING_RATE = { capacity: 60, refillPerSec: 60 / 60 };

const resolveSchema = z.object({
  id: z.string().trim().min(1).max(128),
  decision: z.enum(["allow", "deny", "always_allow"] as const),
});

const KNOWN_ACTIONS: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "file.read",
  "file.write",
  "command.run",
  "browser.open",
  "browser.click",
  "browser.type",
  "web.fetch",
  "web.search",
  "mcp.call",
  "subagent.spawn",
  "subagent.get",
  "subagent.message",
]);

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `permissions-pending:${user.id}`, PENDING_RATE);
  if (limited) return limited;

  const pending = getPendingForUser(user.id);
  return ok({
    pending: pending.map((p) => ({
      id: p.id,
      conversationId: p.conversationId,
      messageId: p.messageId,
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      action: p.action,
      target: p.target,
      args: p.args,
      createdAt: p.createdAt,
    })),
  });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `permissions-pending:${user.id}`, PENDING_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid resolve payload.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { id, decision } = parsed.data as {
    id: string;
    decision: PermissionDecision;
  };

  // Peek first (read-only) so we can:
  //   1. Confirm the entry exists and belongs to the caller (404 otherwise).
  //   2. Read the action — needed to persist an "always_allow" rule.
  // There's a benign race: the entry could be auto-denied (120s timer
  // / APPROVAL_TTL_MS) between the peek and the resolve.
  // resolvePendingApproval returns false in that case and we 404 — the
  // executor already moved on with "deny".
  const pending = peekPendingApproval(user.id, id);
  if (!pending) {
    return notFound("Pending approval not found.");
  }

  const resolved = resolvePendingApproval(user.id, id, decision);
  if (!resolved) {
    // Raced with the 120s auto-deny (APPROVAL_TTL_MS) or another resolver —
    // the executor already moved on with "deny".
    return notFound("Pending approval not found.");
  }

  // "always_allow" persists a new "allow" rule for this action (replacing
  // any existing rule for the same action) so future calls of the same
  // action skip the prompt entirely. Only persist AFTER successful resolve
  // so a TTL race (404) never creates a durable rule for a denied prompt.
  // If the action is null (shouldn't happen for "ask" mode —
  // evaluateToolPermission returns "allow" for null actions — but we defend
  // in depth), we fall back to treating the decision as a one-shot "allow".
  if (decision === "always_allow" && pending.action) {
    if (KNOWN_ACTIONS.has(pending.action)) {
      try {
        const config = await getPermissions(user.id);
        const rules: PermissionRule[] = config.rules.filter(
          (r) => r.action !== pending.action,
        );
        rules.push({ action: pending.action, mode: "allow" });
        await setPermissions(user.id, {
          ...config,
          rules,
        });
      } catch (e) {
        // Persistence failed — log and proceed with a one-shot allow so the
        // user's intent (allow this call) still takes effect.
        console.error("[permissions-pending] always_allow persist failed:", e);
      }
    }
  }

  try {
    await audit(
      user.id,
      "permission_resolve",
      JSON.stringify({
        id,
        decision,
        tool: pending.toolName,
        action: pending.action,
        conversationId: pending.conversationId,
      }),
      getClientIp(req),
    );
  } catch {
    /* ignore audit failures */
  }

  return ok({ ok: true, decision });
});

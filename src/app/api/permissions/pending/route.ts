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
  upsertPermissionRule,
  KNOWN_PERMISSION_ACTIONS,
  isDurableAlwaysAllowAction,
  type PermissionAction,
} from "@/lib/permissions";

/**
 * Live permission prompt resolution endpoint.
 *
 * The agent executor emits a `tool_call_permission` SSE event and registers
 * a pending approval. The frontend POSTs here to resolve it with one of:
 *   - "allow"         → execute this one tool call
 *   - "deny"          → block this one tool call
 *   - "always_allow"  → execute this call AND persist a new "allow" rule
 */

export const dynamic = "force-dynamic";

const PENDING_RATE = { capacity: 60, refillPerSec: 60 / 60 };

const resolveSchema = z
  .object({
    id: z.string().trim().regex(/^pa_[0-9a-f]{16}$/),
    decision: z.enum(["allow", "deny", "always_allow"] as const),
  })
  .strict();

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
      ttlMs: p.ttlMs,
      subagent: p.subagent,
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
  // The awaiting executor applies the decision to its own snapshot right
  // away, so the rule takes effect for the current run even though this
  // write lands asynchronously.
  // SECURITY: command.outside_workspace is never persisted — an "always_allow"
  // there downgrades to a one-shot "allow" so a single approval cannot
  // permanently bypass sanitization for all future outside commands.
  if (decision === "always_allow" && pending.action) {
    if (!isDurableAlwaysAllowAction(pending.action)) {
      try {
        await audit(
          user.id,
          "permission_outside_workspace_always_allow_downgraded",
          JSON.stringify({ id, tool: pending.toolName, action: pending.action }),
          getClientIp(req),
        );
      } catch {
        /* ignore audit failures */
      }
    } else if (KNOWN_PERMISSION_ACTIONS.has(pending.action)) {
      try {
        await upsertPermissionRule(user.id, pending.action, "allow");
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

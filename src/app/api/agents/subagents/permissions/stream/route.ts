import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  subscribeUserSubagentPermissions,
  getPendingPermissionSessions,
  getSession,
} from "@/lib/ai/subagent-session";
import { unauthorized, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/subagents/permissions/stream
 *
 * User-scoped SSE for subagent tool approvals. The conversation-scoped stream
 * only reaches the client that has the conversation open, so an approval
 * raised by a subagent running in a background conversation would stay
 * invisible until the user switches to it — while the worker parks until its
 * approval window expires.
 *
 * Events:
 *   event: permission — a subagent blocked on a user tool approval (replayed
 *                       for still-pending requests on connect)
 *   : keepalive      — every 15s to prevent proxy timeouts
 */
export async function GET(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch { /* stream may be closed */ }
      };

      const emit = (sessionId: string, conversationId: string) => {
        const session = getSession(user.id, sessionId);
        if (!session?.pendingPermission || session.status !== "awaiting_permission") return;
        // Never replay an approval the server already auto-denied.
        const age = Date.now() - session.pendingPermission.createdAt;
        if (age >= session.pendingPermission.ttlMs) return;
        send("permission", {
          sessionId,
          conversationId,
          name: session.name,
          permission: session.pendingPermission,
        });
      };

      // Replay still-pending requests so a client that connects late (or
      // reconnects after a network drop) still surfaces the prompt.
      for (const session of getPendingPermissionSessions(user.id)) {
        emit(session.id, session.parentConversationId);
      }

      unsubscribe = subscribeUserSubagentPermissions(user.id, emit);

      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch { /* stream may be closed */ }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

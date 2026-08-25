import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { getSubagents } from "@/lib/ai/subagents";
import {
  subscribeSubagentUpdates,
  subscribeSubagentPartials,
  subscribeSubagentWake,
  getSession,
} from "@/lib/ai/subagent-session";
import { apiError, unauthorized, enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { hasPendingWakeGrant } from "@/lib/ai/subagent-delivery";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/subagents/stream?conversationId=<id>
 *
 * SSE endpoint that streams subagent updates live. On every update to any
 * subagent in the conversation, the full subagents array is pushed to all
 * connected clients — no polling needed.
 *
 * Events:
 *   event: snapshot   — initial state on connect
 *   event: update     — any subagent created, updated, or deleted
 *   event: partial    — token-level live draft of a running subagent's current
 *                       turn (independent of the full-array `update` events)
 *   event: wake       — all deferred subagents delivered; client should launch
 *                       the sentinel autoWake chat run to synthesize the answer
 *   : keepalive       — every 15s to prevent proxy timeouts
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

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") || "";
  if (!conversationId) return apiError("Missing conversationId query.", 400);
  const typesParam = url.searchParams.get("types") || "all";
  const wantedTypes = new Set(typesParam.split(",").map((s) => s.trim().toLowerCase()));
  const wantAll = wantedTypes.has("all");
  const wantUpdates = wantAll || wantedTypes.has("update") || wantedTypes.has("snapshot");
  const wantPartials = wantAll || wantedTypes.has("partial");
  const wantWake = wantAll || wantedTypes.has("wake");

  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  if (!conv || conv.userId !== user.id) {
    return apiError("Conversation not found.", 404);
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let cleanupPartials: (() => void) | undefined;
  let cleanupWake: (() => void) | undefined;
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

      if (wantUpdates) {
        const subagents = getSubagents(user.id, conversationId);
        send("snapshot", { subagents });
      }

      // Replay a missed wake: if the delivery watcher published a wake while no
      // client was connected (tab switched / refreshed), (re)emit it at connect
      // time so the auto-synthesis run still fires.
      if (wantWake && hasPendingWakeGrant(user.id, conversationId)) {
        send("wake", { delivered: true });
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (wantUpdates) {
        cleanup = subscribeSubagentUpdates(user.id, conversationId, () => {
          // Debounce rapid updates (e.g. multiple tool results in one iteration)
          // to avoid flooding the SSE connection.
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            const updated = getSubagents(user.id, conversationId);
            send("update", { subagents: updated });
          }, 100);
        });
      }

      // Token-level streaming: forward dirty live drafts without re-serializing
      // the full subagent history every tick (`getSubagents` rebuilds the whole
      // transcript, so we read the raw session instead).
      let partialTimer: ReturnType<typeof setTimeout> | null = null;
      if (wantPartials) {
        cleanupPartials = subscribeSubagentPartials(user.id, conversationId, (sessionId) => {
          if (partialTimer) clearTimeout(partialTimer);
          partialTimer = setTimeout(() => {
            partialTimer = null;
            const session = getSession(user.id, sessionId);
            if (
              session?.partial &&
              session.status !== "completed" &&
              session.status !== "failed"
            ) {
              send("partial", { sessionId, partial: session.partial });
            }
          }, 60);
        });
      }

      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch { /* stream may be closed */ }
      }, 15_000);

      // Wake event: fired once the background delivery watcher has posted every
      // deferred subagent report and is ready for the autoWake synthesis run.
      if (wantWake) {
        cleanupWake = subscribeSubagentWake(user.id, conversationId, () => {
          send("wake", { delivered: true });
        });
      }

      req.signal.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        if (partialTimer) clearTimeout(partialTimer);
        cleanup?.();
        cleanupPartials?.();
        cleanupWake?.();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
    cancel() {
      cleanup?.();
      cleanupPartials?.();
      cleanupWake?.();
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

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { unauthorized, apiError, enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { subscribeTodoUpdates, loadAgentTodosForConversation } from "@/lib/todo-pubsub";

/**
 * GET /api/todos/stream?conversationId=<id>
 *
 * Server-sent event stream of todo-list updates for one conversation.
 *
 * Why an SSE channel?
 *   - The old UI polled `GET /api/todos` every 3 seconds, which is
 *     wasteful when the agent isn't running and slow to react when
 *     it is.
 *   - With an event push, the banner updates the millisecond the
 *     agent's `todo_write` tool commits — the user sees motion as it
 *     happens instead of waiting on the next tick.
 *
 * Protocol:
 *   - The first message we emit is `event: snapshot` with the full
 *     current list so connecting clients don't need a separate GET
 *     pass.
 *   - Subsequent messages are `event: update` with the new array
 *     (we send the full list — simple, idempotent, and avoids the
 *     need for client-side merge logic).
 *   - Idle connections stay open until the client disconnects.
 *
 * Reconnection:
 *   - EventSource auto-reconnects with exponential backoff built
 *     into the browser. Each reconnect re-runs the GET handler so
 *     we resend a fresh snapshot from disk.
 *
 * Auth + ownership:
 *   - Same rules as the REST endpoints — must be the conversation
 *     owner or the stream is 404. We return 404 (not 401) so we
 *     don't leak conversation existence.
 */

export const dynamic = "force-dynamic";

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

  // Ownership verification — load existing todos is enough to verify
  // (db loadTodos already gates by userId in the helper, but here we
  // also check the conversation exists). 404 on ownership failure.
  const { db } = await import("@/lib/db");
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  if (!conv || conv.userId !== user.id) {
    return apiError("Conversation not found.", 404);
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        const payload =
          `event: ${event}\n` +
          `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream already closed by the client — the unsubscribe
          // call in `cancel()` will clean up.
        }
      };

      // 1) Emit a snapshot by reading current todos. Done best-effort —
      // if it fails we still emit an empty snapshot rather than 500ing.
      try {
        const list = await loadAgentTodosForConversation(user.id, conversationId);
        send("snapshot", { todos: list });
      } catch {
        send("snapshot", { todos: [] });
      }

      unsubscribe = subscribeTodoUpdates(user.id, conversationId, (todos) => {
        send("update", { todos });
      });

      // 3) Comment line every 25s. SSE intermediaries (proxies,
      //    load balancers) close idle streams after ~30s; a comment
      //    frame keeps the connection warm without sending data the
      //    client has to parse.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      try {
        if (cleanup) cleanup();
      } catch {
        // ignore
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Avoid buffering by intermediaries (e.g. nginx).
      "X-Accel-Buffering": "no",
    },
  });
}
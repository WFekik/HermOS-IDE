import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { browserEvents, type BrowserSession } from "@/lib/browser";
import { withErrorHandler, unauthorized } from "@/app/api/_lib/helpers";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const limited = await withRateLimit(req, `browser-events:${user.id}`, RATE_LIMITS.chat);
  if (limited) return limited;

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let onEvent: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Only forward events that belong to this tenant. Sessions are keyed by
      // bare userId (agent and panel share one browser); the legacy
      // "userId:convId" prefix match is kept purely as defense-in-depth
      // against any future composite-key producer.
      onEvent = (payload?: { sessionKey?: string; session?: BrowserSession | null }) => {
        const key = payload?.sessionKey ?? "";
        if (key !== user.id && !key.startsWith(user.id + ":")) return;
        try {
          // Carry the live url/title in the event itself so the panel can
          // update instantly without waiting for its next poll.
          const s = payload?.session;
          const body = s ? JSON.stringify({ url: s.url, title: s.title }) : "";
          controller.enqueue(encoder.encode(body ? `data: ${body}\n\n` : "data: update\n\n"));
        } catch {
          // Stream may already be closed
        }
      };

      browserEvents.on("change", onEvent);

      // Keepalive: proxies and load-balancers close idle SSE connections
      // after ~60s without data. Send a comment every 15s to prevent that.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Stream already closed; interval will be cleared by cancel()
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        if (onEvent) {
          browserEvents.off("change", onEvent);
          onEvent = null;
        }
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      // Called when the client closes the connection cleanly (not via abort).
      // Ensures the event listener is always cleaned up regardless of how
      // the stream terminates.
      if (onEvent) {
        browserEvents.off("change", onEvent);
        onEvent = null;
      }
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

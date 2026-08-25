import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import { subscribeToFileWatch, type FileWatchEvent } from "@/lib/file-watcher";
import { unauthorized, apiError, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

/**
 * GET /api/workspace/watch
 *
 * Server-Sent Events endpoint that streams file-change events for the
 * user's active workspace. The frontend uses this to refresh the file
 * tree / editor when files change on disk (agent edits, terminal commands,
 * autosaves, or external edits).
 *
 * Wire format (standard SSE):
 *   - File event:  `data: {"path":"src/foo.ts","event":"change","timestamp":1700...}\n\n`
 *   - Heartbeat:   `: keepalive\n\n`  (every 15s — keeps proxies from closing idle SSE)
 *
 * Connection lifecycle:
 *   - One connection per user: if a new connection opens, the previous one
 *     is closed (we track active connections in `activeConns` and abort
 *     the previous stream when a new one arrives). This prevents a single
 *     user from amassing watchers across lost tabs.
 *   - On client disconnect (request.signal.aborted), the SSE listener is
 *     unsubscribed. When the last listener is gone, the underlying
 *     `fs.FSWatcher` is closed (see `file-watcher.ts`).
 *
 * No rate limit — SSE is a long-lived connection; rate-limiting it would
 * just close the stream. Auth is still required (401 on no session).
 */
export const dynamic = "force-dynamic";
// SSE must not be cached — force the runtime to flush every chunk immediately.
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;

// Active SSE controllers per user. Used to enforce the one-connection-per-user
// rule: when a new connection opens for a user, we abort the previous one.
interface ActiveConn {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}
const activeConns = new Map<string, ActiveConn>();

export async function GET(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  // Resolve the active workspace (auto-provision a default if the user has
  // none yet). The watcher is bound to this root.
  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  if (!ws.rootDir) {
    return apiError("No workspace root available.", 500);
  }

  const encoder = new TextEncoder();
  const userId = user.id;

  // Enforce one-connection-per-user: if there's an existing live SSE for
  // this user, gracefully close it (the client sees a normal stream end).
  const prev = activeConns.get(userId);
  if (prev && !prev.closed) {
    prev.closed = true;
    try {
      prev.controller.close();
    } catch {
      // Already closed or errored — that's fine.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const conn: ActiveConn = { controller, closed: false };
      activeConns.set(userId, conn);

      const safeEnqueue = (bytes: Uint8Array): boolean => {
        if (conn.closed) return false;
        try {
          controller.enqueue(bytes);
          return true;
        } catch {
          conn.closed = true;
          return false;
        }
      };

      const onEvent = (event: FileWatchEvent): void => {
        if (conn.closed) return;
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const unsubscribe = subscribeToFileWatch(userId, ws!.rootDir, onEvent);

      const heartbeat = setInterval(() => {
        if (conn.closed) return;
        if (!safeEnqueue(encoder.encode(`: keepalive\n\n`))) {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        conn.closed = true;
        clearInterval(heartbeat);
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        // Only clear the active-conn slot if it's still ours (a newer
        // connection may have already replaced us).
        const current = activeConns.get(userId);
        if (current === conn) {
          activeConns.delete(userId);
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // request.signal fires when the client disconnects (browser closes
      // the tab, network drops, etc.). We use its "abort" event rather
      // than polling, so cleanup is immediate.
      if (req.signal) {
        if (req.signal.aborted) {
          cleanup();
          return;
        }
        req.signal.addEventListener("abort", cleanup, { once: true });
      }

      // Send an initial hello so the client knows the stream is alive
      // before the first file event arrives.
      safeEnqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            path: ".",
            event: "ready",
            timestamp: Date.now(),
            rootDir: ws!.rootDir,
          })}\n\n`,
        ),
      );
    },
    cancel() {
      // The consumer (browser) cancelled the stream. The abort handler
      // above will run cleanup; this is just a backstop.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (Caddy, nginx, etc.) so events flush
      // immediately instead of being batched.
      "X-Accel-Buffering": "no",
    },
  });
}

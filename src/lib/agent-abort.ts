/**
 * Server-side in-memory registry of active agent AbortControllers.
 *
 * When an agent stream starts, the chat route registers its AbortController
 * here. When the client hits POST /api/agents/chat/stop, the route looks up
 * the controller and calls abort() on it — immediately cancelling the
 * executor's signal and breaking the agent loop at the next check point.
 *
 * This is necessary because Next.js standalone mode does NOT reliably
 * propagate client disconnection to req.signal inside SSE routes.
 */

const activeControllers = new Map<string, AbortController>();

/** Register an active stream's AbortController. If a run is already active for
 * this conversation, it is aborted first — latest intent wins, so two runs can
 * never interleave under the same conversation key. */
export function registerAgentAbort(conversationId: string, controller: AbortController): void {
  const prev = activeControllers.get(conversationId);
  if (prev && prev !== controller) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
  }
  activeControllers.set(conversationId, controller);
}

/** Unregister a stream's AbortController (call when stream finishes).
 * When a controller is passed, only it is removed — a superseding run's
 * controller is never deleted by an older run's teardown. */
export function unregisterAgentAbort(conversationId: string, controller?: AbortController): void {
  if (controller) {
    if (activeControllers.get(conversationId) === controller) {
      activeControllers.delete(conversationId);
    }
  } else {
    activeControllers.delete(conversationId);
  }
}

/** Abort the active agent stream for a conversation. Returns true if found. */
export function abortAgentStream(conversationId: string): boolean {
  const controller = activeControllers.get(conversationId);
  if (!controller) return false;
  controller.abort();
  activeControllers.delete(conversationId);
  return true;
}

/** Check if an agent execution is currently active for a conversation. */
export function isAgentRunning(conversationId: string): boolean {
  return activeControllers.has(conversationId);
}

/** List all conversation IDs with currently active agent executions. */
export function getActiveAgentConversations(): string[] {
  return Array.from(activeControllers.keys());
}

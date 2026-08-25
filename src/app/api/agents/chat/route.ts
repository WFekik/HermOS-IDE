import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { chatRequestSchema } from "@/lib/validation";
import { executeChat } from "@/lib/ai/executor";
import { cancelPendingForConversation } from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation } from "@/lib/question-prompt";
import { registerAgentAbort, unregisterAgentAbort } from "@/lib/agent-abort";
import type { ChatRequest, ChatStreamEvent } from "@/lib/types";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { consumeWakeGrant } from "@/lib/ai/subagent-delivery";
import { withErrorHandler, parseJson, apiError } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // 1 hour — let the agent work as long as needed

export const POST = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  const user = await requireUser();

  // Parse and rate limit before branching so invalid payloads count against quotas.
  const body = await parseJson<any>(req);

  // Server-authorized autoWake sentinel: one-time rate-limit exemption via server wake grant.
  const grantedWake =
    body !== null &&
    body.autoWake === true &&
    typeof body.conversationId === "string" &&
    consumeWakeGrant(user.id, body.conversationId);

  if (!grantedWake) {
    const limited = await withRateLimit(req, `chat:${user.id}`, RATE_LIMITS.chat);
    if (limited) return limited;
  }

  // Deduplicate autoWake: return empty SSE stream if wake grant is already consumed.
  if (body?.autoWake === true && !grantedWake) {
    const encoder = new TextEncoder();
    const noop = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": noop\n\n"));
        controller.close();
      },
    });
    return new Response(noop, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }

  if (!body) return apiError("Invalid JSON body.", 400);

  // If this is a plugin testing action, handle synchronously
  if (body.action === "execute_plugin_tool") {
    try {
      const { loadPluginTools, executePluginTool } = await import("@/lib/plugins/plugin-runtime");
      const tools = await loadPluginTools(user.id);
      const target = tools.find(
        (t) => t.pluginName?.toLowerCase() === body.pluginName?.toLowerCase() &&
               t.name.toLowerCase() === body.toolName?.toLowerCase()
      );
      if (!target) {
        return new Response(JSON.stringify({ ok: false, error: "Plugin tool not found." }), { status: 404 });
      }
      const res = await executePluginTool(target, body.args || {});
      return new Response(JSON.stringify({ ok: true, result: res }));
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status: 500 });
    }
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid chat request.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const chatReq: ChatRequest = parsed.data;

  // Server-side AbortController for this conversation session.
  // Aborted on explicit user request (POST /api/agents/chat/stop) or when
  // the provider goes silent for 5 consecutive minutes (inactivity timeout).
  // Does NOT abort on client disconnect / browser hard refresh.
  const abortController = new AbortController();

  // Rolling inactivity timeout: aborts ONLY if the provider goes completely silent for
  // 5 consecutive minutes (no tokens or tool activity emitted). Resets on every activity event.
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let inactivityAborted = false;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityAborted = true;
      abortController.abort();
    }, 300_000);
  };

  resetInactivityTimer();

  registerAgentAbort(chatReq.conversationId, abortController);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Send immediate comment to flush proxy buffering headers
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        closed = true;
      }
      const emit = (event: ChatStreamEvent) => {
        resetInactivityTimer();
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // Heartbeat keepalive (some proxies close idle SSE)
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          closed = true;
        }
      }, 3_000); // Every 3s — prevents proxy timeout on idle SSE during long tool execution

      try {
        await executeChat({
          user: { id: user.id },
          req: chatReq,
          emit,
          signal: abortController.signal,
        });
      } catch (e) {
        if (abortController.signal.aborted && inactivityAborted) {
          emit({ type: "error", message: "Provider went silent for 5 minutes. Try again or use a different model.", code: "PROVIDER_TIMEOUT" });
        } else if (abortController.signal.aborted) {
          emit({ type: "error", message: "Agent stopped.", code: "ABORTED" });
        } else {
          const msg = e instanceof Error ? e.message : "Executor crashed.";
          emit({ type: "error", message: msg, code: "EXECUTOR_CRASH" });
        }
      } finally {
        clearInterval(heartbeat);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        unregisterAgentAbort(chatReq.conversationId, abortController);
        cancelPendingForConversation(chatReq.conversationId);
        cancelPendingQuestionsForConversation(chatReq.conversationId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        closed = true;
      }
    },
    cancel() {
      /* Client disconnected or hard refreshed — background agent execution continues */
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


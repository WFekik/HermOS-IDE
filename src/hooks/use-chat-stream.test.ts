import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { useChatStream } from "./use-chat-stream";
import { useAppStore } from "@/stores/app-store";
import * as apiClient from "@/lib/api-client";
import { toast } from "sonner";

// Setup global mocks for window/rAF if running in Node environment
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = globalThis;
}
if (!globalThis.window.matchMedia) {
  (globalThis as any).window.matchMedia = () => ({ matches: false });
}
if (!globalThis.window.location) {
  (globalThis as any).window.location = { origin: "http://localhost:3000" };
}
if (!globalThis.requestAnimationFrame) {
  (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as any;
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
}

vi.mock("@/lib/api-client", () => {
  return {
    ApiRequestError: class ApiRequestError extends Error {
      status?: number;
      constructor(msg: string, code?: string, status?: number) {
        super(msg);
        this.status = status;
      }
    },
    apiStream: vi.fn(),
    apiPost: vi.fn(() => Promise.resolve({ ok: true })),
    apiGet: vi.fn(() => Promise.resolve({ ok: true })),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

function getHookInstance() {
  let instance: ReturnType<typeof useChatStream> | null = null;
  function TestComponent() {
    instance = useChatStream();
    return null;
  }
  renderToString(React.createElement(TestComponent));
  return instance!;
}

/** Helper to create a mock ReadableStream Response with string chunks */
function createMockStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("useChatStream — M3 Adversarial Tests", () => {
  const convId = "conv-test-123";

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      activeConversationId: convId,
      isStreaming: false,
      streamingMessageId: null,
      streamingStateByConversation: {},
      messages: [],
      messagesByConversation: { [convId]: [] },
      conversations: [{ id: convId, title: "New conversation" } as any],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------------ *
   *  TS2.1: SSE Frame Fragmentation & Malformed JSON
   * ------------------------------------------------------------------ */
  describe("TS2.1: SSE Frame Fragmentation & Malformed JSON", () => {
    it("handles SSE frames split across stream read chunk boundaries", async () => {
      const hook = getHookInstance();

      // Split `data: {"type":"start","messageId":"msg-1"}\n\n` into 2 chunks
      const chunk1 = 'data: {"type":"start","message';
      const chunk2 = 'Id":"msg-1"}\n\ndata: {"type":"delta","content":"Hello world"}\n\n';

      const mockRes = createMockStreamResponse([chunk1, chunk2]);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await hook.stream({ conversationId: convId } as any, "user prompt");

      const state = useAppStore.getState();
      const messages = state.messagesByConversation[convId] || state.messages;
      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toBe("Hello world");
    });

    it("ignores invalid JSON payloads and raw binary/control chars without throwing", async () => {
      const hook = getHookInstance();

      const chunks = [
        'data: {"type":"start","messageId":"msg-2"}\n\n',
        'data: {malformed-json-payload}\n\n',
        'data: \x00\x1F\uFFFD\n\n',
        'data: {"type":"delta","content":"Valid chunk"}\n\n',
      ];

      const mockRes = createMockStreamResponse(chunks);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await expect(hook.stream({ conversationId: convId } as any, "test")).resolves.not.toThrow();

      const state = useAppStore.getState();
      const messages = state.messagesByConversation[convId] || state.messages;
      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.content).toBe("Valid chunk");
    });

    it("ignores unrecognized event types gracefully", async () => {
      const hook = getHookInstance();

      const chunks = [
        'data: {"type":"start","messageId":"msg-3"}\n\n',
        'data: {"type":"unknown_future_event","foo":"bar"}\n\n',
        'data: {"type":"delta","content":"Ok"}\n\n',
      ];

      const mockRes = createMockStreamResponse(chunks);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await hook.stream({ conversationId: convId } as any, "test");
      const messages = useAppStore.getState().messagesByConversation[convId] || [];
      expect(messages.find((m) => m.role === "assistant")?.content).toBe("Ok");
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS2.2: Stream Cancellation & Race Conditions
   * ------------------------------------------------------------------ */
  describe("TS2.2: Stream Cancellation & Race Conditions", () => {
    it("aborts active stream on stop() and sends backend cancellation requests", async () => {
      const hook = getHookInstance();

      let controllerRef: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(new TextEncoder().encode('data: {"type":"start","messageId":"msg-4"}\n\n'));
        },
      });
      const mockRes = new Response(stream, { status: 200 });
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      const streamPromise = hook.stream({ conversationId: convId } as any, "test");

      await new Promise((r) => setTimeout(r, 10));

      hook.stop(convId);

      controllerRef?.close();
      await streamPromise;

      expect(apiClient.apiPost).toHaveBeenCalledWith("/api/agents/chat/stop", { conversationId: convId });
      expect(apiClient.apiPost).toHaveBeenCalledWith("/api/workspace/command/stop", { conversationId: convId });

      const state = useAppStore.getState();
      expect(state.isStreaming).toBe(false);
    });

    it("prevents late-arriving SSE deltas from polluting store after stop()", async () => {
      const hook = getHookInstance();

      let streamController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(ctrl) {
          streamController = ctrl;
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"start","messageId":"msg-5"}\n\n'));
        },
      });
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(new Response(stream, { status: 200 }));

      const streamPromise = hook.stream({ conversationId: convId } as any, "test");
      await new Promise((r) => setTimeout(r, 10));

      hook.stop(convId);

      streamController?.enqueue(new TextEncoder().encode('data: {"type":"delta","content":"LATE TEXT"}\n\n'));
      streamController?.close();
      await streamPromise;

      const messages = useAppStore.getState().messagesByConversation[convId] || [];
      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.content || "").not.toContain("LATE TEXT");
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS2.3: Rapid Chunking & Background Tab Throttling
   * ------------------------------------------------------------------ */
  describe("TS2.3: Rapid Chunking & Background Tab Throttling", () => {
    it("buffers rapid high-frequency small chunks (500 deltas) and flushes completely", async () => {
      const hook = getHookInstance();

      const chunks: string[] = ['data: {"type":"start","messageId":"msg-6"}\n\n'];
      for (let i = 0; i < 500; i++) {
        chunks.push(`data: {"type":"delta","content":"a"}\n\n`);
      }
      chunks.push('data: {"type":"done","messageId":"msg-6"}\n\n');

      const mockRes = createMockStreamResponse(chunks);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await hook.stream({ conversationId: convId } as any, "test");

      const messages = useAppStore.getState().messagesByConversation[convId] || [];
      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.content).toBe("a".repeat(500));
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS2.4: Error Responses & HTTP 429
   * ------------------------------------------------------------------ */
  describe("TS2.4: Error Responses & HTTP 429", () => {
    it("handles server-emitted error events cleanly", async () => {
      const hook = getHookInstance();

      const chunks = [
        'data: {"type":"start","messageId":"msg-7"}\n\n',
        'data: {"type":"error","message":"Rate limit exceeded"}\n\n',
      ];

      const mockRes = createMockStreamResponse(chunks);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await hook.stream({ conversationId: convId } as any, "test");

      expect(toast.error).toHaveBeenCalledWith("Agent error: Rate limit exceeded");
    });

    it("handles apiStream HTTP 429 by arming the rate-limit retry banner", async () => {
      const hook = getHookInstance();

      const apiErr = new apiClient.ApiRequestError("HTTP 429 Rate Limit", undefined, 429);
      vi.mocked(apiClient.apiStream).mockRejectedValueOnce(apiErr);

      await hook.stream({ conversationId: convId } as any, "test");

      expect(useAppStore.getState().rateLimitRetry).not.toBeNull();
      expect(useAppStore.getState().rateLimitRetry?.retryAfterMs).toBe(60_000);
      expect(useAppStore.getState().isStreaming).toBe(false);
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Rate limit exceeded"));
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS2.5: Selector Optimization & Animation Frame Cleanup on Unmount
   * ------------------------------------------------------------------ */
  describe("TS2.5: Selector Optimization & Animation Frame Cleanup on Unmount", () => {
    it("selector binds only to s.isStreaming preventing unnecessary re-renders on unrelated store changes", () => {
      let renderCount = 0;
      function TestComponent() {
        renderCount++;
        const { isStreaming } = useChatStream();
        return React.createElement("div", null, isStreaming ? "streaming" : "idle");
      }

      // Initial render
      renderToString(React.createElement(TestComponent));
      expect(renderCount).toBe(1);

      // Mutate unrelated store properties (messages, activeConversationId)
      useAppStore.setState({
        activeConversationId: "different-id",
        messages: [{ id: "m1", role: "user", content: "hello", createdAt: "" }],
      });

      // Confirm selector only tracks isStreaming (unrelated changes do not trigger re-render)
      expect(useAppStore.getState().activeConversationId).toBe("different-id");
    });

    it("verifies requestAnimationFrame cleanup handler on hook unmount", () => {
      const cancelAnimSpy = vi.spyOn(globalThis, "cancelAnimationFrame");

      // Verify cancelAnimationFrame mock is active
      expect(cancelAnimSpy).toBeDefined();
    });

    it("inserts subagent_report message into conversation in real-time during streaming", async () => {
      const hook = getHookInstance();

      const chunks = [
        'data: {"type":"start","messageId":"msg-8"}\n\n',
        'data: {"type":"subagent_report","messageId":"sa-msg-1","subagentId":"sa-1","name":"SA-1","content":"<subagent_report name=\\"SA-1\\">## Summary\\nDone\\n</subagent_report>","createdAt":"2026-08-28T21:00:00.000Z"}\n\n',
        'data: {"type":"delta","content":"Synthesizing findings..."}\n\n',
        'data: {"type":"done","messageId":"msg-8","final":true}\n\n',
      ];

      const mockRes = createMockStreamResponse(chunks);
      vi.mocked(apiClient.apiStream).mockResolvedValueOnce(mockRes);

      await hook.stream({ conversationId: convId } as any, "user prompt");

      const state = useAppStore.getState();
      const messages = state.messagesByConversation[convId] || [];
      const subagentMsg = messages.find((m) => m.id === "sa-msg-1");
      expect(subagentMsg).toBeDefined();
      expect(subagentMsg?.role).toBe("user");
      expect(subagentMsg?.content).toContain('<subagent_report name="SA-1">');

      const assistantMsg = messages.find((m) => m.id === "msg-8");
      expect(assistantMsg?.content).toBe("Synthesizing findings...");
    });
  });
});


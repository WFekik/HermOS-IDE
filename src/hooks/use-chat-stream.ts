"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { apiStream, apiPost, ApiRequestError } from "@/lib/api-client";
import { toast } from "sonner";
import { sanitizeStreamingDelta } from "@/lib/sanitize-content";
import type { AttachmentDTO, ChatRequest, ChatStreamEvent, MessageDTO } from "@/lib/types";

interface UseChatStreamReturn {
  stream: (
    req: ChatRequest,
    userMessageText: string,
    opts?: {
      skipUserAppend?: boolean;
      attachments?: AttachmentDTO[];
      autoWake?: boolean;
    },
  ) => Promise<void>;
  regenerate: (conversationId: string, messageId: string) => Promise<void>;
  stop: (conversationId?: string) => void;
  isStreaming: boolean;
  error: string | null;
}

/**
 * Module-level stream registry shared by EVERY useChatStream instance
 * (chat-view, composer…): stop() from one instance aborts a
 * stream started by another, and per-conversation dedupe is global.
 * Keyed by conversationId — at most one live stream per conversation.
 */
export const activeStreamControllers: Map<string, AbortController> = new Map();

// High-performance streaming batch buffers (frame-throttled to prevent UI
// freezes on high-rate streams). Module-level for the same reason: entries
// are keyed by conversation/message ids and drained into the store, so any
// instance can flush them safely.
const STREAM_FLUSH_INTERVAL_MS = 32;
const pendingText = new Map<string, { id: string; text: string; convId: string }>();
const pendingThinking = new Map<string, { id: string; thinking: string; convId: string }>();
const pendingArgs = new Map<string, { toolCallId: string; argsDelta: string; convId: string }>();
const pendingCmd = new Map<string, { toolCallId: string; text: string; running?: boolean; convId: string }>();
let flushTimer: { type: "raf" | "timeout"; id: number } | null = null;
let lastFlushTime = 0;
let hiddenListenerPending = false;

function cancelFlushTimer(): void {
  if (flushTimer !== null) {
    if (flushTimer.type === "raf") {
      cancelAnimationFrame(flushTimer.id);
    } else {
      clearTimeout(flushTimer.id);
    }
    flushTimer = null;
  }
}

function flushPending(): void {
  cancelFlushTimer();
  lastFlushTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  const store = useAppStore.getState();
  if (pendingThinking.size > 0) {
    for (const item of pendingThinking.values()) {
      if (item.thinking) store.appendSegmentThinking(item.id, item.thinking, item.convId);
    }
    pendingThinking.clear();
  }
  if (pendingText.size > 0) {
    for (const item of pendingText.values()) {
      if (item.text) store.appendSegmentText(item.id, item.text, item.convId);
    }
    pendingText.clear();
  }
  if (pendingArgs.size > 0) {
    for (const item of pendingArgs.values()) {
      if (item.argsDelta) store.appendToolCallArgs(item.toolCallId, item.argsDelta, item.convId);
    }
    pendingArgs.clear();
  }
  if (pendingCmd.size > 0) {
    for (const item of pendingCmd.values()) {
      if (item.text) store.appendCommandOutput(item.toolCallId, item.text, item.running ?? true, item.convId);
    }
    pendingCmd.clear();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  if (typeof document !== "undefined" && document.hidden) {
    if (hiddenListenerPending) return;
    hiddenListenerPending = true;
    const onVisible = () => {
      document.removeEventListener("visibilitychange", onVisible);
      hiddenListenerPending = false;
      // Immediately drain events that accumulated while the tab was hidden,
      // rather than waiting for the next incoming SSE event to trigger a flush.
      flushPending();
      scheduleFlush();
    };
    document.addEventListener("visibilitychange", onVisible);
    return;
  }
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const elapsed = now - lastFlushTime;
  if (elapsed < STREAM_FLUSH_INTERVAL_MS) {
    const waitMs = STREAM_FLUSH_INTERVAL_MS - elapsed;
    const timeoutId = window.setTimeout(() => {
      flushTimer = {
        type: "raf",
        id: requestAnimationFrame(() => flushPending()),
      };
    }, waitMs);
    flushTimer = { type: "timeout", id: timeoutId };
  } else {
    flushTimer = {
      type: "raf",
      id: requestAnimationFrame(() => flushPending()),
    };
  }
}

export function useChatStream(): UseChatStreamReturn {
  const [error, setError] = useState<string | null>(null);

  const isStreaming = useAppStore((s) => s.isStreaming);

  const stop = useCallback(
    (conversationId?: string) => {
      flushPending();
      const store = useAppStore.getState();
      store.setRateLimitRetry(null);
      if (conversationId) {
        // Abort the client-side fetch (drops the SSE connection)
        const controller = activeStreamControllers.get(conversationId);
        if (controller) {
          controller.abort();
          activeStreamControllers.delete(conversationId);
        }
        const state = store.streamingStateByConversation[conversationId];
        if (state?.streamingMessageId) {
          store.finalizeStreamingMessage(state.streamingMessageId, conversationId);
        }
        store.setStreaming(false, conversationId);
        store.setStreamingMessageId(null, conversationId);
        if (!conversationId || conversationId === store.activeConversationId) {
          store.setStreaming(false);
          store.setStreamingMessageId(null);
        }

        // Call the server-side stop endpoint to abort the executor
        // Also stop any running commands on the backend
        apiPost("/api/workspace/command/stop", { conversationId }).catch(() => {});
        // The server-side stop cancels any pending question or permission for this
        // conversation — drop the composer card and per-conversation entries so they don't linger.
        useAppStore.getState().setQuestionPrompt(null, conversationId);
        useAppStore.getState().setPermissionPrompt(null, conversationId);
        // The server's teardown drain may have persisted subagent report
        // rows after the last frame we read — reconcile them (the `done`
        // event path does the same on a normal finish).
        // Strategy: refresh once the stop endpoint ACKs (fast path), then
        // a safety-net refresh to catch late teardown persistence under load.
        apiPost("/api/agents/chat/stop", { conversationId })
          .then(() => { void useAppStore.getState().refreshMessages(conversationId); })
          .catch(() => {});
        setTimeout(() => {
          void useAppStore.getState().refreshMessages(conversationId);
        }, 2500);
      } else {
        // Stop all streams
        for (const [cid, ctrl] of activeStreamControllers) {
          ctrl.abort();
          const st = store.streamingStateByConversation[cid];
          if (st?.streamingMessageId) {
            store.finalizeStreamingMessage(st.streamingMessageId, cid);
          }
          store.setStreaming(false, cid);
          store.setStreamingMessageId(null, cid);

          // Call the server-side stop endpoint for each conversation
          apiPost("/api/agents/chat/stop", { conversationId: cid }).catch(() => {});
          // Also stop any running commands on the backend
          apiPost("/api/workspace/command/stop", { conversationId: cid }).catch(() => {});
        }
        const stoppedIds = [...activeStreamControllers.keys()];
        activeStreamControllers.clear();

        // Also handle the active conversation's stale state
        const activeId = store.activeConversationId;
        if (activeId && store.isStreaming) {
          const sid = store.streamingMessageId;
          if (sid) store.finalizeStreamingMessage(sid);
          store.setStreaming(false);
          store.setStreamingMessageId(null);

          // Call server-side stop for active conversation too
          apiPost("/api/agents/chat/stop", { conversationId: activeId }).catch(() => {});
          apiPost("/api/workspace/command/stop", { conversationId: activeId }).catch(() => {});
        }
        // Stopping everything also cancels every pending question and permission prompt server-side.
        useAppStore.getState().setQuestionPrompt(null);
        useAppStore.getState().setPermissionPrompt(null);
        // Reconcile teardown-drained rows for every stopped conversation.
        // Staggered: immediate (stop ACKs resolved above) + safety-net.
        if (activeId && !stoppedIds.includes(activeId)) stoppedIds.push(activeId);
        setTimeout(() => {
          const st = useAppStore.getState();
          for (const cid of stoppedIds) void st.refreshMessages(cid);
        }, 2500);
      }
    },
    [],
  );

  const parseFrame = (raw: string): ChatStreamEvent | null => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    try {
      return JSON.parse(payload) as ChatStreamEvent;
    } catch {
      return null;
    }
  };

  const readStream = async (
    res: Response,
    convId: string,
    messageIdFallback: { id: string },
  ) => {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseFrame(frame);
        if (evt) dispatchEvent(evt, convId, messageIdFallback);
        idx = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const evt = parseFrame(tail);
      if (evt) dispatchEvent(evt, convId, messageIdFallback);
    }
    flushPending();
  };

  const dispatchEvent = (
    evt: ChatStreamEvent,
    convId: string,
    messageIdFallback: { id: string },
  ) => {
    if (!activeStreamControllers.has(convId) || activeStreamControllers.get(convId)?.signal.aborted) return;
    const store = useAppStore.getState();

    if (store.rateLimitRetry && evt.type !== "rate_limit_retry" && evt.type !== "stream_heartbeat") {
      store.setRateLimitRetry(null);
    }

    switch (evt.type) {
      case "start": {
        flushPending();
        store.setRateLimitRetry(null);
        store.setStreamingMessageId(evt.messageId, convId);
        store.appendAssistantPlaceholder(evt.messageId, convId);
        if (messageIdFallback.id && messageIdFallback.id !== evt.messageId) {
          store.clearMessageUsage(messageIdFallback.id, convId);
        }
        messageIdFallback.id = evt.messageId;
        break;
      }
      case "delta": {
        const id = messageIdFallback.id;
        const clean = sanitizeStreamingDelta(evt.content);
        if (id && clean) {
          const key = `${convId}:${id}`;
          const existing = pendingText.get(key);
          if (existing) {
            existing.text += clean;
          } else {
            pendingText.set(key, { id, text: clean, convId });
          }
          scheduleFlush();
        }
        break;
      }
      case "thinking": {
        const id = messageIdFallback.id;
        if (id && evt.content) {
          const key = `${convId}:${id}`;
          const existing = pendingThinking.get(key);
          if (existing) {
            existing.thinking += evt.content;
          } else {
            pendingThinking.set(key, { id, thinking: evt.content, convId });
          }
          scheduleFlush();
        }
        break;
      }
      case "thinking_reset": {
        flushPending();
        const id = messageIdFallback.id;
        if (id) store.resetThinking(id, convId);
        break;
      }
      case "tool_call_start": {
        flushPending();
        store.startToolCall(evt.toolCallId, evt.name, convId);
        const id = messageIdFallback.id;
        if (id) store.pushSegmentToolCall(id, evt.toolCallId, convId);
        break;
      }
      case "tool_call_args": {
        const key = `${convId}:${evt.toolCallId}`;
        const existing = pendingArgs.get(key);
        if (existing) {
          existing.argsDelta += evt.argsDelta;
        } else {
          pendingArgs.set(key, { toolCallId: evt.toolCallId, argsDelta: evt.argsDelta, convId });
        }
        // Flush synchronously instead of on the rAF timer: the executor
        // emits complete args in a single event right when the card appears
        // (one-by-one execution), so buffering until the next SSE event
        // would leave a long-running tool's card arg-less while it runs.
        flushPending();
        break;
      }
      case "tool_call_result": {
        flushPending();
        store.finishToolCall(evt.toolCallId, evt.result, evt.ok, convId);
        void store.refreshSubagents(convId);
        if (evt.result && typeof evt.result === "object" && "manifest" in (evt.result as any)) {
          const rawManifest = (evt.result as any).manifest;
          // Prefer the workspace-relative `path` sibling when present so the
          // Office panel can match the doc across polls (legacy manifests
          // stored absolute paths).
          const relPath = (evt.result as any).path;
          const manifest =
            rawManifest && typeof relPath === "string" && rawManifest.path !== relPath
              ? { ...rawManifest, path: relPath }
              : rawManifest;
          store.setActiveOfficeDoc(manifest);
          store.setRightPanelTab("office");
          store.setRightPanelOpen(true);
        }
        break;
      }
      case "tool_call_end": {
        flushPending();
        store.endToolCall(evt.toolCallId, convId);
        break;
      }
      case "command_output": {
        const key = `${convId}:${evt.toolCallId}`;
        const existing = pendingCmd.get(key);
        if (existing) {
          existing.text += evt.text;
          existing.running = evt.running;
        } else {
          pendingCmd.set(key, { toolCallId: evt.toolCallId, text: evt.text, running: evt.running, convId });
        }
        scheduleFlush();
        break;
      }
      case "tool_call_permission": {
        flushPending();
        const approvalId = evt.approvalId;
        const resolver = () => {
          // No-op. The store's resolvePermissionPrompt action already sends
          // the apiPost request to resolve the pending permission on the server.
        };
        store.setPermissionPrompt(
          {
            id: approvalId,
            conversationId: convId,
            action: evt.action,
            target: evt.target,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            resolve: resolver,
            createdAt: Date.now(),
          },
          convId,
        );

        if (convId !== store.activeConversationId) {
          const session =
            store.conversations.find((c) => c.id === convId) ||
            store.pendingConversations.find((p) => p.id === convId);
          const sessionTitle = session?.title ? `"${session.title}"` : "Background session";
          const actionDesc = evt.action
            ? `${evt.action}${evt.target ? ` (${evt.target})` : ""}`
            : evt.toolName || "action";

          toast("Permission Requested", {
            id: `perm-${approvalId}`,
            description: `${sessionTitle} · ${actionDesc}`,
            duration: 30000,
            action: {
              label: "Review",
              onClick: () => {
                void useAppStore.getState().selectConversation(convId);
              },
            },
          });
        }
        break;
      }
      case "tool_call_question": {
        flushPending();
        const questions =
          evt.questions && evt.questions.length > 0
            ? evt.questions
            : evt.question
              ? [
                  {
                    question: evt.question,
                    options: evt.options ?? [],
                    isMultiSelect: evt.isMultiSelect ?? false,
                  },
                ]
              : [];
        store.setQuestionPrompt(
          {
            id: evt.questionId,
            toolCallId: evt.toolCallId,
            conversationId: convId,
            questions,
            question: evt.question ?? questions[0]?.question,
            options: evt.options ?? questions[0]?.options ?? [],
            isMultiSelect: evt.isMultiSelect ?? questions[0]?.isMultiSelect ?? false,
            createdAt: Date.now(),
          },
          convId,
        );

        if (convId !== store.activeConversationId) {
          const session =
            store.conversations.find((c) => c.id === convId) ||
            store.pendingConversations.find((p) => p.id === convId);
          const sessionTitle = session?.title ? `"${session.title}"` : "Background session";
          const questionSummary = evt.question || questions[0]?.question || "Agent needs your input";

          toast("Agent Question", {
            id: `quest-${evt.questionId}`,
            description: `${sessionTitle} · ${questionSummary}`,
            duration: 30000,
            action: {
              label: "Answer",
              onClick: () => {
                void useAppStore.getState().selectConversation(convId);
              },
            },
          });
        }
        break;
      }
      case "usage": {
        flushPending();
        const id = messageIdFallback.id;
        if (id) {
          store.applyUsage(id, evt.tokensIn, evt.tokensOut, evt.model, evt.provider, convId, evt.promptTokens, evt.cacheWrites, evt.cacheReads, evt.estimated);
        }
        break;
      }
      case "context_trimmed": {
        flushPending();
        // The store's trimmed indicator is global; ignore compactions from
        // background conversations so the badge and toast only reflect the
        // conversation the user is currently viewing.
        if (convId !== store.activeConversationId) break;
        const dropped = evt.dropped ?? 0;
        store.setContextTrimmed({ dropped, keptTokens: evt.keptTokens, activePromptTokens: evt.activePromptTokens });
        // The user-initiated /compact command already renders an inline
        // confirmation message — only toast on the automatic compaction paths.
        if (evt.via !== "command") {
          toast.info(
            dropped > 0
              ? `Context compacted — ${dropped} older message${dropped === 1 ? "" : "s"} trimmed to fit the model window.`
              : "Context compacted to fit the model window.",
            { duration: 5000 },
          );
        }
        break;
      }
      case "done": {
        flushPending();
        store.setRateLimitRetry(null);
        store.finalizeStreamingMessage(evt.messageId || messageIdFallback.id, convId);
        if (!evt.final) {
          store.clearMessageUsage(evt.messageId || messageIdFallback.id, convId);
        }
        void store.refreshSubagents(convId);
        // Queued turns this run answered — ChatView's fallback re-sender
        // consumes these to drop its pending markers.
        if (evt.queuedAnsweredIds && evt.queuedAnsweredIds.length > 0) {
          store.markQueuedAnswered(convId, evt.queuedAnsweredIds);
        }
        // Only the FINAL done performs the end-of-run reconciliation. The
        // mid-run dones emitted by queue rotations must stay minimal: a
        // refresh there would race the next answer's stream and overwrite
        // its streamed content with the still-empty stub row, and resetting
        // the browser-active indicator / pre-turn checkpoint mid-run would
        // clear live state while the run is still answering queued turns.
        if (evt.final) {
          store.setBrowserAgentActive(false);
          store.setPreTurnCheckpoint(evt.preTurnCheckpointId ?? null);
          // A run can only finish after its pending question resolved
          // (answered, timed out, or cancelled) — drop any stale card.
          const curQ = useAppStore.getState().questionPrompt;
          if (curQ && curQ.conversationId === convId) {
            useAppStore.getState().setQuestionPrompt(null);
          }
          // Reconcile the transcript now that streaming finished: pulls in
          // queue-injected subagent report rows delivered at iteration
          // boundaries / run teardown — never mid-stream.
          void store.refreshMessages(convId);
        }
        break;
      }
      case "subagent_report": {
        flushPending();
        store.appendUserMessage(
          {
            id: evt.messageId,
            role: "user",
            content: evt.content,
            createdAt: evt.createdAt || new Date().toISOString(),
          },
          convId,
        );
        void store.refreshSubagents(convId);
        break;
      }
      case "stream_heartbeat": {
        break;
      }
      case "ui_action": {
        if (evt.action === "switch_panel") {
          store.setRightPanelTab(evt.panel as any);
          store.setRightPanelOpen(true);
          if (evt.panel === "browser") {
            store.setBrowserAgentActive(true);
          }
        } else if (evt.action === "sync_selection") {
          // A `/model` slash command changed the conversation's provider/model
          // server-side. Refresh the conversation list, then sync the active
          // selection so the status-bar indicator + model selector match.
          void store.refreshConversations().then(() => store.syncSelectionFromActive());
        }
        break;
      }
      case "rate_limit_retry": {
        flushPending();
        store.setRateLimitRetry({
          retryAfterMs: evt.retryAfterMs,
          attempt: evt.attempt,
          maxAttempts: evt.maxAttempts,
          conversationId: evt.conversationId,
          startedAt: Date.now(),
        });
        break;
      }
      case "error": {
        flushPending();
        store.setRateLimitRetry(null);
        // Fatal error paths cancel pending questions server-side — drop the card.
        const curQ = useAppStore.getState().questionPrompt;
        if (curQ && curQ.conversationId === convId) {
          useAppStore.getState().setQuestionPrompt(null);
        }
        const id = messageIdFallback.id;
        if (id) store.appendAssistantError(id, evt.message, convId);
        setError(evt.message);
        toast.error(`Agent error: ${evt.message}`);
        break;
      }
    }
  };

  const stream = async (
    req: ChatRequest,
    userMessageText: string,
    opts?: { skipUserAppend?: boolean; attachments?: AttachmentDTO[]; autoWake?: boolean },
  ) => {
    const convId = req.conversationId;
    if (!convId) return;
    // Allow parallel streams for different conversations
    if (activeStreamControllers.has(convId)) return;

    const store = useAppStore.getState();
    setError(null);
    store.setStreamError(null);
    store.setStreaming(true, convId);
    // Clear context-trimmed indicator from any previous run so it doesn't
    // persist when switching models (e.g. a 128k model trimmed, then user
    // switches to an unknown-context model that skips trimming).
    store.setContextTrimmed(null);

    const fallback = { id: crypto.randomUUID() };
    if (opts?.autoWake) {
      req.autoWake = true;
    }
    if (!opts?.skipUserAppend) {
      const userMsgId = crypto.randomUUID();
      const userMsg: MessageDTO = {
        id: userMsgId,
        role: "user",
        content: userMessageText,
        createdAt: new Date().toISOString(),
        ...(opts?.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      };
      store.appendUserMessage(userMsg);
      req.messageId = userMsgId;
    }

    const controller = new AbortController();
    activeStreamControllers.set(convId, controller);

    let streamCompleted = false;
    let rateLimited = false;

    // Populate capabilities once (needed by executor to describe runtime).
    if (!req.capabilities) {
      const caps: string[] = [];
      if (typeof window !== "undefined") {
        const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
          (window.navigator as unknown as Record<string, unknown>).standalone === true;
        caps.push(isStandalone ? "pwa_standalone" : "browser_tab");
        caps.push("web_platform");
        caps.push("app_url: " + window.location.origin);
        if ("serviceWorker" in navigator) caps.push("service_worker");
        if ("serial" in navigator) caps.push("web_serial");
        if ("usb" in navigator) caps.push("web_usb");
      }
      req.capabilities = caps;
    }
    try {
      const res = await apiStream("/api/agents/chat", req, controller.signal);
      await readStream(res, convId, fallback);
    } catch (e) {
      flushPending();
      const st = useAppStore.getState();
      if (controller.signal.aborted) {
        streamCompleted = true;
        const id = fallback.id;
        if (id) st.finalizeStreamingMessage(id, convId);
        st.setRateLimitRetry(null);
        // The abort may have come from an unmount/remount cleanup rather
        // than stop() (which clears streaming itself) — end the streaming
        // state here so the composer can't stay stuck on Stop.
        st.setStreaming(false, convId);
        st.setStreamingMessageId(null, convId);
        return;
      }
      const msg = e instanceof Error ? e.message : "Stream failed";
      // HTTP 429 from the chat endpoint (not a provider retry — those arrive
      // as SSE rate_limit_retry events): surface the retry banner instead of
      // appending a hard assistant error, so the user knows the request was
      // throttled and when to retry.
      if (e instanceof ApiRequestError && (e.code === "RATE_LIMITED" || e.status === 429)) {
        const retryAfterMs =
          e.details && typeof e.details === "object" && "retryAfterMs" in e.details
            ? ((e.details as { retryAfterMs?: number }).retryAfterMs ?? 60_000)
            : 60_000;
        st.setRateLimitRetry({
          retryAfterMs,
          attempt: 1,
          maxAttempts: 1,
          conversationId: convId,
          startedAt: Date.now(),
        });
        rateLimited = true;
        setError(msg);
        toast.error(`Rate limit exceeded — retry in ${Math.ceil(retryAfterMs / 1000)}s`);
      } else {
        const id = fallback.id;
        if (id) st.appendAssistantError(id, msg, convId);
        setError(msg);
        toast.error(`Agent error: ${msg}`);
        st.setRateLimitRetry(null);
      }
    } finally {
      activeStreamControllers.delete(convId);
      const st = useAppStore.getState();
      if (!streamCompleted) {
        const id = fallback.id;
        if (id) st.finalizeStreamingMessage(id, convId);
      }
    }

    // Refresh checkpoints BEFORE setting streaming=false so the undo
    // button's checkpoint check has up-to-date data when it becomes enabled.
    try {
      const st = useAppStore.getState();
      const cid = st.activeConversationId;
      if (cid) await st.refreshCheckpoints(cid);
    } catch (e) { console.warn("[HermOS] post-stream checkpoint refresh failed:", e); }

    try {
      useAppStore.getState().setStreaming(false, convId);
    } catch (e) { console.warn("[HermOS] post-stream state reset failed:", e); }
    const finalSt = useAppStore.getState();
    finalSt.setStreamingMessageId(null, convId);
    if (!rateLimited) finalSt.setRateLimitRetry(null);

    try {
      const activeId = finalSt.activeConversationId;
      const conv = finalSt.conversations.find((c) => c.id === activeId);
      if (conv && conv.title === "New conversation") {
        await apiPost(`/api/conversations/${encodeURIComponent(conv.id)}/generate-title`, {});
      }
    } catch (e) { console.warn("[HermOS] post-stream title generation failed:", e); }

    try {
      await finalSt.refreshConversations();
    } catch (e) { console.warn("[HermOS] post-stream conversation refresh failed:", e); }
  };

  const regenerate = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      if (activeStreamControllers.has(conversationId)) return;
      setError(null);
      const store = useAppStore.getState();
      store.setStreamError(null);
      store.setStreaming(true, conversationId);
      store.setContextTrimmed(null);

      const controller = new AbortController();
      activeStreamControllers.set(conversationId, controller);

      const fallback = { id: crypto.randomUUID() };
      let rateLimited = false;

      try {
        const tl = store.thinkingLevel;
        const res = await apiStream(
          `/api/conversations/${encodeURIComponent(conversationId)}/regenerate`,
          { messageId, ...(tl ? { thinkingLevel: tl } : {}) },
          controller.signal,
        );
        await readStream(res, conversationId, fallback);
      } catch (e) {
        flushPending();
        if (controller.signal.aborted) return;
        const msg = e instanceof ApiRequestError ? e.message : "Regenerate failed";
        const st = useAppStore.getState();
        if (e instanceof ApiRequestError && (e.code === "RATE_LIMITED" || e.status === 429)) {
          const retryAfterMs =
            e.details && typeof e.details === "object" && "retryAfterMs" in e.details
              ? ((e.details as { retryAfterMs?: number }).retryAfterMs ?? 60_000)
              : 60_000;
          st.setRateLimitRetry({
            retryAfterMs,
            attempt: 1,
            maxAttempts: 1,
            conversationId,
            startedAt: Date.now(),
          });
          rateLimited = true;
          toast.error(`Rate limit exceeded — retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        } else {
          setError(msg);
          toast.error(msg);
        }
      } finally {
        activeStreamControllers.delete(conversationId);
        const st = useAppStore.getState();
        const id = fallback.id;
        if (id) st.finalizeStreamingMessage(id, conversationId);
        st.setStreaming(false, conversationId);
        st.setStreamingMessageId(null, conversationId);
        if (!rateLimited) st.setRateLimitRetry(null);
        try { await st.refreshConversations(); } catch { /* ignore */ }
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      // The controller/buffer registries are MODULE-level and shared across
      // instances — an unmount here must NOT abort streams owned by other
      // mounted consumers. Drain buffered frames into the store first.
      flushPending();
      // Only cancel the shared timer if no other stream has pending data.
      // If buffers refilled between flushPending() and this check (another
      // stream wrote in the same microtask), leave the timer alive so their
      // data gets flushed on schedule.
      const hasRemainingData =
        pendingText.size > 0 ||
        pendingThinking.size > 0 ||
        pendingArgs.size > 0 ||
        pendingCmd.size > 0;
      if (!hasRemainingData) {
        cancelFlushTimer();
      }
    };
  }, []);

  return { stream, regenerate, stop, isStreaming, error };
}

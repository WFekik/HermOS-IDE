"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Zap, Clock, Undo2, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageRenderer } from "@/components/ide/message-renderer";
import { Composer } from "@/components/ide/composer";
import { EmptyState } from "@/components/ide/empty-state";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useAppStore, isPendingConversationId } from "@/stores/app-store";
import { useChatStream } from "@/hooks/use-chat-stream";
import { apiPost, apiDelete } from "@/lib/api-client";
import { toast } from "sonner";
import type { AttachmentDTO, AgentMode, ProviderId } from "@/lib/types";
import type { UIMessage } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import { conversationWidthClass } from "@/lib/color-theme";

export function ChatView() {
  const messages = useAppStore((s) => s.messages);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversationCount = useAppStore((s) => s.conversations.length);
  const conversationWidth = useAppStore((s) => s.conversationWidth);
  const composerMode = useAppStore((s) => s.composerMode);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const systemPrompt = useAppStore((s) => s.systemPrompt);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const createConversation = useAppStore((s) => s.createConversation);
  const ensureRealConversation = useAppStore((s) => s.ensureRealConversation);

  const { stream, stop } = useChatStream();

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 6,
    getItemKey: (index) => messages[index]?.id ?? index,
    useFlushSync: false,
  });

  const saveScrollPosition = useAppStore((s) => s.saveScrollPosition);

  const scrollRafId = React.useRef<number | null>(null);
  const lastScrollSave = React.useRef(0);

  // Auto-scroll when messages change (if user is at bottom), throttled via
  // requestAnimationFrame to avoid layout thrashing during high-frequency
  // SSE streaming updates.
  React.useEffect(() => {
    if (!stickRef.current) return;
    if (scrollRafId.current !== null) return;

    scrollRafId.current = requestAnimationFrame(() => {
      scrollRafId.current = null;
      if (stickRef.current && messages.length > 0) {
        virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      }
    });

    return () => {
      if (scrollRafId.current !== null) {
        cancelAnimationFrame(scrollRafId.current);
        scrollRafId.current = null;
      }
    };
  }, [messages, virtualizer]);

  // Restore the saved scroll offset once per conversation switch. Must NOT
  // re-run on every message append: `onScroll` persists the offset as the
  // conversation streams (including the offsets produced by programmatic
  // auto-scrolls), so re-applying it on a new turn would yank the view back
  // to the older position and flip stickRef off — the streamed answer would
  // then render below the viewport with no auto-follow.
  const lastRestoredConvRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const vl = virtualizer;
    if (!activeConversationId) return;
    if (lastRestoredConvRef.current === activeConversationId) return;
    lastRestoredConvRef.current = activeConversationId;

    const saved = useAppStore.getState().scrollPositions[activeConversationId];
    if (saved !== undefined) {
      stickRef.current = false;
      requestAnimationFrame(() => vl.scrollToOffset(saved));
    } else {
      // No saved offset — stick to the bottom. Messages may hydrate
      // asynchronously after switch, so the auto-scroll effect below
      // applies the bottom-stick lazily once they land.
      stickRef.current = true;
    }
  }, [activeConversationId, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = nearBottom;
    const now = Date.now();
    if (activeConversationId && now - lastScrollSave.current > 100) {
      lastScrollSave.current = now;
      saveScrollPosition(activeConversationId, el.scrollTop);
    }
  };

  // Capture the latest stream() so the wake listener below always launches
  // the autoWake run with current provider/model/mode without re-subscribing.
  const streamRef = React.useRef(stream);
  React.useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Deferred autoWake runs: if the wake arrives while the conversation is
  // still streaming, hold it here and fire it once streaming stops (instead of
  // dropping the event and losing the auto-synthesis forever).
  const deferredWakeRef: React.MutableRefObject<string | null> = React.useRef(null);

  // Server re-emits `wake` on every SSE (re)connect while its delivery grant is
  // still pending (`hasPendingWakeGrant`). Without a client-side single-flight
  // guard, a reconnect racing the in-flight sentinel run would queue a SECOND
  // auto-synthesis — the twice, with a duplicate final answer. We mark the
  // conversation as launched the moment a wake is accepted, and only release
  // the guard when that sentinel run actually settles on the client. Note the
  // guard is per-conversation and scoped to the client lifetime — a genuinely
  // NEW delivery (a later batch in the same conversation) publishes a fresh
  // wake event that the release below lets through.
  const autoWakeLaunchRef: React.MutableRefObject<Set<string>> = React.useRef(new Set());

  const runAutoWake = React.useCallback(async (convId: string) => {
    const st = useAppStore.getState();
    const conv = st.conversations.find((c) => c.id === convId);
    try {
      await streamRef.current(
        {
          conversationId: convId,
          message: "",
          provider: st.selectedProvider,
          model: st.selectedModel,
          mode: (conv?.mode as "agent" | "chat" | "architect") ?? st.composerMode,
          systemPrompt: st.systemPrompt,
          thinkingLevel: st.thinkingLevel as any,
          mcpServerIds: st.mcpServers
            .filter((s) => s.status === "connected")
            .map((s) => s.id),
          autoWake: true,
        },
        "",
        { skipUserAppend: true, autoWake: true },
      );
    } finally {
      // The run has settled (completed, errored, or was stopped). Release the
      // single-flight guard so a NEW delivery cycle for this conversation can
      // synthesize again; the server grant consumed by this run is gone, so it
      // can never double-authorize the same wake.
      autoWakeLaunchRef.current.delete(convId);
    }
  }, []);

  const launchAutoWake = React.useCallback(
    async (convId: string) => {
      if (autoWakeLaunchRef.current.has(convId)) return;
      autoWakeLaunchRef.current.add(convId);
      const st = useAppStore.getState();
      if (st.streamingStateByConversation[convId]?.isStreaming) {
        // Conversation busy with a user turn — queue until it stops. The
        // conversation stays marked so a replayed wake cannot double-defer.
        deferredWakeRef.current = convId;
        return;
      }
      if (deferredWakeRef.current === convId) deferredWakeRef.current = null;
      await runAutoWake(convId);
    },
    [runAutoWake],
  );

  // Background subagent delivery → autoWake synthesis. When the executor
  // hands pending subagents to the delivery watcher, the main turn ends
  // immediately; once every report is posted as a user-role message in this
  // conversation, the server publishes a `wake` event on the subagents SSE
  // route. We listen here (independent of the SubagentsPanel — this must work
  // even when that tab is closed) and launch the sentinel run that reads the
  // delivered reports and synthesizes the final answer. The server re-emits
  // the wake on (re)connect, so a missed event is replayed.
  React.useEffect(() => {
    if (!activeConversationId) return;
    // Pending conversations have no DB row yet — no subagent wake can exist.
    if (isPendingConversationId(activeConversationId)) return;
    if (typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let closed = false;

    try {
      const url = `/api/agents/subagents/stream?conversationId=${encodeURIComponent(activeConversationId)}&types=wake`;
      es = new EventSource(url);
      es.addEventListener("wake", () => {
        if (closed) return;
        void launchAutoWake(activeConversationId);
      });
    } catch {
      /* SSE unavailable — fall back to manual synthesis (user can re-send) */
    }

    return () => {
      closed = true;
      if (es) {
        try { es.close(); } catch { /* ignore */ }
      }
    };
  }, [activeConversationId, launchAutoWake]);

  // Flush a deferred auto-wake once the conversation stops streaming.
  const isConversationStreaming = useAppStore((s) =>
    activeConversationId
      ? s.streamingStateByConversation[activeConversationId]?.isStreaming ?? false
      : false,
  );
  React.useEffect(() => {
    const convId = deferredWakeRef.current;
    if (!convId) return;
    if (!isConversationStreaming) {
      deferredWakeRef.current = null;
      // Run directly (not through `launchAutoWake`): the single-flight guard
      // was already set on accept, so relaunching via it would be a no-op.
      void runAutoWake(convId);
    }
  }, [isConversationStreaming, runAutoWake]);

  // Active session sync: when a conversation is marked as streaming (including
  // after a browser hard refresh or tab reload), periodically refresh messages
  // and recover pending questions/permissions until the background executor completes.
  // Skipped while a live SSE stream is attached (streamingMessageId set) — a
  // mid-stream refresh would overwrite streamed content with the still-empty
  // server stub row (see executor queue-rotation notes).
  const liveStreamingMessageId = useAppStore(
    (s) =>
      s.streamingStateByConversation[activeConversationId ?? ""]?.streamingMessageId ?? null,
  );
  React.useEffect(() => {
    if (!activeConversationId || !isConversationStreaming || liveStreamingMessageId) return;

    const interval = setInterval(() => {
      void useAppStore.getState().refreshMessages(activeConversationId);
      void useAppStore.getState().recoverQuestionPrompt(activeConversationId);
      void useAppStore.getState().recoverPermissionPrompt(activeConversationId);
    }, 1500);

    return () => clearInterval(interval);
  }, [activeConversationId, isConversationStreaming, liveStreamingMessageId]);

  // Messages queued into a RUNNING loop while the composer is streaming. The
  // running executor picks them up at its next iteration; if the run ends
  // before answering one, `flushQueuedFallback` re-sends it automatically.
  const queuedPendingRef = React.useRef<
    Array<{ id: string; text: string; attachmentIds?: string[]; attachmentMetas?: AttachmentDTO[]; conversationId: string }>
  >([]);

  // Prune fallback markers for conversations that no longer exist — the
  // queue rows were deleted with the conversation, so a re-send would only
  // produce a 404 error toast.
  React.useEffect(() => {
    const alive = new Set(useAppStore.getState().conversations.map((c) => c.id));
    if (queuedPendingRef.current.some((p) => !alive.has(p.conversationId))) {
      queuedPendingRef.current = queuedPendingRef.current.filter((p) => alive.has(p.conversationId));
    }
  }, [conversationCount]);

  const handleSend = React.useCallback(
    async (
      text: string,
      attachmentIds?: string[],
      attachmentMetas?: AttachmentDTO[],
      opts?: {
        messageId?: string;
        conversationId?: string;
        provider?: ProviderId;
        model?: string;
        mode?: AgentMode;
        systemPrompt?: string;
      },
    ) => {
      // The fallback re-send targets the QUEUED message's own conversation, not
      // the currently-active one — the user may have switched conversations
      // while the run was streaming (see flushQueuedFallback).
      let convId = opts?.conversationId ?? activeConversationId;
      if (!convId) {
        // Auto-create a conversation if none is active — the user should be able
        // to type and send immediately without first clicking "New conversation".
        try {
          await createConversation();
          convId = useAppStore.getState().activeConversationId;
        } catch {
          toast.error("Failed to create conversation");
          return;
        }
      }
      if (!convId) {
        toast.error("No active conversation");
        return;
      }
      // Lazy conversations: a pending (never-persisted) chat materializes into
      // a real DB row only now — on the first actual message.
      const realConvId = await ensureRealConversation(convId);
      if (!realConvId) {
        toast.error("Failed to create conversation");
        return;
      }
      convId = realConvId;
      stickRef.current = true;
      const ctxConfig = useAppStore.getState().contextConfig;
      await stream(
        {
          conversationId: convId,
          message: text,
          provider: opts?.provider ?? selectedProvider,
          model: opts?.model ?? selectedModel,
          mode: opts?.mode ?? composerMode,
          systemPrompt: opts?.systemPrompt ?? systemPrompt,
          thinkingLevel: useAppStore.getState().thinkingLevel as any,
          mcpServerIds: mcpServers
            .filter((s) => s.status === "connected")
            .map((s) => s.id),
          ...(attachmentIds ? { attachmentIds } : {}),
          ...(opts?.messageId ? { messageId: opts.messageId } : {}),
          contextConfig: ctxConfig,
        },
        text,
        {
          attachments: attachmentMetas,
          // Fallback re-send: the queued row already exists (persisted by the
          // queue route with this exact id) and is already in the transcript.
          skipUserAppend: !!opts?.messageId,
        },
      );
    },
    [activeConversationId, createConversation, ensureRealConversation, stream, selectedProvider, selectedModel, composerMode, systemPrompt, mcpServers],
  );

  // Queue a message into the running agent loop (no interrupt). Appends the
  // message locally with a stable id, persists it via the queue route (same
  // id → clean dedup on refresh), and tracks it for the end-of-run fallback.
  // Resolves true when the turn was persisted+enqueued — the composer keeps
  // its draft on failure so nothing the user typed is lost.
  const handleQueue = async (
    text: string,
    attachmentIds?: string[],
    attachmentMetas?: AttachmentDTO[],
  ): Promise<boolean> => {
    let convId = activeConversationId;
    if (!convId) {
      try {
        await createConversation();
        convId = useAppStore.getState().activeConversationId;
      } catch {
        toast.error("Failed to create conversation");
        return false;
      }
    }
    if (!convId) {
      toast.error("No active conversation");
      return false;
    }
    // Lazy conversations: materialize the pending row before queueing into it.
    const realConvId = await ensureRealConversation(convId);
    if (!realConvId) {
      toast.error("Failed to create conversation");
      return false;
    }
    convId = realConvId;
    const messageId = crypto.randomUUID();
    useAppStore.getState().appendUserMessage({
      id: messageId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      ...(attachmentMetas && attachmentMetas.length > 0 ? { attachments: attachmentMetas } : {}),
    });
    queuedPendingRef.current.push({ id: messageId, text, attachmentIds, attachmentMetas, conversationId: convId });
    try {
      await apiPost("/api/agents/chat/queue", {
        conversationId: convId,
        message: text,
        messageId,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
      return true;
    } catch {
      // No DB row exists — roll back the optimistic copy, drop the marker.
      // Target the conversation it was queued into: the user may have
      // switched conversations while the request was in flight.
      queuedPendingRef.current = queuedPendingRef.current.filter((p) => p.id !== messageId);
      useAppStore.getState().removeMessage(messageId, convId);
      toast.error("Failed to queue message");
      return false;
    }
  };

  // Consume `done`'s answered-ids so the fallback drops those markers — its
  // own same-run answer detection can't see the answer (the run's rows
  // postdate the queued row).
  const queuedAnswered = useAppStore((s) => s.queuedAnsweredByConversation);
  React.useEffect(() => {
    const consumed: string[] = [];
    for (const [convId, ids] of Object.entries(queuedAnswered)) {
      if (ids.length === 0) continue;
      const idSet = new Set(ids);
      const before = queuedPendingRef.current.length;
      queuedPendingRef.current = queuedPendingRef.current.filter(
        (p) => !(p.conversationId === convId && idSet.has(p.id)),
      );
      if (before > queuedPendingRef.current.length) consumed.push(convId);
    }
    if (consumed.length > 0) {
      // Consumed — clear the report so it cannot re-apply on later renders.
      const st = useAppStore.getState();
      for (const convId of consumed) st.clearQueuedAnswered(convId);
    }
  }, [queuedAnswered]);

  // Auto-send queued messages a finished run never answered (a fresh run
  // picks them up). Answered turns are left alone; the id is reused so the
  // transcript row dedupes. Only this conversation's markers are cleared.
  const flushQueuedFallback = React.useCallback(
    async (convId: string) => {
      const pending = queuedPendingRef.current.filter((p) => p.conversationId === convId);
      if (pending.length === 0) return;
      const st = useAppStore.getState();
      // A fresh run is already streaming: its history read includes the
      // queued rows, so it will answer them — don't double-send.
      if (st.streamingStateByConversation[convId]?.isStreaming) return;
      const msgs = st.messagesByConversation[convId] ?? st.messages;
      const conv = st.conversations.find((c) => c.id === convId);
      // Use the conversation's own config — the fallback can fire for a
      // background conversation while a different one is being viewed.
      const answered = new Set(st.queuedAnsweredByConversation[convId] ?? []);
      const unanswered: typeof pending = [];
      for (const p of pending) {
        if (answered.has(p.id)) continue;
        const idx = msgs.findIndex((m) => m.id === p.id);
        // An assistant row counts only if it is a real answer — errored or
        // empty shells (stream aborted before output) do not.
        const hasResponse =
          idx >= 0 &&
          msgs
            .slice(idx + 1)
            .some(
              (m) =>
                m.role === "assistant" &&
                !m.error &&
                (m.content ?? "").trim().length > 0,
            );
        if (!hasResponse) unanswered.push(p);
      }
      if (unanswered.length === 0) {
        // All answered — drop this conversation's markers.
        queuedPendingRef.current = queuedPendingRef.current.filter(
          (p) => p.conversationId !== convId,
        );
        return;
      }
      for (const p of unanswered) {
        // Stale-snapshot guard: an earlier re-send's run can answer later
        // queued turns too — skip if either signal is already gone.
        if (!queuedPendingRef.current.some((q) => q.id === p.id)) continue;
        if ((useAppStore.getState().queuedAnsweredByConversation[p.conversationId] ?? []).includes(p.id)) continue;
        try {
          await handleSend(p.text, p.attachmentIds, p.attachmentMetas, {
            messageId: p.id,
            conversationId: p.conversationId,
            provider: conv?.provider,
            model: conv?.model,
            mode: conv?.mode,
            systemPrompt: conv?.systemPrompt ?? undefined,
          });
          // The re-send started (a fresh run now owns the turn). Drop the
          // marker only AFTER the send succeeds, so a mid-flush user run
          // (silently dropped by the stream guard) or a failed send keeps it
          // for the next stop transition instead of losing the message.
          queuedPendingRef.current = queuedPendingRef.current.filter(
            (q) => q.id !== p.id,
          );
        } catch {
          // Keep the marker — a later stop transition retries the re-send.
        }
      }
    },
    [handleSend],
  );

  // Explicit user stop: drop this conversation's queued-turn fallback markers
  // BEFORE stopping, so the stop-transition below doesn't immediately
  // auto-start a fresh run answering them. The turns stay in the transcript
  // (answered by the next run the user actually starts); a stop must halt,
  // not silently re-launch. Shared by the composer Stop button and the
  // rate-limit banner's Cancel Run — both are explicit user cancels.
  const stopConversation = React.useCallback(
    (convId: string) => {
      queuedPendingRef.current = queuedPendingRef.current.filter(
        (p) => p.conversationId !== convId,
      );
      stop(convId);
    },
    [stop],
  );

  // Trigger the fallback for EVERY conversation that stops streaming — a
  // background conversation's run settling is just as terminal for its own
  // queued turns as the active one's. Delay slightly so the done event's
  // queuedAnsweredIds propagate through the store before the fallback
  // decides whether a re-send is needed — prevents redundant stop-then-run.
  const streamingByConv = useAppStore((s) => s.streamingStateByConversation);
  const wasStreamingRef = React.useRef<Record<string, boolean>>({});
  const flushTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  React.useEffect(() => {
    const stopped: string[] = [];
    for (const [convId, st] of Object.entries(streamingByConv)) {
      const was = wasStreamingRef.current[convId];
      if (was && !st?.isStreaming) stopped.push(convId);
      wasStreamingRef.current[convId] = !!st?.isStreaming;
    }
    for (const convId of stopped) {
      // Clear any prior pending timer for this conversation.
      if (flushTimersRef.current[convId]) clearTimeout(flushTimersRef.current[convId]);
      flushTimersRef.current[convId] = setTimeout(() => {
        delete flushTimersRef.current[convId];
        void flushQueuedFallback(convId);
      }, 600);
    }
  }, [streamingByConv, flushQueuedFallback]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:auto]"
      >
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => setComposerDraft(p)} />
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const m = messages[virtualRow.index];
              if (!m) return null;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div className={cn("mx-auto px-4 py-1.5", conversationWidthClass(conversationWidth))}>
                    <MemoizedMessageRow message={m} index={virtualRow.index} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <RateLimitRetryBanner onStop={stopConversation} />
      <Composer onSend={handleSend} onQueue={handleQueue} onStop={() => {
        const activeId = useAppStore.getState().activeConversationId;
        if (activeId) stopConversation(activeId); else stop();
      }} />
    </div>
  );
}

const SUBAGENT_REPORT_RE = /^<subagent_report name="([^"]*)"(?: status="([^"]*)")?>[\s\S]*?<\/subagent_report>\s*$/;

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function SubagentResultLine({ content }: { content: string }) {
  const match = SUBAGENT_REPORT_RE.exec(content.trim());
  const isFailed = content.startsWith("[Subagent failed]") || match?.[2] === "failed";
  const name = match?.[1] ? decodeEntities(match[1]) : null;
  const label = isFailed
    ? `messaged from ${name ?? "subagent"} — failed`
    : `messaged from ${name ?? "subagent"}`;
  return (
    <div aria-hidden className="my-4 flex items-center gap-3 text-[11px] font-mono text-muted-foreground/60 select-none">
      <div className="h-px flex-1 bg-border/40" />
      <span className="min-w-0 truncate">{label}</span>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  );
}

function MessageRow({ message }: { message: UIMessage; index: number }) {
  const isSubagentResult =
    message.role === "user" &&
    (SUBAGENT_REPORT_RE.test(message.content.trim()) ||
      message.content.startsWith("[Subagent results]") ||
      message.content.startsWith("[Subagent failed]"));
  const isUser = message.role === "user" && !isSubagentResult;
  const isAssistant = message.role === "assistant";

  if (isSubagentResult) {
    return (
      <div className="scroll-mt-24" data-message-id={message.id}>
        <SubagentResultLine content={message.content} />
      </div>
    );
  }

  if (isUser) {
    return <UserMessageRow message={message} />;
  }

  return (
    <div className="scroll-mt-24" data-message-id={message.id}>
      <div>
        <MessageRenderer message={message} />
        {isAssistant && !message.streaming && Boolean((message.tokensIn ?? 0) > 0 || (message.tokensOut ?? 0) > 0 || (message.latencyMs ?? 0) > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/80 font-mono">
            {message.provider && (
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2 py-0.5 font-medium text-foreground/80">
                <ProviderLogo providerId={message.provider} modelId={message.model} size={12} />
                <span>
                  {message.provider === "openrouter"
                    ? "OpenRouter"
                    : message.provider === "nvidia"
                      ? "NVIDIA NIM"
                      : message.provider === "zen"
                        ? "OpenCode Zen"
                        : message.provider.toUpperCase()}
                </span>
              </span>
            )}
            {Boolean((message.tokensIn ?? 0) > 0 || (message.tokensOut ?? 0) > 0) && (
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/20 px-2 py-0.5">
                <Zap className="size-3 text-brand shrink-0" />
                <span>
                  {(message.tokensIn ?? 0).toLocaleString()} in · {(message.tokensOut ?? 0).toLocaleString()} out
                </span>
              </span>
            )}
            {Boolean((message.latencyMs ?? 0) > 0) && (
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/20 px-2 py-0.5">
                <Clock className="size-3 text-muted-foreground shrink-0" />
                <span>
                  {message.latencyMs! >= 1000 ? `${(message.latencyMs! / 1000).toFixed(1)}s` : `${message.latencyMs}ms`}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** User message — right-aligned, plain text, with an undo button on hover. */
function UserMessageRow({ message }: { message: UIMessage }) {
  const [busy, setBusy] = React.useState(false);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const removeMessageAndAfter = useAppStore((s) => s.removeMessageAndAfter);
  const closeAllFileTabs = useAppStore((s) => s.closeAllFileTabs);
  const setPreTurnCheckpoint = useAppStore((s) => s.setPreTurnCheckpoint);
  const branchConversation = useAppStore((s) => s.branchConversation);

  const branch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming || busy) return;
    setBusy(true);
    try {
      const createdId = await branchConversation(message.id);
      if (createdId) {
        toast.success("Branched into a new conversation");
      }
    } catch {
      toast.error("Branch failed");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming || busy) return;
    setBusy(true);
    try {
      const cid = activeConversationId;
      let restoredCount = 0;
      if (cid) {
        const res = await apiDelete<{ ok: boolean; restoredFiles?: string[] }>(
          `/api/conversations/${encodeURIComponent(cid)}/messages/${encodeURIComponent(message.id)}`
        );
        if (res && Array.isArray(res.restoredFiles)) {
          restoredCount = res.restoredFiles.length;
        }
      }
      setPreTurnCheckpoint(null);
      closeAllFileTabs();
      removeMessageAndAfter(message.id);
      setComposerDraft(message.content);
      if (restoredCount > 0) {
        toast.success(`Message undone — reverted ${restoredCount} file(s) across turns`);
      } else {
        toast.success("Message undone — edit and send to retry");
      }
    } catch {
      toast.error("Undo failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group scroll-mt-24" data-message-id={message.id}>
      <div className="text-right">
        <MessageRenderer message={message} />
        {!message.streaming && (
          <div className="mt-0.5 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 gap-1 text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
              onClick={undo}
              disabled={isStreaming || busy}
              aria-label="Undo to this point"
              type="button"
            >
              <Undo2 className="size-3" />
              <span>undo to this point</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 gap-1 text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-[10px]"
              onClick={branch}
              disabled={isStreaming || busy}
              aria-label="Branch from this message"
              type="button"
            >
              <GitBranch className="size-3" />
              <span>branch</span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const MemoizedMessageRow = React.memo(MessageRow, (prev, next) => {
  if (prev.index !== next.index) return false;
  if (prev.message === next.message) return true;
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.thinking === next.message.thinking &&
    prev.message.role === next.message.role &&
    prev.message.streaming === next.message.streaming &&
    prev.message.segments === next.message.segments &&
    prev.message.liveToolCalls === next.message.liveToolCalls &&
    prev.message.tokensIn === next.message.tokensIn &&
    prev.message.tokensOut === next.message.tokensOut &&
    prev.message.latencyMs === next.message.latencyMs &&
    prev.message.error === next.message.error
  );
});

function RateLimitRetryBanner({ onStop }: { onStop: (conversationId: string) => void }) {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const rateLimitRetry = useAppStore((s) => s.rateLimitRetry);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!rateLimitRetry) return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      const elapsed = Date.now() - rateLimitRetry.startedAt;
      if (elapsed > rateLimitRetry.retryAfterMs + 6000) {
        useAppStore.getState().setRateLimitRetry(null);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [rateLimitRetry]);

  if (!rateLimitRetry || !isStreaming || rateLimitRetry.conversationId !== activeConversationId) return null;

  const elapsedMs = Date.now() - rateLimitRetry.startedAt;
  const remainingSec = Math.max(0, Math.ceil((rateLimitRetry.retryAfterMs - elapsedMs) / 1000));

  return (
    <div className="mx-4 my-2 p-3 border border-amber-500/30 rounded-lg bg-amber-500/5 text-xs text-amber-600 dark:text-amber-400 flex items-center justify-between animate-pulse">
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 shrink-0 animate-spin" />
        <span>
          Rate limit reached. Retrying (attempt {rateLimitRetry.attempt} of {rateLimitRetry.maxAttempts}) in {remainingSec}s...
        </span>
      </div>
      <Button 
        size="sm" 
        variant="outline" 
        className="h-7 text-[10px] px-2 border-amber-500/30 text-amber-600 hover:bg-amber-500/10 font-medium" 
        onClick={() => onStop(activeConversationId)}
      >
        Cancel Run
      </Button>
    </div>
  );
}

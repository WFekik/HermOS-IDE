"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Undo2, GitBranch, Copy, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageRenderer, cleanUserMessageContent } from "@/components/ide/message-renderer";
import { Composer } from "@/components/ide/composer";
import { EmptyState } from "@/components/ide/empty-state";
import { useAppStore, isPendingConversationId } from "@/stores/app-store";
import { useChatStream } from "@/hooks/use-chat-stream";
import { apiPost, apiDelete, ApiRequestError } from "@/lib/api-client";
import { ConfirmUndoDialog, type UndoConfirmState } from "@/components/ide/confirm-undo-dialog";
import type { UndoPreview } from "@/lib/undo-plan";
import { toast } from "sonner";
import { useTranslation } from "@/hooks/use-translation";
import type { AttachmentDTO, AgentMode, ProviderId } from "@/lib/types";
import type { UIMessage } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import { conversationWidthClass } from "@/lib/color-theme";

export const ChatView = React.memo(function ChatView() {
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
  const { t } = useTranslation();

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
    useAnimationFrameWithResizeObserver: true,
  });

  const saveScrollPosition = useAppStore((s) => s.saveScrollPosition);

  // Message navigator rail (ChatGPT-style): one dot per user message on the
  // chat's edge; hover previews the message, click jumps to it. Display-only
  // sampling past MAX_DOTS — no data is dropped, the list itself is intact.
  const MAX_NAV_DOTS = 40;
  const userDots = React.useMemo(() => {
    const dots: Array<{ id: string; index: number; preview: string }> = [];
    messages.forEach((m, index) => {
      if (m.role !== "user") return;
      const raw = (m.content ?? "").trim();
      if (
        SUBAGENT_REPORT_RE.test(raw) ||
        raw.startsWith("[Subagent results]") ||
        raw.startsWith("[Subagent failed]")
      ) {
        return;
      }
      const oneLine = cleanUserMessageContent(m.content).trim().replace(/\s+/g, " ");
      dots.push({
        id: m.id,
        index,
        preview: oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine,
      });
    });
    if (dots.length <= MAX_NAV_DOTS) return dots;
    const sampled: typeof dots = [];
    const step = dots.length / MAX_NAV_DOTS;
    for (let i = 0; i < MAX_NAV_DOTS; i++) sampled.push(dots[Math.floor(i * step)]);
    return sampled;
  }, [messages]);

  const [railScrollable, setRailScrollable] = React.useState(false);
  const measureRailScrollable = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof document !== "undefined" && document.body.hasAttribute("data-resizing")) {
      return;
    }
    setRailScrollable((prev) => {
      const next = el.scrollHeight > el.clientHeight + 80;
      return prev === next ? prev : next;
    });
  }, []);
  React.useEffect(() => {
    measureRailScrollable();
  }, [messages.length, activeConversationId, measureRailScrollable]);
  // Content streams without changing message count — observe size changes so
  // the rail appears as soon as the chat actually overflows.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (typeof document !== "undefined" && document.body.hasAttribute("data-resizing")) {
        return;
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measureRailScrollable();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [measureRailScrollable]);

  React.useEffect(() => {
    const handlePointerUp = () => {
      requestAnimationFrame(() => measureRailScrollable());
    };
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    return () => window.removeEventListener("pointerup", handlePointerUp);
  }, [measureRailScrollable]);

  const jumpToMessage = React.useCallback(
    (index: number) => {
      // Manual jump wins over auto-follow so the view stays where it lands.
      stickRef.current = false;
      virtualizer.scrollToIndex(index, { align: "start" });
    },
    [virtualizer],
  );
  const showRail = userDots.length >= 2 && railScrollable;

  const scrollRafId = React.useRef<number | null>(null);
  const lastScrollSave = React.useRef(0);

  // Auto-scroll when messages change (if user is at bottom), throttled via
  // requestAnimationFrame to avoid layout thrashing during high-frequency
  // SSE streaming updates. Also re-measures rail overflow here (identity
  // changes every flush, unlike messages.length which is stable mid-answer).
  React.useEffect(() => {
    measureRailScrollable();
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
  }, [messages, virtualizer, measureRailScrollable]);

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

    const isStreamingNow = useAppStore.getState().streamingStateByConversation[activeConversationId]?.isStreaming;
    const saved = useAppStore.getState().scrollPositions[activeConversationId];
    if (isStreamingNow) {
      stickRef.current = true;
      requestAnimationFrame(() => {
        if (messages.length > 0) {
          vl.scrollToIndex(messages.length - 1, { align: "end" });
        }
      });
    } else if (saved !== undefined) {
      stickRef.current = false;
      requestAnimationFrame(() => {
        const total = vl.getTotalSize();
        const target = total > 0 ? Math.min(saved, Math.max(0, total - (scrollRef.current?.clientHeight ?? 0))) : saved;
        vl.scrollToOffset(target);
      });
    } else {
      // No saved offset — stick to the bottom. Messages may hydrate
      // asynchronously after switch, so the auto-scroll effect below
      // applies the bottom-stick lazily once they land.
      stickRef.current = true;
    }
  }, [activeConversationId, virtualizer]);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = nearBottom;
    setRailScrollable((prev) => {
      const next = el.scrollHeight > el.clientHeight + 80;
      return prev === next ? prev : next;
    });
    const now = Date.now();
    if (activeConversationId && now - lastScrollSave.current > 100) {
      lastScrollSave.current = now;
      saveScrollPosition(activeConversationId, el.scrollTop);
    }
  }, [activeConversationId, saveScrollPosition]);

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

  // Background subagent delivery → autoWake synthesis. When the executor hands
  // pending subagents to the delivery watcher, the main turn ends immediately;
  // once every report is posted as a user-role message in this conversation,
  // the server publishes a `wake` event on the subagents SSE route. The server
  // re-emits it on (re)connect, so a missed event is replayed.
  //
  // Subagent tool approvals do NOT arrive here: they are user-scoped (a
  // worker may block in a background conversation) and are owned by
  // `useSubagentPermissionStream`.
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
      if (typeof document !== "undefined" && document.hidden) return;
      void useAppStore.getState().refreshMessages(activeConversationId);
      void useAppStore.getState().recoverQuestionPrompt(activeConversationId);
      void useAppStore.getState().recoverPermissionPrompt(activeConversationId);
    }, 5000);

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
          toast.error(t("failed_create_conversation"));
          return;
        }
      }
      if (!convId) {
        toast.error(t("no_active_conversation"));
        return;
      }
      // Lazy conversations: a pending (never-persisted) chat materializes into
      // a real DB row only now — on the first actual message.
      const realConvId = await ensureRealConversation(convId);
      if (!realConvId) {
        toast.error(t("failed_create_conversation"));
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
  // useCallback (not a plain closure): Composer is memoized, so all three of
  // its callback props must hold identity across ChatView renders — otherwise
  // every panel resize would reconcile the entire composer subtree.
  const handleQueue = React.useCallback(
    async (
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
          toast.error(t("failed_create_conversation"));
          return false;
        }
      }
      if (!convId) {
        toast.error(t("no_active_conversation"));
        return false;
      }
      // Lazy conversations: materialize the pending row before queueing into it.
      const realConvId = await ensureRealConversation(convId);
      if (!realConvId) {
        toast.error(t("failed_create_conversation"));
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
        toast.error(t("failed_queue_message"));
        return false;
      }
    },
    [activeConversationId, createConversation, ensureRealConversation, t],
  );

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

  // Stable Stop handler for the memoized composer (inline arrow would defeat
  // the memo on every parent render — same reason as handleQueue above).
  const handleStop = React.useCallback(() => {
    const activeId = useAppStore.getState().activeConversationId;
    if (activeId) stopConversation(activeId);
    else stop();
  }, [stopConversation, stop]);

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
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full min-h-0 overflow-y-auto [overflow-anchor:auto]"
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
                    className="absolute top-0 start-0 w-full"
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
        {showRail && (
          <div className="pointer-events-none absolute bottom-4 right-1.5 top-16 z-10 flex w-5 flex-col items-center">
            <div aria-hidden className="absolute bottom-1 top-1 w-px bg-border/70" />
            <div className="flex h-full flex-col items-center justify-evenly">
              {userDots.map((d) => (
                <div key={d.id} className="group pointer-events-auto relative flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => jumpToMessage(d.index)}
                    aria-label={d.preview || t("jump_to_message")}
                    title={d.preview || t("jump_to_message")}
                    className="flex size-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="size-2 rounded-full bg-muted-foreground/70 ring-2 ring-background transition-all group-hover:scale-125 group-hover:bg-brand group-focus-visible:bg-brand" />
                  </button>
                  <span className="pointer-events-none absolute right-full top-1/2 mr-2 hidden max-w-[240px] -translate-y-1/2 truncate whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md group-hover:block">
                    {d.preview || t("jump_to_message")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <RateLimitRetryBanner onStop={stopConversation} />
      <MemoComposer onSend={handleSend} onQueue={handleQueue} onStop={handleStop} />
    </div>
  );
});

// Memoized composer: ChatView re-renders on every virtualizer measurement
// (container resizes during panel drags), and without memo each of those
// reconciles the entire composer subtree (pickers, popovers, buttons).
// Safe: all behavior flows from internal state + store subscriptions, which
// still update; only identical-props parent renders are skipped.
const MemoComposer = React.memo(Composer);

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
  const [assistantCopied, setAssistantCopied] = React.useState(false);
  const { t: tRow } = useTranslation();

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
    <div className="scroll-mt-24 group" data-message-id={message.id}>
      <div>
        <MessageRenderer message={message} />
        {isAssistant && !message.streaming && (message.content ?? "").trim().length > 0 && (
          <div className="mt-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity pointer-coarse:opacity-100">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 gap-1 text-muted-foreground/75 hover:text-foreground text-[10px]"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(message.content);
                  setAssistantCopied(true);
                  setTimeout(() => setAssistantCopied(false), 2000);
                } catch {
                  /* clipboard unavailable */
                }
              }}
              aria-label={tRow("copy")}
              type="button"
            >
              {assistantCopied ? <Check className="size-3 text-brand" /> : <Copy className="size-3" />}
              <span>{assistantCopied ? tRow("copied") : tRow("copy")}</span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** User message — bubble card using the right panel theme color (card). */
function UserMessageRow({ message }: { message: UIMessage }) {
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  // Per-conversation streaming flag (primitive boolean) — a global `isStreaming`
  // subscription would re-render every user bubble on any conversation's flush.
  const isStreaming = useAppStore(
    (s) => s.streamingStateByConversation[activeConversationId ?? ""]?.isStreaming ?? false,
  );
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const removeMessageAndAfter = useAppStore((s) => s.removeMessageAndAfter);
  const closeAllFileTabs = useAppStore((s) => s.closeAllFileTabs);
  const setPreTurnCheckpoint = useAppStore((s) => s.setPreTurnCheckpoint);
  const branchConversation = useAppStore((s) => s.branchConversation);
  const { t } = useTranslation();

  const copyPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cleanUserMessageContent(message.content));
      setCopied(true);
      toast.success(t("prompt_copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("failed_copy_prompt"));
    }
  };

  const branch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming || busy) return;
    setBusy(true);
    try {
      const createdId = await branchConversation(message.id);
      if (createdId) {
        toast.success(t("branched_success"));
      }
    } catch {
      toast.error(t("branch_failed"));
    } finally {
      setBusy(false);
    }
  };

  // Ref-based guard: `busy` state only flips after re-render, so two rapid
  // clicks would both pass and fire two DELETEs — the loser 404s ("Undo
  // failed") or double-applies. The ref flips synchronously.
  const undoBusyRef = React.useRef(false);
  const [confirmState, setConfirmState] = React.useState<UndoConfirmState | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const finishUndoUi = React.useCallback(
    (restoredCount: number) => {
      setPreTurnCheckpoint(null);
      closeAllFileTabs();
      removeMessageAndAfter(message.id);
      setComposerDraft(cleanUserMessageContent(message.content));
      if (restoredCount > 0) {
        toast.success(t("all_files_reverted"));
      } else {
        toast.success(t("message_undone"));
      }
    },
    [message.id, message.content, setPreTurnCheckpoint, closeAllFileTabs, removeMessageAndAfter, setComposerDraft, t],
  );

  const runUndoDelete = React.useCallback(
    async (
      cid: string,
      body: { expected?: { path: string; hash: string | null }[]; revertFiles: boolean },
    ): Promise<{ ok: boolean; restoredFiles?: string[]; failed?: { id: string; error: string }[] } | null> => {
      try {
        return await apiDelete<{ ok: boolean; restoredFiles?: string[]; failed?: { id: string; error: string }[] }>(
          `/api/conversations/${encodeURIComponent(cid)}/messages/${encodeURIComponent(message.id)}`,
          { body, timeoutMs: 5 * 60_000 },
        );
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 404) {
          // Already undone (double-click loser, stale row): not an error —
          // sync the transcript to the server truth instead of toasting failure.
          try {
            await useAppStore.getState().refreshMessages(cid);
          } catch {
            /* refresh is best-effort */
          }
          toast.info(t("undo_already_undone"));
          return null;
        }
        throw e;
      }
    },
    [message.id, t],
  );

  const undo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming || busy || undoBusyRef.current) return;
    undoBusyRef.current = true;
    setBusy(true);
    try {
      const cid = activeConversationId;
      if (!cid) return;
      // Step 1: server-computed revert plan (no changes). The dialog always
      // opens — even empty — so undo never fires silently.
      let preview: UndoPreview;
      try {
        const res = await apiPost<{ ok: boolean; preview: UndoPreview }>(
          `/api/conversations/${encodeURIComponent(cid)}/messages/${encodeURIComponent(message.id)}`,
          {},
          { timeoutMs: 60_000 },
        );
        preview = res.preview;
      } catch {
        toast.error(t("undo_preview_failed"));
        return;
      }
      // The Confirm dialog ALWAYS appears — even with zero file changes
      // (it then shows the transcript-only note). Undo never fires silently.
      setConfirmState({ messageId: message.id, preview: preview ?? { files: [], expected: [], attempted: 0, dirsRemoved: 0 } });
    } catch {
      toast.error(t("undo_failed"));
    } finally {
      undoBusyRef.current = false;
      setBusy(false);
    }
  };

  const confirmUndo = async (revertFiles: boolean) => {
    const cid = activeConversationId;
    const plan = confirmState?.preview;
    if (!cid || !plan) return;
    setConfirming(true);
    try {
      const res = await runUndoDelete(cid, { expected: plan.expected, revertFiles });
      if (!res) {
        // 404 path already handled (info toast + refresh) inside runUndoDelete.
        setConfirmState(null);
        return;
      }
      setConfirmState(null);
      finishUndoUi(res.restoredFiles?.length ?? 0);
      if ((res as { filesSkipped?: boolean }).filesSkipped) {
        // Containment had no workspace root: transcript trimmed, files
        // deliberately left alone — say so loudly, not as success.
        toast.warning(t("undo_files_skipped"));
      }
      // Refresh server truth behind the optimistic truncation (heals any
      // in-flight divergence without resurrecting tombstoned rows).
      try {
        await useAppStore.getState().refreshMessages(cid);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 429) {
        // Another undo holds the per-conversation lock (dual-modal confirm
        // race). Dialog stays open — retry after the first one releases it.
        toast.info(t("undo_in_progress_retry"));
        return;
      }
      if (e instanceof ApiRequestError && e.status === 409) {
        // Files moved under us since the preview: show the FRESH server
        // plan (in details) instead of applying a stale one.
        const details = e.details as { preview?: UndoPreview } | undefined;
        if (details?.preview) {
          setConfirmState({ messageId: message.id, preview: details.preview, refreshed: true });
          toast.warning(t("undo_files_changed"));
        } else {
          setConfirmState(null);
          toast.error(t("undo_failed"));
        }
        return;
      }
      if (e instanceof ApiRequestError && e.status === 500) {
        // Partial/failed restore: transcript KEPT server-side by design —
        // surface the failure loudly, refresh, do NOT truncate locally.
        const details = e.details as { failed?: { id: string; error: string }[] } | undefined;
        const first = details?.failed?.[0]?.error;
        toast.error(first ? `${t("undo_failed")}: ${first}` : t("undo_failed"));
        try {
          await useAppStore.getState().refreshMessages(cid);
        } catch {
          /* best-effort */
        }
        return;
      }
      toast.error(t("undo_failed"));
    } finally {
      setConfirming(false);
      undoBusyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="group scroll-mt-24 pb-1" data-message-id={message.id}>
      <div className="w-full rounded-2xl border border-border/70 bg-card px-4 py-3.5 text-start text-card-foreground shadow-xs transition-colors hover:border-border/90 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
        <MessageRenderer message={message} />
      </div>
      {!message.streaming && (
        <div className="mt-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity pointer-coarse:opacity-100">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 gap-1 text-muted-foreground/75 hover:text-foreground text-[10px]"
            onClick={copyPrompt}
            aria-label={t("copy")}
            type="button"
          >
            {copied ? <Check className="size-3 text-brand" /> : <Copy className="size-3" />}
            <span>{copied ? t("copied") : t("copy")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 gap-1 text-muted-foreground/75 hover:text-foreground text-[10px]"
            onClick={undo}
            disabled={isStreaming || busy}
            aria-label={t("undo")}
            type="button"
          >
            <Undo2 className="size-3" />
            <span>{t("undo")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 gap-1 text-muted-foreground/75 hover:text-foreground text-[10px]"
            onClick={branch}
            disabled={isStreaming || busy}
            aria-label={t("branch")}
            type="button"
          >
            <GitBranch className="size-3" />
            <span>{t("branch")}</span>
          </Button>
        </div>
      )}
      <ConfirmUndoDialog
        state={confirmState}
        confirming={confirming}
        onCancel={() => {
          if (!confirming) {
            setConfirmState(null);
            undoBusyRef.current = false;
            setBusy(false);
          }
        }}
        onConfirm={(revertFiles) => void confirmUndo(revertFiles)}
      />
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
  const { t } = useTranslation();
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
    <div className="mx-4 my-2 p-3 border border-amber-500/30 rounded-lg bg-amber-500/5 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        <span>
          {t("rate_limit_reached")}.{" "}
          {t("retrying_in", {
            attempt: rateLimitRetry.attempt,
            maxAttempts: rateLimitRetry.maxAttempts,
            sec: remainingSec,
          })}
        </span>
      </div>
      <Button 
        size="sm" 
        variant="outline" 
        className="h-7 text-[10px] px-2 border-amber-500/30 text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 font-medium" 
        onClick={() => onStop(activeConversationId)}
      >
        {t("cancel_run")}
      </Button>
    </div>
  );
}


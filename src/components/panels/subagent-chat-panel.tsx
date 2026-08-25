"use client";

import * as React from "react";
import { ArrowLeft, Bot, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { MessageRenderer } from "@/components/ide/message-renderer";
import type { Subagent, SubagentMessage } from "@/lib/ai/subagents";
import type { UIMessage } from "@/stores/app-store";

interface SubagentChatPanelProps {
  subagentId: string;
  onBack: () => void;
}

export function SubagentChatPanel({ subagentId, onBack }: SubagentChatPanelProps) {
  const [subagent, setSubagent] = React.useState<Subagent | null>(null);
  const [messages, setMessages] = React.useState<SubagentMessage[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [liveContent, setLiveContent] = React.useState("");
  const [liveThinking, setLiveThinking] = React.useState<string | undefined>(undefined);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);
  // Tracks the last observed status and streamed-draft state for THIS session
  // so the `update` handler only refetches when something actually changed.
  const lastSeenRef = React.useRef<string | null>(null);
  const hadDraftRef = React.useRef<boolean>(false);
  // Sequencing guard: overlapping fetches (initial load, 5s poll, SSE-triggered
  // refetch) can resolve out of order; only the LATEST request may apply its
  // snapshot, or an older one could overwrite a newer transcript.
  const fetchSeqRef = React.useRef(0);

  // Load and poll subagent session details + message history
  const fetchHistory = React.useCallback(async (showLoading = false) => {
    const seq = ++fetchSeqRef.current;
    if (showLoading) setLoading(true);
    try {
      const data = await apiGet<{ subagent: Subagent; messages: SubagentMessage[] }>(
        `/api/agents/subagents/${encodeURIComponent(subagentId)}`,
        { query: { messages: "true" } }
      );
      if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch
      setSubagent(data.subagent);
      setMessages(data.messages ?? []);
      setError(null);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load subagent details");
    } finally {
      if (showLoading && seq === fetchSeqRef.current) setLoading(false);
    }
  }, [subagentId]);

  // Initial load
  React.useEffect(() => {
    void fetchHistory(true);
  }, [fetchHistory]);

  // Polling loop fallback for when the SSE subscription below can't be
  // established (no EventSource / flaky proxy). Cheap and short-lived — only
  // runs while the subagent is active.
  React.useEffect(() => {
    if (!subagent) return;
    const isRunning = subagent.status === "running" || subagent.status === "pending";
    if (!isRunning) return;

    const interval = setInterval(() => {
      void fetchHistory(false);
    }, 5000);

    return () => clearInterval(interval);
  }, [subagent, fetchHistory]);

  // Live token-level streaming via the same SSE the list panel uses. Shows the
  // subagent's answer appearing in real time (like the main agent) and uses
  // full `update` events to snag committed turns immediately instead of waiting
  // for the 5s poll.
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    if (!subagent?.conversationId) return;

    let es: EventSource | null = null;
    let closed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const url = `/api/agents/subagents/stream?conversationId=${encodeURIComponent(subagent.conversationId)}`;
      es = new EventSource(url);

      es.addEventListener("partial", (e: MessageEvent) => {
        if (closed) return;
        try {
          const data = JSON.parse(e.data);
          if (data.sessionId !== subagentId || !data.partial) return;
          setLiveContent(data.partial.content ?? "");
          setLiveThinking(data.partial.thinking ?? undefined);
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener("update", (e: MessageEvent) => {
        if (closed) return;
        let mine: {
          id: string;
          status: string;
          partial?: { content?: string } | null;
        } | null = null;
        try {
          const data = JSON.parse(e.data);
          mine = Array.isArray(data.subagents)
            ? (data.subagents.find((s: { id: string }) => s.id === subagentId) ?? null)
            : null;
        } catch { /* ignore parse errors */ }

        // Drop the live overlay only when the snapshot NO LONGER carries a
        // draft (turn committed or terminal). The DTO keeps `session.partial`
        // while a turn streams, so clearing on its presence would wipe the
        // live text on every interleaved `update` event.
        const draft = !!mine?.partial?.content;
        if (mine && !draft) {
          setLiveContent("");
          setLiveThinking(undefined);
        }

        if (!mine) return;

        // Only refetch when THIS session actually changed status
        // or a streamed turn just committed (draft present → gone).
        const signature = mine.status;
        const committed = hadDraftRef.current && !draft;
        hadDraftRef.current = draft;
        if (lastSeenRef.current === signature && !committed) return;
        lastSeenRef.current = signature;

        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void fetchHistory(false);
        }, 150);
      });

      es.onerror = () => { /* EventSource auto-reconnects */ };
    } catch (err) {
      // SSE unavailable — the 5s poll remains the fallback.
      console.warn("[SubagentChatPanel] SSE unavailable:", err);
    }

    return () => {
      closed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      try { es?.close(); } catch { /* ignore */ }
    };
  }, [subagent?.conversationId, subagentId, fetchHistory]);

  // Auto-scroll when messages update OR when live tokens stream in (the
  // rendered text grows from `partial` increments, so keying only on committed
  // `messages` leaves the panel pinned above the live draft).
  React.useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, liveContent, liveThinking, subagent?.status]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = nearBottom;
  };

  // Map subagent logs to UIMessage structure for MessageRenderer
  const uiMessages = React.useMemo(() => {
    if (!messages) return [];
    return mapSubagentMessages(messages);
  }, [messages]);

  const status = subagent?.status || "pending";

  return (
    <div className="flex h-full flex-col bg-background select-none">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2 shrink-0 bg-card">
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label="Back to subagents list"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 flex flex-col justify-center">
          <span className="text-xs font-semibold truncate text-foreground leading-tight animate-fade-in" title={subagent?.name}>
            {subagent?.name || "Subagent Session"}
          </span>
          <span className="text-[10px] text-muted-foreground truncate leading-normal" title={subagent?.task}>
            {subagent?.task}
          </span>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Message Canvas */}
      <div 
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4"
      >
        {loading && !messages ? (
          <div className="flex h-full flex-col items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        ) : error && !messages ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" />
            <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void fetchHistory(true)}
            >
              Retry
            </Button>
          </div>
        ) : uiMessages.length === 0 && !liveContent && !liveThinking ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground">
            <Bot className="size-7 text-muted-foreground/30 mb-2 animate-pulse" />
            <p className="text-xs font-medium">Initialising subagent workspace...</p>
          </div>
        ) : (
          <div className="space-y-2 py-2">
            {uiMessages.map((msg) => (
              <SubagentMessageRow
                key={msg.id}
                message={msg}
              />
            ))}
            {(liveContent || liveThinking) && (status === "running" || status === "pending") ? (
              <SubagentMessageRow
                key="sa-live-stream"
                message={buildLiveMessage(liveContent, liveThinking)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Message Row ------------------------------ */

const SubagentMessageRow = React.memo(
  function SubagentMessageRowInner({ message }: { message: UIMessage }) {
    const isUser = message.role === "user";

    if (isUser) {
      return (
        <div className="py-1 animate-slide-in">
          <div className="text-right prose-xs max-w-none text-xs text-zinc-800 dark:text-zinc-200">
            <MessageRenderer message={message} />
          </div>
        </div>
      );
    }

    return (
      <div className="py-1 animate-slide-in">
        <div className="prose-xs max-w-none text-xs text-zinc-800 dark:text-zinc-200">
          <MessageRenderer message={message} />
        </div>
      </div>
    );
  },
);

/* ------------------------------ DTO Mapping ------------------------------ */

/** Fold the token-level live draft into a renderable UIMessage (final turn). */
function buildLiveMessage(
  content: string,
  thinking: string | undefined,
): UIMessage {
  const segments: UIMessage["segments"] = [];
  if (thinking) {
    segments.push({
      kind: "thinking",
      id: "sa-live-seg-thinking",
      content: thinking,
    });
  }
  if (content.trim()) {
    segments.push({
      kind: "text",
      id: "sa-live-seg-text",
      content,
    });
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", id: "sa-live-seg-text", content: "" });
  }
  return {
    id: "sa-live-stream",
    role: "assistant",
    content,
    thinking: thinking || undefined,
    createdAt: new Date().toISOString(),
    liveToolCalls: [],
    streaming: true,
    segments,
  };
}

function mapSubagentMessages(messages: SubagentMessage[]): UIMessage[] {
  const uiMessages: UIMessage[] = [];

  // Group tool messages by toolCallId for easy lookup
  const toolResults = new Map<string, SubagentMessage>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool" || msg.role === "system") {
      continue;
    }

    const uiMsg: UIMessage = {
      id: `sa-msg-${i}`,
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content || "",
      thinking: msg.thinking || undefined,
      createdAt: new Date().toISOString(),
      liveToolCalls: [],
      segments: [],
    };

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      uiMsg.liveToolCalls = msg.toolCalls.map((tc) => {
        const resultMsg = toolResults.get(tc.id);
        const rawResult = resultMsg?.content ?? "";
        
        let parsedResult: any = rawResult;
        try {
          parsedResult = JSON.parse(rawResult);
        } catch {}

        return {
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          parsedArgs: (() => {
            try {
              return JSON.parse(tc.arguments);
            } catch {
              return undefined;
            }
          })(),
          result: parsedResult,
          ok: resultMsg ? !rawResult.startsWith("Tool error:") : undefined,
          status: resultMsg ? "done" : "running",
        };
      });

      // Build chronological segments: thinking -> text content -> tool calls
      if (uiMsg.thinking) {
        uiMsg.segments!.push({
          kind: "thinking",
          id: `sa-seg-think-${i}`,
          content: uiMsg.thinking,
        });
      }
      if (uiMsg.content) {
        uiMsg.segments!.push({
          kind: "text",
          id: `sa-seg-text-${i}`,
          content: uiMsg.content,
        });
      }
      for (const tc of msg.toolCalls) {
        uiMsg.segments!.push({
          kind: "tool_call",
          id: `sa-seg-tc-${tc.id}`,
          toolCallId: tc.id,
        });
      }
    } else {
      if (uiMsg.content) {
        uiMsg.segments!.push({
          kind: "text",
          id: `sa-seg-text-${i}`,
          content: uiMsg.content,
        });
      }
    }

    uiMessages.push(uiMsg);
  }

  return uiMessages;
}

/* ------------------------------ Status Badge ------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const label = status;
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-mono font-medium tracking-tight uppercase border max-w-[120px] truncate shrink-0 select-none",
        status === "completed" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
        status === "failed" && "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
        status === "cancelled" && "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
        status === "running" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
        status === "pending" && "bg-zinc-500/10 text-zinc-500 border-zinc-500/20"
      )}
    >
      {status === "running" && (
        <span className="mr-1 size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
      )}
      {label}
    </span>
  );
}

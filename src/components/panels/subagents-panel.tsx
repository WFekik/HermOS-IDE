"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Clock,
  ChevronRight,
  Loader2,
  Compass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore, isPendingConversationId } from "@/stores/app-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SubagentChatPanel } from "./subagent-chat-panel";
import type { Subagent, SubagentStatus } from "@/stores/app-store";

/* ------------------------------------------------------------------ *
 * subagents-panel.tsx — subagent status panel.
 *
 * Mounted as a tab in the right panel (after Office). Shows subagents
 * spawned by the main agent (or manually via the Spawn button). The
 * panel:
 *
 *   - subscribes to live SSE events from
 *     GET /api/agents/subagents/stream?conversationId=<id> for real-time
 *     updates (no polling),
 *   - renders each subagent as a card with name, status badge, task,
 *     created-time, an indeterminate progress bar for running ones,
 *     and a result preview (first 200 chars) for completed ones with
 *     a "Show full" expand toggle,
 *   - exposes a Spawn dialog that POSTs to /api/agents/subagents,
 *   - exposes a Delete button per card (DELETE /api/agents/subagents/[id]).
 *
 * The store owns the subagents array (per active conversation) so the
 * TaskProgress indicator can derive "N subagents running" from the
 * same source of truth. Errors are surfaced via toasts; the panel
 * itself shows graceful empty / loading / unavailable states instead
 * of crashing when the backend endpoint isn't ready yet.
 * ------------------------------------------------------------------ */

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function SubagentsPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const subagents = useAppStore((s) => s.subagents);
  const loading = useAppStore((s) => s.subagentsLoading);
  const error = useAppStore((s) => s.subagentsError);
  const subagentsConversationId = useAppStore((s) => s.subagentsConversationId);
  const refreshSubagents = useAppStore((s) => s.refreshSubagents);
  const setSubagents = useAppStore((s) => s.setSubagents);
  const deleteSubagent = useAppStore((s) => s.deleteSubagent);
  const activeSubagentId = useAppStore((s) => s.activeSubagentId);
  const setActiveSubagentId = useAppStore((s) => s.setActiveSubagentId);

  // Live SSE subscription — replaces polling. On mount / conversation
  // change, open an EventSource to /api/agents/subagents/stream and
  // push received subagent arrays directly into the store.
  React.useEffect(() => {
    if (!activeConversationId) return;
    // Pending conversations have no DB row yet — nothing to stream.
    if (isPendingConversationId(activeConversationId)) {
      useAppStore.getState().clearSubagentsForPending();
      return;
    }
    if (typeof EventSource === "undefined") {
      // Fallback: single fetch when EventSource not available.
      void refreshSubagents(activeConversationId);
      return;
    }

    // Mark this conversation as active so setSubagents passes the guard.
    useAppStore.getState().prepareSubagentsStream(activeConversationId);

    let es: EventSource | null = null;
    let closed = false;

    try {
      const url = `/api/agents/subagents/stream?conversationId=${encodeURIComponent(activeConversationId)}`;
      es = new EventSource(url);

      es.addEventListener("snapshot", (e: MessageEvent) => {
        if (closed) return;
        try {
          const { subagents: list } = JSON.parse(e.data);
          if (list) setSubagents(activeConversationId, list);
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener("update", (e: MessageEvent) => {
        if (closed) return;
        try {
          const { subagents: list } = JSON.parse(e.data);
          if (list) setSubagents(activeConversationId, list);
        } catch { /* ignore parse errors */ }
      });

      // Token-level live drafts feed the in-session SubagentChatPanel view
      // (its own EventSource in subagent-chat-panel.tsx), not the card list —
      // nothing to do here.

      es.onerror = () => {
        // EventSource auto-reconnects; ignore.
      };
    } catch (err) {
      console.warn("[SubagentsPanel] SSE connection failed, fallback to fetch:", err);
      void refreshSubagents(activeConversationId);
    }

    return () => {
      closed = true;
      if (es) {
        try { es.close(); } catch { /* ignore */ }
      }
    };
  }, [activeConversationId, refreshSubagents, setSubagents]);

  const handleDelete = React.useCallback(
    async (s: Subagent) => {
      try {
        await deleteSubagent(s.id);
        toast.success(`Subagent "${s.name}" removed`);
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to remove subagent",
        );
      }
    },
    [deleteSubagent],
  );

  const runningCount = subagents.filter(
    (s) => !TERMINAL_STATUSES.has(s.status),
  ).length;
  const isStale = subagentsConversationId !== activeConversationId;

  if (activeSubagentId) {
    return (
      <SubagentChatPanel
        subagentId={activeSubagentId}
        onBack={() => setActiveSubagentId(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-brand" />
          <span className="text-sm font-medium">Subagents</span>
          <Badge variant="secondary" className="text-[10px] h-4">
            {subagents.length}
          </Badge>
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded-full bg-brand/10 text-brand border border-brand/20">
              <span className="size-1.5 rounded-full bg-brand animate-pulse" />
              {runningCount} running
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0"
                onClick={() =>
                  activeConversationId &&
                  void refreshSubagents(activeConversationId)
                }
                disabled={!activeConversationId}
                aria-label="Refresh subagents"
              >
                <RefreshCw
                  className={cn(
                    "size-3.5",
                    loading && !isStale && "animate-spin",
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1 min-h-0">
        {!activeConversationId ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <Bot className="size-7 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium">No conversation selected</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Select a conversation to see its subagents.
            </p>
          </div>
        ) : isStale || (loading && subagents.length === 0) ? (
          <SubagentsSkeleton />
        ) : error && subagents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-5 text-amber-500" />
            <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => void refreshSubagents(activeConversationId)}
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          </div>
        ) : subagents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <Bot className="size-7 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium">No subagents</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-[240px]">
              Spawn one above, or ask HermOS to delegate a task to a subagent.
            </p>
          </div>
        ) : (
          <ul className="p-2 space-y-1.5">
            <AnimatePresence initial={false}>
              {subagents.map((s) => (
                <SubagentCard
                  key={s.id}
                  subagent={s}
                  onDelete={() => void handleDelete(s)}
                  onClick={() => setActiveSubagentId(s.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/* ------------------------------ Subagent card ------------------------------ */

function SubagentCard({
  subagent,
  onDelete,
  onClick,
}: {
  subagent: Subagent;
  onDelete: (e: React.MouseEvent) => void;
  onClick: () => void;
}) {
  const status = subagent.status;
  const isRunning = status === "running";
  const isPending = status === "pending";

  const createdLabel = React.useMemo(() => {
    try {
      return formatDistanceToNow(new Date(subagent.createdAt), {
        addSuffix: true,
      });
    } catch {
      return "";
    }
  }, [subagent.createdAt]);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border/60 bg-card/80 dark:bg-zinc-950/40 p-3 cursor-pointer transition-all duration-200 shadow-2xs hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-accent/20 dark:hover:bg-zinc-900/50 hover:shadow-xs",
        status === "failed" && "border-rose-500/30 hover:border-rose-500/50",
        status === "completed" && "border-emerald-500/20 hover:border-emerald-500/40"
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusDot name={subagent.name} task={subagent.task} />
          <span className="text-xs font-semibold text-foreground truncate tracking-tight" title={subagent.name}>
            {subagent.name}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <StatusBadge status={status} />
          
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="size-5 p-0 text-muted-foreground/60 hover:text-rose-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(e);
                }}
                aria-label={`Delete subagent ${subagent.name}`}
              >
                <Trash2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Delete</TooltipContent>
          </Tooltip>

          <ChevronRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-all shrink-0 ml-0.5" />
        </div>
      </div>

      <p
        className="mt-1.5 text-[11px] text-muted-foreground/85 line-clamp-2 leading-relaxed font-normal"
        title={subagent.task}
      >
        {subagent.task}
      </p>

      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/60 font-mono">
        <div className="flex items-center gap-1.5 truncate">
          <Clock className="size-2.5 shrink-0" />
          <span>{createdLabel}</span>
        </div>
      </div>

      {/* Ultra-thin progress bar for running / pending subagents */}
      {(isRunning || isPending) && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-muted/20 overflow-hidden">
          {subagent.progress != null &&
          typeof subagent.progress === "number" &&
          subagent.progress > 0 ? (
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-[width] duration-300"
              style={{
                width: `${Math.min(100, Math.max(0, subagent.progress * 100))}%`,
              }}
            />
          ) : (
            <motion.div
              className="h-full w-1/3 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500"
              animate={{ x: ["-100%", "300%"] }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          )}
        </div>
      )}

      {/* Error message for failed subagents */}
      {status === "failed" && subagent.error && (
        <div className="mt-2 rounded border border-rose-500/20 bg-rose-500/5 px-2 py-1 text-[10px] text-rose-500 font-mono truncate" title={subagent.error}>
          {subagent.error}
        </div>
      )}
    </motion.li>
  );
}

function StatusDot({ name, task }: { name?: string; task?: string }) {
  const text = `${name || ""} ${task || ""}`.toLowerCase();
  const isExplore = text.includes("explore") || text.includes("architect") || text.includes("research") || text.includes("review") || text.includes("inspect") || text.includes("read-only") || text.includes("plan");

  if (isExplore) {
    return <Compass className="size-3.5 text-brand shrink-0" />;
  }
  return <Bot className="size-3.5 text-brand shrink-0" />;
}

function StatusBadge({ status }: { status: SubagentStatus }) {
  if (status === "running") {
    return <Loader2 className="size-3.5 text-brand animate-spin shrink-0" />;
  }
  if (status === "completed") {
    return <span className="text-[10px] font-mono text-brand font-medium">completed</span>;
  }
  if (status === "failed") {
    return <span className="text-[10px] font-mono text-rose-600 dark:text-rose-400 font-medium">failed</span>;
  }
  return null;
}

/* ------------------------------ Skeleton ------------------------------ */

function SubagentsSkeleton() {
  return (
    <div className="p-2 space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border/40 bg-card/50 p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-muted/60 animate-pulse" />
              <div className="h-3 w-24 rounded bg-muted/60 animate-pulse" />
            </div>
            <div className="h-3.5 w-14 rounded-full bg-muted/60 animate-pulse" />
          </div>
          <div className="h-3.5 w-full rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-muted/40 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

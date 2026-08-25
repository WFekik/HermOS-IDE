"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
  ChevronDown,
  ChevronUp,
  ListTodo,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";

/* ------------------------------------------------------------------ *
 * todo-collapsed-banner.tsx
 *
 * The compromise between "users want to see agent progress" and "the
 * full todo panel is heavy and poll-heavy". A slim, collapsible
 * banner pinned above the composer.
 *
 * Design choices:
 *   - Collapsed by default so it doesn't hijack composer space.
 *     When things are boring (no todos) the banner is invisible — no
 *     tab clutter, no rail icon, no right-panel slot.
 *   - No add / edit / delete controls — those are gone. The agent
 *     is the sole actor; the user only watches progress.
 *   - SSE-driven: the banner subscribes to /api/todos/stream and
 *     writes the array straight to local state. React Query is used
 *     only as a tiny cache + error surface so React Query's retry
 *     behavior kicks in if the SSE endpoint is down.
 *   - The agent's `todo_write` tool result is stripped from the
 *     assistant's visible text upstream in `lib/sanitize-content.ts`
 *     so the user never sees raw JSON; this banner is the only place
 *     the list is exposed.
 * ------------------------------------------------------------------ */

export type AgentTodoStatus = "pending" | "in_progress" | "completed";
type TodoLite = {
  id: string;
  content?: string;
  text?: string;
  status?: string;
  completed?: boolean;
  priority?: string;
};

interface StreamResponse {
  todos: TodoLite[];
}

function statusIcon(status: string): React.ElementType {
  switch (status) {
    case "completed":
      return CheckCircle2;
    case "in_progress":
      return CircleDot;
    default:
      return CircleDashed;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600 dark:text-emerald-400";
    case "in_progress":
      return "text-brand";
    default:
      return "text-muted-foreground";
  }
}

interface TodoCollapsedBannerProps {
  conversationId: string | null;
}

export function TodoCollapsedBanner({ conversationId }: TodoCollapsedBannerProps) {
  const [hasSeenFirst, setHasSeenFirst] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [liveTodos, setLiveTodos] = React.useState<TodoLite[] | null>(null);

  const storeTodos = useAppStore((s) =>
    conversationId ? s.activeTodosByConversation[conversationId] : undefined
  );

  // Reset live-stream state when switching conversations so a stale list from
  // the previous conversation never flashes (the new stream re-delivers its own snapshot).
  React.useEffect(() => {
    setLiveTodos(null);
    setHasSeenFirst(false);
    setExpanded(false);
  }, [conversationId]);

  const { data, error } = useQuery<StreamResponse>({
    queryKey: ["todos-stream", conversationId],
    enabled: !!conversationId,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: 3,
    queryFn: async ({ signal }) => {
      if (!conversationId) throw new Error("No conversation");
      const res = await fetch(
        `/api/todos/stream?conversationId=${encodeURIComponent(conversationId)}`,
        { signal, credentials: "include" },
      );
      if (!res.ok || !res.body) {
        throw new Error(`Todo stream failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let snapshot: TodoLite[] | null = null;
      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
          throw new Error("aborted");
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(":")) continue; // heartbeat
          const lines = frame.split("\n");
          let event = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLine += line.slice(6);
          }
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine);
            if (event === "snapshot") {
              snapshot = (parsed.todos as TodoLite[]) ?? [];
              setLiveTodos(snapshot);
              setHasSeenFirst(true);
            } else if (event === "update") {
              const next = (parsed.todos as TodoLite[]) ?? [];
              setLiveTodos(next);
              if (!hasSeenFirst) setHasSeenFirst(true);
            }
          } catch {
            // ignore malformed frame
          }
        }
      }
      return { todos: snapshot ?? [] };
    },
  });

  // The SSE stream is the source of truth: once it has delivered a frame
  // (including an empty list after todo_clear / auto-clear), it wins over the
  // store snapshot. The store is only a fallback for the pre-stream moment.
  const todos = liveTodos !== null ? liveTodos : (storeTodos ?? data?.todos ?? null);

  // Auto-expand the very first time the agent publishes todos.
  // This hook must run before any conditional return so React's
  // rules-of-hooks lint stays happy.
  React.useEffect(() => {
    if ((todos?.length ?? 0) > 0 && !hasSeenFirst) {
      setExpanded(true);
      setHasSeenFirst(true);
    }
  }, [todos?.length, hasSeenFirst]);

  // Hide entirely when there are no todos (the agent hasn't started).
  if (!todos || todos.length === 0) return null;

  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed" || t.completed === true).length;
  const remaining = total - completed;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="rounded-lg border border-border/40 bg-zinc-500/5 shadow-xs overflow-hidden mb-2"
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-muted/60 transition-colors"
        aria-expanded={expanded}
      >
        <ListTodo className="size-3.5 text-brand shrink-0" />
        <span className="font-medium text-foreground">
          {total} task{total === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">
          · {completed}/{total} done
        </span>
        <div className="flex-1 mx-2 h-1.5 rounded-full bg-background overflow-hidden max-w-[140px]">
          <div
            className="h-full bg-brand transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        {remaining > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {remaining} remaining
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronUp className="size-3" />
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ul
            key="todo-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 py-2 space-y-1 max-h-44 overflow-y-auto">
              {todos.map((t) => {
                const status = t.status ?? (t.completed ? "completed" : "pending");
                const Icon = statusIcon(status);
                return (
                  <li
                    key={t.id}
                    className="flex items-start gap-2 text-xs"
                  >
                    <Icon className={cn("size-3.5 mt-0.5 shrink-0", statusClass(status))} />
                    <span
                      className={cn(
                        "flex-1 min-w-0 break-words",
                        status === "completed" && "line-through text-muted-foreground",
                      )}
                    >
                      {t.content ?? t.text ?? ""}
                    </span>
                  </li>
                );
              })}
              {error && (
                <li className="flex items-center gap-2 text-[10px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3" />
                  Live task updates unavailable — reconnecting…
                </li>
              )}
            </div>
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default TodoCollapsedBanner;
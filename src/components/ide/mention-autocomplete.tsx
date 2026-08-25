"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText,
  Sparkles,
  Plug,
  Bot,
  SlashSquare,
  Loader2,
  Hash,
  CornerDownLeft,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { apiGet, ApiRequestError } from "@/lib/api-client";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ *
 * mention-autocomplete.tsx — @mention + /command popover
 *
 * Rendered above the composer textarea. The composer owns trigger
 * detection (it knows the textarea + cursor position) and passes the
 * active trigger + query via props. This component is purely
 * presentational: it fetches / derives suggestions, handles keyboard
 * navigation, and calls `onPick(insertText)` when the user selects an
 * item. The composer is responsible for splicing `insertText` into
 * the textarea at the trigger position.
 * ------------------------------------------------------------------ */

export type MentionTriggerKind = "mention" | "command";

export interface MentionTrigger {
  kind: MentionTriggerKind;
  /** Character index of the `@` or `/` in the textarea value. */
  start: number;
  /** Character index of the cursor (end of the query). */
  end: number;
  /** Text between the trigger and the cursor (excluding the `@`/`/`). */
  query: string;
}

interface MentionAutocompleteProps {
  trigger: MentionTrigger | null;
  /** Called with the text to insert (replaces trigger+query). */
  onPick: (insertText: string) => void;
  /** Called when the user dismisses (Escape or click-away). */
  onClose: () => void;
}

/* ------------------------------------------------------------------ *
 * Suggestion model
 * ------------------------------------------------------------------ */

interface Suggestion {
  id: string;
  category: "file" | "skill" | "mcp" | "agent" | "command";
  /** Primary label (e.g. file path, skill name, command). */
  label: string;
  /** Secondary description (e.g. "skill", "mcp server · n tools"). */
  description?: string;
  /** Text to insert at the trigger position (includes the @ prefix). */
  insertText: string;
  icon: LucideIcon;
}

/* ------------------------------------------------------------------ *
 * Workspace tree cache (module-level, shared with command palette).
 * Fetches the tree lazily on first @file: query and reuses it for
 * subsequent ones. Invalidated only on full page reload.
 * ------------------------------------------------------------------ */

interface FlatFile {
  path: string;
  name: string;
}

interface FileNodeShape {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNodeShape[];
}

function flattenFiles(nodes: FileNodeShape[], acc: FlatFile[] = []): FlatFile[] {
  for (const n of nodes) {
    if (n.type === "file") {
      acc.push({ path: n.path, name: n.name });
    } else if (n.type === "dir" && n.children) {
      flattenFiles(n.children, acc);
    }
  }
  return acc;
}

let treeCache: FlatFile[] | null = null;
let treeFetchInFlight: Promise<FlatFile[]> | null = null;

async function fetchTreeFiles(): Promise<FlatFile[]> {
  if (treeCache) return treeCache;
  if (treeFetchInFlight) return treeFetchInFlight;
  treeFetchInFlight = (async () => {
    try {
      const res = await apiGet<{ tree: FileNodeShape[] }>(
        "/api/workspace/tree",
      );
      const files = flattenFiles(res?.tree ?? []);
      treeCache = files;
      return files;
    } finally {
      treeFetchInFlight = null;
    }
  })();
  return treeFetchInFlight;
}

/* ------------------------------------------------------------------ *
 * Static command list (shown when `/` is the trigger at start of message)
 * ------------------------------------------------------------------ */

const STATIC_COMMANDS: Suggestion[] = [
  {
    id: "cmd:clear",
    category: "command",
    label: "/clear",
    description: "Clear the conversation history",
    insertText: "/clear ",
    icon: SlashSquare,
  },
  {
    id: "cmd:compact",
    category: "command",
    label: "/compact",
    description: "Summarize prior messages into a shorter context",
    insertText: "/compact ",
    icon: SlashSquare,
  },
  {
    id: "cmd:help",
    category: "command",
    label: "/help",
    description: "Show available commands and shortcuts",
    insertText: "/help ",
    icon: SlashSquare,
  },
];

/* ------------------------------------------------------------------ *
 * MentionAutocomplete — the popover component.
 * ------------------------------------------------------------------ */

const MAX_RESULTS = 50;
const DEBOUNCE_MS = 100;

export function MentionAutocomplete({
  trigger,
  onPick,
  onClose,
}: MentionAutocompleteProps) {
  const [items, setItems] = React.useState<Suggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  const mcpServers = useAppStore((s) => s.mcpServers);
  const skills = useAppStore((s) => s.skills);
  const agentPresets = useAppStore((s) => s.agentPresets);

  // Reset active index when the item list changes.
  React.useEffect(() => {
    setActiveIdx(0);
  }, [items]);

  // Scroll active item into view during keyboard navigation
  React.useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.children[activeIdx] as HTMLElement | undefined;
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [activeIdx]);

  // Debounced fetch + derive suggestions whenever the trigger / query
  // changes. We compute everything locally except the file list (which
  // hits /api/workspace/tree, cached at module scope).
  React.useEffect(() => {
    if (!trigger) {
      setItems([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const t = setTimeout(async () => {
      if (trigger.kind === "command") {
        // Build command suggestions: static + dynamic /agent and /model.
        const q = trigger.query.toLowerCase();
        const dynamic: Suggestion[] = [];

        // /agent <name> — one entry per preset.
        for (const p of agentPresets.slice(0, 6)) {
          dynamic.push({
            id: `agent:${p.id}`,
            category: "agent",
            label: `/agent ${p.name}`,
            description: p.description?.slice(0, 60) || "Switch to agent preset",
            insertText: `/agent ${p.name} `,
            icon: Bot,
          });
        }
        // /model <provider>/<model> — one entry per configured provider+model.
        // We don't have the full provider list here cheaply; show a single
        // template hint instead so the user knows the shape.
        dynamic.push({
          id: "cmd:model",
          category: "command",
          label: "/model <provider>/<model>",
          description: "Switch model — e.g. /model openai/gpt-4o",
          insertText: "/model ",
          icon: SlashSquare,
        });

        const all = [...STATIC_COMMANDS, ...dynamic];
        const filtered = q
          ? all.filter((s) => s.label.toLowerCase().includes(q))
          : all;
        if (!cancelled) {
          setItems(filtered.slice(0, MAX_RESULTS));
          setLoading(false);
        }
        return;
      }

      // Mention mode — parse the query for a category prefix.
      const raw = trigger.query;
      const colonIdx = raw.indexOf(":");
      let category: "file" | "skill" | "mcp" | "agent" | null = null;
      let term = raw;
      if (colonIdx > 0 && colonIdx <= 6) {
        const prefix = raw.slice(0, colonIdx).toLowerCase();
        if (prefix === "file" || prefix === "skill" || prefix === "mcp" || prefix === "agent") {
          category = prefix;
          term = raw.slice(colonIdx + 1);
        }
      }
      const q = term.toLowerCase();

      setLoading(true);

      const built: Suggestion[] = [];

      // Files (lazy-loaded, cached).
      if (!category || category === "file") {
        try {
          const files = await fetchTreeFiles();
          if (cancelled) return;
          const matched = q
            ? files.filter(
                (f) =>
                  f.name.toLowerCase().includes(q) ||
                  f.path.toLowerCase().includes(q),
              )
            : files;
          for (const f of matched.slice(0, category ? MAX_RESULTS : 15)) {
            const safePath = f.path.includes(" ") ? `"${f.path}"` : f.path;
            built.push({
              id: `file:${f.path}`,
              category: "file",
              label: f.path,
              description: f.name,
              insertText: `@file:${safePath} `,
              icon: FileText,
            });
          }
        } catch (e) {
          // 401 / network — leave files empty. Don't crash the popover.
          if (!(e instanceof ApiRequestError && (e.status === 401 || e.status === 404))) {
            // unexpected — ignore anyway
          }
        }
      }

      // Skills.
      if (!category || category === "skill") {
        const matched = q
          ? skills.filter((s) => s.name.toLowerCase().includes(q))
          : skills;
        for (const s of matched.slice(0, category ? MAX_RESULTS : 10)) {
          const safeName = s.name.includes(" ") ? `"${s.name}"` : s.name;
          built.push({
            id: `skill:${s.id}`,
            category: "skill",
            label: s.name,
            description: s.description?.slice(0, 60) || "skill",
            insertText: `@skill:${safeName} `,
            icon: Sparkles,
          });
        }
      }

      // MCP servers (connected first).
      if (!category || category === "mcp") {
        const sorted = [...mcpServers].sort((a, b) => {
          if (a.status === "connected" && b.status !== "connected") return -1;
          if (b.status === "connected" && a.status !== "connected") return 1;
          return a.name.localeCompare(b.name);
        });
        const matched = q
          ? sorted.filter((s) => s.name.toLowerCase().includes(q))
          : sorted;
        for (const s of matched.slice(0, category ? MAX_RESULTS : 10)) {
          const toolCount = s.tools?.length ?? 0;
          const safeName = s.name.includes(" ") ? `"${s.name}"` : s.name;
          built.push({
            id: `mcp:${s.id}`,
            category: "mcp",
            label: s.name,
            description:
              s.status === "connected"
                ? `mcp · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
                : `mcp · ${s.status}`,
            insertText: `@mcp:${safeName} `,
            icon: Plug,
          });
        }
      }

      // Agent presets.
      if (!category || category === "agent") {
        const matched = q
          ? agentPresets.filter((p) => p.name.toLowerCase().includes(q))
          : agentPresets;
        for (const p of matched.slice(0, category ? MAX_RESULTS : 10)) {
          const safeName = p.name.includes(" ") ? `"${p.name}"` : p.name;
          built.push({
            id: `agent:${p.id}`,
            category: "agent",
            label: p.name,
            description: p.description?.slice(0, 60) || "agent preset",
            insertText: `@agent:${safeName} `,
            icon: Bot,
          });
        }
      }

      if (!cancelled) {
        setItems(built.slice(0, MAX_RESULTS));
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trigger, mcpServers, skills, agentPresets]);

  // Keyboard handler — attached to window so we capture ArrowUp/Down/Enter/
  // Tab/Escape regardless of which element has focus inside the textarea.
  // We only act when the popover is open (trigger != null).
  React.useEffect(() => {
    if (!trigger) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) =>
          items.length === 0 ? 0 : (i - 1 + items.length) % items.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length === 0) return;
        e.preventDefault();
        const sel = items[activeIdx];
        if (sel) onPick(sel.insertText);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [trigger, items, activeIdx, onPick, onClose]);

  if (!trigger) return null;

  const heading =
    trigger.kind === "command"
      ? "Commands"
      : (() => {
          const colonIdx = trigger.query.indexOf(":");
          if (colonIdx > 0 && colonIdx <= 6) {
            const prefix = trigger.query.slice(0, colonIdx).toLowerCase();
            if (prefix === "file") return "Files";
            if (prefix === "skill") return "Skills";
            if (prefix === "mcp") return "MCP servers";
            if (prefix === "agent") return "Agents";
          }
          return "Mention";
        })();

  return (
    <AnimatePresence>
      {trigger && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          className="absolute bottom-full left-0 right-0 z-30 mb-2 mx-auto max-w-2xl"
          role="listbox"
          aria-label="Mention suggestions"
        >
          <div className="rounded-lg border bg-popover shadow-lg overflow-hidden max-h-[min(420px,80vh)] flex flex-col">
            <div className="flex items-center justify-between border-b px-3 py-1.5 shrink-0">
              <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
                {heading}
              </span>
              {loading && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
              {!loading && items.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {items.length} result{items.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {items.length === 0 && !loading ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No matches. Try{" "}
                  <span className="font-mono">@file:</span>,{" "}
                  <span className="font-mono">@skill:</span>,{" "}
                  <span className="font-mono">@mcp:</span>, or{" "}
                  <span className="font-mono">@agent:</span>
                </div>
              ) : (
                <ul ref={listRef} className="space-y-0.5">
                  {items.map((s, i) => {
                    const Icon = s.icon;
                    const active = i === activeIdx;
                    return (
                      <li key={s.id} role="option" aria-selected={active}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveIdx(i)}
                          onClick={() => onPick(s.insertText)}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                            active
                              ? "bg-accent text-foreground font-medium"
                              : "hover:bg-accent/60",
                          )}
                        >
                          <Icon
                            className={cn(
                              "size-3.5 shrink-0",
                              active ? "text-brand" : "text-muted-foreground",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono truncate text-foreground">
                                {s.label}
                              </span>
                              <CategoryBadge category={s.category} />
                            </div>
                            {s.description && (
                              <div className="truncate text-[10px] text-muted-foreground">
                                {s.description}
                              </div>
                            )}
                          </div>
                          {active && (
                            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground font-mono shrink-0">
                              <CornerDownLeft className="size-2.5" />
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-between border-t px-3 py-1 text-[10px] text-muted-foreground font-mono">
              <span className="flex items-center gap-2">
                <span>
                  <Hash className="inline size-2.5" /> ↑↓ navigate
                </span>
                <span>↵ select</span>
                <span>esc dismiss</span>
              </span>
              <span className="hidden sm:inline">
                prefix with <span className="text-brand">@file:</span> /{" "}
                <span className="text-brand">@skill:</span> /{" "}
                <span className="text-brand">@mcp:</span> /{" "}
                <span className="text-brand">@agent:</span>
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CategoryBadge({
  category,
}: {
  category: Suggestion["category"];
}) {
  const labels: Record<Suggestion["category"], string> = {
    file: "file",
    skill: "skill",
    mcp: "mcp",
    agent: "agent",
    command: "cmd",
  };
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[9px] font-mono uppercase tracking-wide",
        category === "file" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        category === "skill" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        category === "mcp" && "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400",
        category === "agent" && "bg-brand/10 text-brand",
        category === "command" && "bg-muted text-muted-foreground",
      )}
    >
      {labels[category]}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Helper — detect the active mention/command trigger in a textarea.
 * Returns null when no trigger is active. Used by the composer.
 * ------------------------------------------------------------------ */

export function detectTrigger(
  value: string,
  cursor: number,
): MentionTrigger | null {
  if (cursor <= 0) return null;
  const before = value.slice(0, cursor);
  // Find the last `@` in the text before the cursor where all chars
  // between it and the cursor are word-ish (no whitespace, no other @).
  const atIdx = before.lastIndexOf("@");
  if (atIdx >= 0) {
    const isAtMessageStart = atIdx === 0 || value[atIdx - 1] === "\n";
    const isIsolated =
      atIdx === 0 ||
      /[\s({[]/.test(value[atIdx - 1]) ||
      isAtMessageStart;
    const segment = value.slice(atIdx + 1, cursor);
    // Allow word chars, `:` (for category prefix), `/`, `.`, `-`, `_`.
    if (isIsolated && /^[\w/.:-]*$/.test(segment) && !segment.includes("@")) {
      // Don't trigger if the segment is huge (likely not an intentional mention).
      if (segment.length <= 80) {
        return {
          kind: "mention",
          start: atIdx,
          end: cursor,
          query: segment,
        };
      }
    }
  }

  // `/` at the start of the message → command mode. The slash must be
  // the very first char (or the first char of a new line) and the
  // segment between `/` and the cursor must have no whitespace.
  const lineStart = before.lastIndexOf("\n") + 1;
  if (lineStart < cursor && value[lineStart] === "/") {
    const segment = value.slice(lineStart + 1, cursor);
    if (/^\w*$/.test(segment) && segment.length <= 32) {
      return {
        kind: "command",
        start: lineStart,
        end: cursor,
        query: segment,
      };
    }
  }

  return null;
}

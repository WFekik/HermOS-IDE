"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  Brain,
  Loader2,
  CheckCircle2,
  Sparkles,
  Download,
  ExternalLink,
  BookOpen,
  Search,
  Bot,
  Compass,
  Folder,
  FilePlus2,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { LiveToolCall } from "@/stores/app-store";
import { CodeBlock } from "@/components/ide/code-block";
import { ToolCallCard, ToolResultBody, safeParse, FileTypeIcon, extractFilePath } from "@/components/ide/tool-call-card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { FILE_OP_TOOLS, computeDiffStats, formatBytes } from "@/lib/tool-ui-shared";
import { sanitizeContent, sanitizeThinkingContent, extractThinkingAndContent } from "@/lib/sanitize-content";
import type { AttachmentDTO } from "@/lib/types";
import type { UIMessage } from "@/stores/app-store";
import { openExternalUrl } from "@/lib/open-external";

/**
 * Memoized sanitize for stable segment contents. `sanitizeContent` is pure
 * and idempotent, so unchanged segments can skip the full pipeline on every
 * streaming frame without any behavioural difference.
 */
const sanitizeCache = new Map<string, string>();
function cachedSanitize(content: string): string {
  const prev = sanitizeCache.get(content);
  if (prev !== undefined) return prev;
  const out = sanitizeContent(content);
  if (sanitizeCache.size > 500) sanitizeCache.clear();
  sanitizeCache.set(content, out);
  return out;
}

const sanitizeThinkingCache = new Map<string, string>();
function cachedSanitizeThinking(content: string): string {
  const prev = sanitizeThinkingCache.get(content);
  if (prev !== undefined) return prev;
  const out = sanitizeThinkingContent(content);
  if (sanitizeThinkingCache.size > 500) sanitizeThinkingCache.clear();
  sanitizeThinkingCache.set(content, out);
  return out;
}

interface MessageRendererProps {
  message: UIMessage;
}

export function MessageRenderer({ message }: MessageRendererProps) {
  // Reconstruct segments dynamically for assistant messages when they are missing or empty,
  // to ensure they are rendered natively and cleanly in separate sequential blocks
  let segments = message.segments;
  if (message.role === "assistant" && (!segments || segments.length === 0)) {
    segments = buildSegmentsFromFlat(message);
  }
  // Also check if segments exist but are missing text content that message.content has.
  // This happens with external reasoning models where the text between thinking and
  // tool call was accumulated in message.content but not persisted in segments.
  if (
    message.role === "assistant" &&
    segments &&
    segments.length > 0 &&
    message.content &&
    message.content.trim() &&
    !segments.some((s: any) => s.kind === "text")
  ) {
    // Append the text segment at the end of segments to preserve chronological order:
    // thinking → tool_calls → text
    const textSeg = { kind: "text" as const, id: `reconstructed-text-${message.id}`, content: message.content };
    segments = [...segments, textSeg];
  }

  // When segments exist (segmented flow), render them in
  // chronological order so think / tool-call / text / think / … shows as
  // the agent built it up — like opencode. Otherwise fall back to the
  // legacy flat rendering for older messages or non-streaming context.
  if (segments && segments.length > 0) {
    return <SegmentedMessageRenderer message={message} reconstructedSegments={segments} />;
  }
  return <FlatMessageRenderer message={message} />;
}

/** Build segments from the flat message fields (thinking, content, liveToolCalls). */
function buildSegmentsFromFlat(message: UIMessage): any[] {
  const segments: any[] = [];
  const { thinking: extractedThinking, content: cleanContent } = extractThinkingAndContent(
    message.content ?? "",
    message.thinking,
  );

  if (extractedThinking && extractedThinking.trim()) {
    segments.push({
      kind: "thinking" as const,
      id: `reconstructed-think-${message.id}`,
      content: extractedThinking,
    });
  }
  if (message.liveToolCalls && message.liveToolCalls.length > 0) {
    for (const tc of message.liveToolCalls) {
      segments.push({
        kind: "tool_call" as const,
        id: `reconstructed-tc-${tc.id}`,
        toolCallId: tc.id,
      });
    }
  }
  if (cleanContent && cleanContent.trim()) {
    segments.push({
      kind: "text" as const,
      id: `reconstructed-text-${message.id}`,
      content: cleanContent,
    });
  }
  return segments;
}

interface RenderSegment {
  kind: "thinking" | "text" | "tool_call";
  id: string;
  content?: string;
  toolCallId?: string;
}

const HIDDEN_TOOLS = new Set([
  "get_subagent",
  "todo_write",
  "todo_read",
  "todo_clear",
  "command_stop",
  "ask_question",
]);

export function mergeSegments(
  rawSegments: any[],
  toolCallById: Map<string, LiveToolCall>,
): RenderSegment[] {
  const result: RenderSegment[] = [];

  for (const seg of rawSegments) {
    if (!seg) continue;

    if (seg.kind === "tool_call") {
      const tc = toolCallById.get(seg.toolCallId ?? "");
      // Skip hidden tool calls and ghost tool calls so that adjacent reasoning blocks merge cleanly
      if (!tc || HIDDEN_TOOLS.has(tc.name)) {
        continue;
      }
      result.push({
        kind: "tool_call",
        id: seg.id || `tc-${seg.toolCallId}`,
        toolCallId: seg.toolCallId,
      });
      continue;
    }

    const content = (seg.content ?? "");
    // Skip empty whitespace-only segments so they don't break block continuity
    if (!content.trim()) continue;

    const last = result[result.length - 1];
    // Merge adjacent segments of the exact same kind
    if (last && last.kind === seg.kind) {
      const separator = last.kind === "thinking" && last.content && content ? "\n\n" : "";
      last.content = (last.content ?? "") + separator + content;
    } else {
      result.push({
        kind: seg.kind,
        id: seg.id || `${seg.kind}-${Math.random()}`,
        content,
      });
    }
  }

  return result;
}

function SegmentedMessageRenderer({
  message,
  reconstructedSegments,
}: {
  message: UIMessage;
  reconstructedSegments?: any[];
}) {
  const rawSegments = reconstructedSegments ?? message.segments ?? [];
  const liveToolCalls = message.liveToolCalls ?? [];
  const toolCallById = React.useMemo(
    () => new Map(liveToolCalls.map((t) => [t.id, t])),
    [liveToolCalls],
  );
  const segments = React.useMemo(
    () => mergeSegments(rawSegments, toolCallById),
    [rawSegments, toolCallById],
  );
  const streaming = !!message.streaming;

  const thinkingExpanded = useAppStore((s) => s.thinkingExpanded);
  const setThinkingExpanded = useAppStore((s) => s.setThinkingExpanded);

  // The "is currently thinking" state — only when the streaming message has
  // started but hasn't appended any visible content yet. Looks at the last
  // segment so a partially-built text block doesn't get re-labeled as
  // "thinking".
  const last = segments[segments.length - 1];
  const hasThinkingSeg = segments.some((s) => s.kind === "thinking");
  const hasAnyVisible =
    segments.some(
      (s) =>
        (s.kind === "text" && (s.content ?? "").trim().length > 0) ||
        (s.kind === "tool_call" && s.toolCallId),
    );
  const isThinking =
    streaming && !hasAnyVisible && !hasThinkingSeg;

  const groupedItems = React.useMemo(
    () => groupSegmentItems(segments, toolCallById),
    [segments, toolCallById],
  );

  return (
    <div className="space-y-2 overflow-hidden">
      {groupedItems.map((item, idx) => {
        const hasNextItem = idx < groupedItems.length - 1;
        if (item.type === "read_group") {
          return (
            <ToolBatchBlock
              key={item.key}
              toolCalls={item.toolCalls}
              hasNextItem={hasNextItem}
              isStreaming={streaming}
              kind="read"
            />
          );
        }
        if (item.type === "search_group") {
          return (
            <ToolBatchBlock
              key={item.key}
              toolCalls={item.toolCalls}
              hasNextItem={hasNextItem}
              isStreaming={streaming}
              kind="search"
            />
          );
        }
        const seg = item.seg;
        if (seg.kind === "thinking") {
          const sanitized = cachedSanitizeThinking(seg.content ?? "");
          if (!sanitized && !streaming) {
            return null;
          }
          const isLiveThinking = streaming && seg === last;
          const isExpanded = thinkingExpanded[seg.id] ?? isLiveThinking;
          return (
            <ThinkingBlock
              key={seg.id}
              open={isExpanded}
              onOpenChange={(v) => setThinkingExpanded(seg.id, v)}
              isLive={isLiveThinking}
              content={sanitized}
              emptyLabel="Thinking…"
            />
          );
        }
        if (seg.kind === "text") {
          const sanitized = cachedSanitize(seg.content ?? "");
          const showCursor = streaming && seg === last;
          return (
            <div key={seg.id} className="overflow-hidden">
              <MarkdownContent content={sanitized} streaming={streaming && seg === last} />
              {showCursor && sanitized.trim() !== "" && <StreamingCursor />}
            </div>
          );
        }
        const tc = toolCallById.get(seg.toolCallId ?? "");
        if (!tc) return null;
        if (HIDDEN_TOOLS.has(tc.name)) return null;

        if (tc.name === "spawn_subagent") {
          return <SubagentBlock key={seg.id} tc={tc} />;
        }
        if (tc.name === "message_subagent") {
          return <SubagentMessageBlock key={seg.id} tc={tc} />;
        }
        if (FILE_OP_TOOLS.has(tc.name)) {
          return <FileOpBlock key={seg.id} tc={tc} />;
        }
        return (
          <div key={seg.id} className="space-y-1.5 overflow-hidden">
            <ToolCallCard tc={tc} />
          </div>
        );
      })}
      {message.attachments && message.attachments.length > 0 && (
        <div className="space-y-1">
          {message.attachments.map((att) => (
            <AttachmentBlock key={att.id} att={att} />
          ))}
        </div>
      )}
      {isThinking && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground overflow-hidden">
          <Brain className="size-3.5 text-brand animate-pulse shrink-0" />
          <span className="truncate">Thinking…</span>
        </div>
      )}
      {message.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {message.error}
        </div>
      )}
    </div>
  );
}

function FlatMessageRenderer({ message }: { message: UIMessage }) {
  const thinkingExpanded = useAppStore((s) => s.thinkingExpanded);
  const setThinkingExpanded = useAppStore((s) => s.setThinkingExpanded);

  const extracted = extractThinkingAndContent(message.content ?? "", message.thinking);
  let thinking = extracted.thinking ? cachedSanitizeThinking(extracted.thinking) : undefined;
  if (thinking && (thinking.length <= 3 || !/[a-zA-Z0-9]/.test(thinking))) {
    thinking = undefined;
  }
  const hasToolCalls = (message.liveToolCalls?.length ?? 0) > 0;

  const isToolLeak =
    message.role === "tool" ||
    /^\s*<tool_result/.test(extracted.content);

  const sanitized = isToolLeak ? "" : cachedSanitize(extracted.content);
  const isThinking =
    message.streaming && sanitized === "" && !hasToolCalls && !isToolLeak;

  const groupedToolCalls = React.useMemo(
    () => (hasToolCalls ? groupFlatToolCalls(message.liveToolCalls!) : []),
    [hasToolCalls, message.liveToolCalls],
  );

  return (
    <div className="space-y-2">
      {(thinking || isThinking) && (
        <ThinkingBlock
          open={thinkingExpanded[message.id] ?? isThinking}
          onOpenChange={(v) => setThinkingExpanded(message.id, v)}
          isLive={!!isThinking}
          content={thinking ?? ""}
          emptyLabel="Analyzing your request…"
        />
      )}
      {hasToolCalls && (
        <div className="space-y-1.5">
          {groupedToolCalls.map((group, idx) => {
            const hasNextItem = idx < groupedToolCalls.length - 1;
            if (group.type === "read_group") {
              return (
                <ToolBatchBlock
                  key={`read-group-${idx}`}
                  toolCalls={group.toolCalls}
                  hasNextItem={hasNextItem}
                  isStreaming={!!message.streaming}
                  kind="read"
                />
              );
            }
            if (group.type === "search_group") {
              return (
                <ToolBatchBlock
                  key={`search-group-${idx}`}
                  toolCalls={group.toolCalls}
                  hasNextItem={hasNextItem}
                  isStreaming={!!message.streaming}
                  kind="search"
                />
              );
            }
            const tc = group.tc;
            if (tc.name === "spawn_subagent") {
              return <SubagentBlock key={tc.id} tc={tc} />;
            }
            if (tc.name === "message_subagent") {
              return <SubagentMessageBlock key={tc.id} tc={tc} />;
            }
            if (FILE_OP_TOOLS.has(tc.name)) {
              return <FileOpBlock key={tc.id} tc={tc} />;
            }
            return <ToolCallCard key={tc.id} tc={tc} />;
          })}
        </div>
      )}
      <MarkdownContent content={sanitized} streaming={!!message.streaming} />
      {message.streaming && sanitized !== "" && <StreamingCursor />}
      {message.attachments && message.attachments.length > 0 && (
        <div className="space-y-1 mt-2">
          {message.attachments.map((att) => (
            <AttachmentBlock key={att.id} att={att} />
          ))}
        </div>
      )}
      {message.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {message.error}
        </div>
      )}
    </div>
  );
}

/**
 * Three emerald dots with a subtle staggered pulse — used as the
 * streaming cursor that follows newly-arrived text. Replaces the old
 * single pulsing dot with a softer wave animation.
 */
function StreamingCursor() {
  return (
    <span
      className="inline-flex items-center gap-[2px] align-baseline ml-0.5"
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block size-[3px] rounded-full bg-brand"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -1, 0] }}
          transition={{
            duration: 0.85,
            repeat: Infinity,
            delay: i * 0.12,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  );
}

const markdownComponents: Components = {
  pre({ children }) {
    // We render code blocks via the `code` renderer above; pre is just a passthrough.
    return <>{children}</>;
  },
  a({ children, href }) {
    const rawHref = (href ?? "").trim();
    let decodedHref = rawHref;
    try {
      decodedHref = decodeURIComponent(rawHref);
    } catch {}
    const normalizedScheme = decodedHref.toLowerCase().replace(/[\x00-\x20]/g, "");
    if (
      normalizedScheme.startsWith("javascript:") ||
      normalizedScheme.startsWith("data:text/html") ||
      normalizedScheme.startsWith("vbscript:")
    ) {
      return <span>{children}</span>;
    }

    let cleanPath = (href ?? "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch {}
    const isWebUrl = Boolean(href?.startsWith("http://") || href?.startsWith("https://"));

    if (!isWebUrl && href) {
      const isMd = Boolean(
        cleanPath.toLowerCase().endsWith(".md") ||
        cleanPath.includes("implementation_plan") ||
        cleanPath.includes("walkthrough") ||
        cleanPath.includes("artifacts")
      );
      return (
        <button
          type="button"
          onClick={() => {
            const store = useAppStore.getState();
            if (isMd) {
              store.setActiveArtifactPath(cleanPath);
              store.addArtifact(cleanPath);
              store.setRightPanelTab("artifacts");
              store.setRightPanelOpen(true);
            } else {
              store.openFileTab(cleanPath);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand/10 px-2 py-0.5 font-mono text-xs text-brand hover:bg-brand/20 hover:border-brand/60 transition-all my-0.5 cursor-pointer font-medium shadow-2xs"
          title={`Open ${cleanPath} in HermOS`}
        >
          {isMd ? <Sparkles className="size-3 shrink-0 text-brand" /> : null}
          <span>{children}</span>
        </button>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (href) {
            e.preventDefault();
            void openExternalUrl(href);
          }
        }}
        className="text-brand underline-offset-2 hover:underline font-medium cursor-pointer"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border bg-card/40 shadow-xs">
        <table className="w-full text-xs text-left border-collapse">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-muted/70 font-semibold text-foreground border-b">{children}</thead>;
  },
  tr({ children }) {
    return <tr className="hover:bg-muted/30 transition-colors border-b last:border-b-0">{children}</tr>;
  },
  th({ children }) {
    return (
      <th className="border-r last:border-r-0 px-3 py-2 text-left font-semibold text-foreground bg-muted/30">{children}</th>
    );
  },
  td({ children }) {
    return <td className="border-r last:border-r-0 px-3 py-1.5 text-foreground/90 leading-relaxed">{children}</td>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-brand/40 pl-3 text-muted-foreground italic">
        {children}
      </blockquote>
    );
  },
  // Explicit renderers so emphasis doesn't fall back to the default browser
  // 700-weight bold, which renders too heavy and noisy in the system font.
  // Colors are left to inherit from the container so the reasoning view can
  // keep its muted styling and the answer body its slightly softened tone.
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  del({ children }) {
    return <del className="line-through opacity-80">{children}</del>;
  },
  ul({ children }) {
    return <ul className="my-1.5 list-disc pl-5 space-y-1 text-sm marker:text-muted-foreground">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1.5 list-decimal pl-5 space-y-1 text-sm marker:text-muted-foreground">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-[1.7]">{children}</li>;
  },
  h1({ children }) {
    return <h1 className="mt-5 mb-2 text-[15px] font-semibold tracking-tight">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mt-4 mb-1.5 text-sm font-semibold tracking-tight">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mt-3 mb-1 text-[13px] font-semibold tracking-tight">{children}</h3>;
  },
  p({ children }) {
    // If paragraph children contain line breaks or code-like preformatted chunks,
    // whitespace-pre-wrap ensures newlines are respected instead of collapsing.
    return <p className="my-1.5 text-sm leading-[1.7] whitespace-pre-wrap">{children}</p>;
  },
  hr() {
    return <hr className="my-4 border-border" />;
  },
};

/**
 * Fenced code + inline code renderer. `streaming` disables the Prism
 * highlighter for still-growing fenced blocks (see CodeBlock).
 */
function codeMarkdownRenderer(streaming: boolean) {
  return (props: any) => {
    const { className, children, ...rest } = props;
    const inline = !className;
    const text = String(children ?? "").replace(/\n$/, "");
    if (inline) {
      return (
        <code
          className="rounded px-1.5 py-0.5 font-mono text-[12px] font-medium border border-border/60 bg-muted/80 text-foreground/90"
          {...rest}
        >
          {children}
        </code>
      );
    }
    const match = /language-(\w+)/.exec(className || "");
    return <CodeBlock language={match?.[1]} value={text} streaming={streaming} />;
  };
}

function useMarkdownComponents(streaming: boolean): Components {
  return React.useMemo(
    () => ({ ...markdownComponents, code: codeMarkdownRenderer(streaming) }),
    [streaming],
  );
}

export function isTreeLineContent(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Match any Unicode tree branch characters (├, └, │, ┬)
  if (/[├└│┬]/.test(trimmed)) return true;
  // Match ASCII / Markdown tree patterns: ├──, └──, +--, |--, \--, |   |--
  if (/^[|\s│]*[├└+│\\][─\-]{1,2}/.test(trimmed)) return true;
  if (/\b(├──|└──)\b/.test(trimmed)) return true;
  return false;
}

/**
 * Split a single line that contains an entire tree structure (multiple
 * ├── / └── markers) into individual lines with reconstructed indentation.
 *
 * Example input:
 *   `hermos/ ├── apps/ │ ├── web-ide/ # desc ├── landing/ └── cli/`
 *
 * Returns multiple lines like:
 *   hermos/
 *   ├── apps/
 *   │   ├── web-ide/ # desc
 *   ├── landing/
 *   └── cli/
 *
 * If the line contains fewer than 2 tree branch markers it is returned as-is.
 */
export function splitInlineTree(line: string): string[] {
  if (!line) return [line];

  const branchPattern = /[├└]/g;
  const matches = line.match(branchPattern);
  if (!matches || matches.length < 2) return [line];

  // Split at positions just before tree branch characters (├ or └),
  // but also capture the leading │ indent characters that belong to each branch.
  // Pattern: split before sequences like "├──", "└──", or "│   ├──", "│   └──"
  const parts: string[] = [];
  // Match: optional leading (│\s*)* then ├── or └──
  const splitRegex = /(?=(?:[\s│|]*[├└]))/g;
  const segments = line.split(splitRegex).filter(s => s.trim());

  if (segments.length < 2) return [line];

  for (const seg of segments) {
    parts.push(seg.trimEnd());
  }

  return parts;
}

export function preprocessContent(content: string): string {
  if (!content) return "";
  const needsLinks = content.includes("](") && content.includes("\\");
  const needsTables = content.includes("|");
  const needsTrees =
    content.includes("├") ||
    content.includes("└") ||
    content.includes("├──") ||
    content.includes("└──") ||
    content.includes("│") ||
    /^[|\s│]*[├└+│\\][─\-]{1,2}/m.test(content);

  if (!needsLinks && !needsTables && !needsTrees) {
    return content;
  }
  const endsWithNewline = content.endsWith("\n");

  // Normalize Windows backslashes in Markdown link targets
  if (needsLinks) {
    content = content.replace(/(\]\()([^()<>\s]*\\[^()<>\s]*)(\))/g, (_m, p1: string, p2: string, p3: string) => {
      return p1 + p2.replace(/\\/g, "/") + p3;
    });
  }

  // Strip inline code pipes before table detection to avoid false positives.
  const codeSpans: string[] = [];
  const withoutInlineCodes = needsTables
    ? content.replace(/`[^`]*`/g, (m) => {
        codeSpans.push(m);
        return `\x00CODE_SPAN_${codeSpans.length - 1}\x00`;
      })
    : content;

  let raw = withoutInlineCodes;
  if (needsTables) {
    const rawLines = raw.split("\n");
    const tableFixed: string[] = [];
    let inTable = false;
    let inCode = false;
    let tableBuf: { line: string; isSep: boolean }[] = [];

    const flushTable = () => {
      if (tableBuf.length === 0) return;
      const colCount = Math.max(
        ...tableBuf
          .filter((r) => !r.isSep)
          .map((r) => r.line.trim().split("|").filter((s) => s.trim() !== "").length),
        2,
      );
      const hasSep = tableBuf.some((r) => r.isSep);
      const out: string[] = [];
      for (let i = 0; i < tableBuf.length; i++) {
        const entry = tableBuf[i];
        const trimmed = entry.line.trim();
        if (entry.isSep) {
          const parts = trimmed.split("|");
          const cells: string[] = [];
          for (let c = 1; c < parts.length - 1 && cells.length < colCount; c++) {
            cells.push(parts[c].trim() || "---");
          }
          while (cells.length < colCount) cells.push("---");
          out.push("| " + cells.join(" | ") + " |");
        } else {
          const parts = trimmed.split("|");
          const off = trimmed.startsWith("|") ? 1 : 0;
          const end = trimmed.endsWith("|") ? 1 : 0;
          const cells = parts.slice(off, parts.length - end || undefined).map((c) => c.trim());
          while (cells.length < colCount) cells.push("");
          out.push("| " + cells.slice(0, colCount).join(" | ") + " |");
        }
        if (i === 0 && !hasSep && tableBuf.length >= 2) {
          out.push("| " + Array(colCount).fill("---").join(" | ") + " |");
        }
      }
      for (const line of out) tableFixed.push(line);
      tableBuf = [];
    };

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith("```")) {
        if (inTable) {
          flushTable();
          tableFixed.push("");
          inTable = false;
        }
        inCode = !inCode;
        tableFixed.push(line);
        continue;
      }

      if (inCode) {
        tableFixed.push(line);
        continue;
      }

      if (isTreeLineContent(line)) {
        if (inTable) {
          flushTable();
          if (trimmed !== "") tableFixed.push("");
          inTable = false;
        }
        tableFixed.push(line);
        continue;
      }

      const pipeCount = (trimmed.match(/\|/g)?.length ?? 0);
      const cells = trimmed.split("|").slice(1, -1);
      const isSepRow = pipeCount >= 2 && cells.length >= 1 && cells.every((c) => /^[\s:-]*$/.test(c));
      const isRow = pipeCount >= 2 && trimmed.startsWith("|");
      const isTableRow = isSepRow || isRow;

      if (isTableRow) {
        if (!inTable) {
          if (tableFixed.length > 0 && tableFixed[tableFixed.length - 1].trim() !== "") {
            tableFixed.push("");
          }
          inTable = true;
        }
        tableBuf.push({ line, isSep: isSepRow });
      } else {
        if (inTable) {
          flushTable();
          if (trimmed !== "") {
            tableFixed.push("");
          }
          inTable = false;
        }
        tableFixed.push(line);
      }
    }
    if (inTable) flushTable();
    raw = tableFixed.join("\n");
    raw = raw.replace(/\x00CODE_SPAN_(\d+)\x00/g, (_m, idx) => {
      return codeSpans[parseInt(idx, 10)] ?? "";
    });
  }

  if (!needsTrees) {
    raw = raw.replace(/\n+$/, "");
    if (endsWithNewline) raw += "\n";
    return raw;
  }

  const lines = raw.split("\n");
  let processed = "";
  let inTreeBlock = false;
  let treeLines: string[] = [];
  let inMarkdownCodeBlock = false;

  const isTreeLine = (line: string): boolean => {
    return isTreeLineContent(line);
  };

  const isPossibleTreeHeader = (line: string, nextLine?: string): boolean => {
    if (!nextLine) return false;
    const trimmed = line.trim();
    if (trimmed === ".") return isTreeLine(nextLine);
    if (trimmed.endsWith("/") || trimmed.endsWith("\\")) return isTreeLine(nextLine);
    if (
      trimmed.length <= 50 &&
      /^[\w.@\-]+$/.test(trimmed) &&
      !trimmed.startsWith("```") &&
      !trimmed.startsWith("|")
    ) {
      return isTreeLine(nextLine);
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.trim().startsWith("```")) {
      inMarkdownCodeBlock = !inMarkdownCodeBlock;
      if (inTreeBlock) {
        processed += "```tree\n" + treeLines.join("\n") + "\n```\n\n";
        inTreeBlock = false;
        treeLines = [];
      }
      processed += line + "\n";
      continue;
    }

    if (inMarkdownCodeBlock) {
      processed += line + "\n";
      continue;
    }

    const nextLine = i < lines.length - 1 ? lines[i + 1] : undefined;
    const isTree = isTreeLine(line) || (treeLines.length === 0 && isPossibleTreeHeader(line, nextLine));

    if (isTree) {
      const expandedLines = splitInlineTree(line);
      const hasTreeNeighbors =
        treeLines.length > 0 || (nextLine && isTreeLine(nextLine));
      if (hasTreeNeighbors || expandedLines.length > 1) {
        if (!inTreeBlock) {
          inTreeBlock = true;
          treeLines = [];
        }
        for (const el of expandedLines) {
          treeLines.push(el);
        }
        continue;
      }
      const clean = line.replace(/`{3,}/g, "");
      processed += "```tree\n" + clean + "\n```\n\n";
      continue;
    }

    if (inTreeBlock) {
      const cleanTree = treeLines.map((l) => l.replace(/`{3,}/g, "")).join("\n");
      processed += "```tree\n" + cleanTree + "\n```\n\n";
      inTreeBlock = false;
      treeLines = [];
    }
    processed += line + "\n";
  }

  if (inTreeBlock) {
    const cleanTree = treeLines.map((l) => l.replace(/`{3,}/g, "")).join("\n");
    processed += "```tree\n" + cleanTree + "\n```\n";
  }

  processed = processed.replace(/\n+$/, "");
  if (endsWithNewline) processed += "\n";
  return processed;
}

function AttachmentBlock({ att }: { att: AttachmentDTO }) {
  const [expanded, setExpanded] = React.useState(false);
  const isImage = att.type.startsWith("image/");
  const src = `/api/attachments/${att.id}`;
  const ext = att.name.split(".").pop()?.toLowerCase() ?? "";
  if (isImage) {
    return (
      <div className="my-2 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group relative block max-w-xs rounded-lg overflow-hidden border border-border/60 hover:border-brand/40 transition-colors cursor-pointer"
        >
          <img
            src={src}
            alt={att.name}
            className="max-h-48 w-full object-cover group-hover:scale-[1.02] transition-transform"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />
        </button>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-muted-foreground truncate">{att.name}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{formatBytes(att.size)}</span>
          <a
            href={src}
            download={att.name}
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Download"
          >
            <Download className="size-3" />
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="my-1.5">
      <a
        href={src}
        download={att.name}
        className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-card/40 hover:bg-muted/30 hover:border-border transition-colors px-2.5 py-1.5 text-xs max-w-xs group"
      >
        <FileTypeIcon ext={ext} className="size-4 shrink-0" />
        <span className="truncate min-w-0 flex-1">{att.name}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{formatBytes(att.size)}</span>
        <Download className="size-3 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
      </a>
    </div>
  );
}

/**
 * Markdown renderer for reasoning/thinking blocks. Reuses the same component
 * map as message text, so code fences get full syntax highlighting via
 * CodeBlock (Prism, line numbers, copy), inline code gets chips, and links,
 * lists, tables and blockquotes render identically to the answer body.
 */
const ThinkingMarkdown = React.memo(
  function ThinkingMarkdown({ content, streaming }: { content: string; streaming?: boolean }) {
    const isStreaming = !!streaming;
    const trimmed = content?.trim();
    const components = useMarkdownComponents(isStreaming);
    if (!trimmed) return null;
    return (
      <div className="text-[13px] text-muted-foreground/80 [&_p]:text-[13px] [&_ul]:text-[13px] [&_ol]:text-[13px]">
        {isStreaming ? (
          <StreamingThinkingMarkdown trimmed={trimmed} components={components} />
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {preprocessContent(trimmed)}
          </ReactMarkdown>
        )}
      </div>
    );
  },
  (a, b) => a.content === b.content && !!a.streaming === !!b.streaming,
);

function StreamingThinkingMarkdown({ trimmed, components }: { trimmed: string; components: Components }) {
  const deferred = React.useDeferredValue(trimmed);
  const preprocessed = React.useMemo(
    () => (deferred ? preprocessContent(deferred) : ""),
    [deferred],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {preprocessed}
    </ReactMarkdown>
  );
}

/**
 * Collapsible "Thinking…"/"Reasoning" block. While the reasoning text is
 * being streamed live (`isLive`), the block stays open and the inner
 * scroll area pins to the bottom so the newest sentence stays visible as
 * it grows — the same stick-to-bottom behaviour the main chat list uses.
 * Once reasoning completes the block auto-collapses (Antigravity style)
 * unless the user manually pinned it open.
 */
function ThinkingBlock({
  open,
  onOpenChange,
  isLive,
  content,
  emptyLabel = "Thinking…",
}: {
  open: boolean | undefined;
  onOpenChange: (v: boolean) => void;
  isLive: boolean;
  content: string;
  emptyLabel?: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: auto-pin the newest reasoning while tokens land, but
  // NEVER yank the view — once the user scrolls up the inner box is theirs;
  // pinning resumes only when they scroll back to the bottom.
  const stickRef = React.useRef(true);
  // Any content that fits in the box is by definition "at the bottom" —
  // treat the final few pixels as still-at-bottom so a nearly-there scroll
  // doesn't flip stick off for the next frame.
  const STICK_THRESHOLD_PX = 16;

  // Track whether the user is anchored to the bottom of the thinking box.
  React.useEffect(() => {
    if (!isLive) return;
    stickRef.current = true; // a fresh stream starts pinned
  }, [isLive]);

  const onInnerScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    stickRef.current = atBottom;
  }, []);

  // Follow the stream: keep the newest reasoning pinned into view while
  // tokens are still landing. rAF-throttled so a burst of appends settles
  // in a single frame instead of one scroll-churn per token. Guards avoid
  // pointless layout writes on every append: content fits → no-op; user
  // scrolled up → hands off, no yank.
  const rafRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!isLive) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      // Nothing to pin if the content doesn't overflow the box.
      if (el.scrollHeight <= el.clientHeight) return;
      // User scrolled up inside the box — their view wins; don't pull it.
      if (!stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [content, isLive]);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors overflow-hidden">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90")} />
        <Brain className={cn("size-3.5 shrink-0", isLive ? "text-brand animate-pulse" : "text-brand")} />
        <span className="truncate">{isLive ? "Thinking…" : "Reasoning"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        <div
          ref={scrollRef}
          onScroll={onInnerScroll}
          className="max-h-80 overflow-y-auto overscroll-contain rounded-md border border-dashed border-brand/20 bg-muted/40 px-3 py-2"
        >
          {content ? (
            <ThinkingMarkdown content={content} streaming={isLive} />
          ) : (
            <span className="text-sm text-muted-foreground">{emptyLabel}</span>
          )}
          {isLive && <StreamingCursor />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const MarkdownContent = React.memo(
  function MarkdownContent({ content, streaming }: { content: string; streaming?: boolean }) {
    const isStreaming = !!streaming;
    const trimmed = content?.trim();
    const components = useMarkdownComponents(isStreaming);
    if (!trimmed) return null;
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="prose-sm max-w-none text-sm text-foreground/90"
      >
        {isStreaming ? (
          <StreamingMarkdown trimmed={trimmed} components={components} />
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {preprocessContent(trimmed)}
          </ReactMarkdown>
        )}
      </motion.div>
    );
  },
  (a, b) => a.content === b.content && !!a.streaming === !!b.streaming,
);

/**
 * While SSE tokens keep arriving, defer the markdown source so the heavy
 * preprocess + parse pass runs at transition priority and never blocks the
 * main thread (~1 frame lag behind the raw text). Deferred rendering is only
 * used on the streaming path; static content parses synchronously.
 */
function StreamingMarkdown({ trimmed, components }: { trimmed: string; components: Components }) {
  const deferred = React.useDeferredValue(trimmed);
  const preprocessed = React.useMemo(
    () => (deferred ? preprocessContent(deferred) : ""),
    [deferred],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {preprocessed}
    </ReactMarkdown>
  );
}

export { MarkdownContent };

/**
 * Compact inline file-operation block — shows just the file icon + filename
 * with an expand/collapse toggle. The full result (diff, content, etc.)
 * appears when expanded.
 */
export const FileOpBlock = React.memo(function FileOpBlock({ tc }: { tc: LiveToolCall }) {
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const setActiveArtifactPath = useAppStore((s) => s.setActiveArtifactPath);
  const addArtifact = useAppStore((s) => s.addArtifact);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const args = React.useMemo(() => tc.parsedArgs ?? safeParse(tc.args), [tc.parsedArgs, tc.args]);
  const filePath = React.useMemo(() => args ? extractFilePath(args) : null, [args]);
  const isSearch = tc.name === "grep" || tc.name === "grep_search" || tc.name === "glob";
  const isDir = tc.name === "list_directory" || tc.name === "list_dir";
  const query = isSearch ? extractSearchQuery(args) : "";
  const displayPath = React.useMemo(() => {
    if (!filePath) return null;
    if (isDir && (filePath === "." || filePath === "./")) {
      return activeWorkspace?.name || "workspace";
    }
    return filePath;
  }, [filePath, isDir, activeWorkspace?.name]);
  const ext = React.useMemo(() => {
    const p = filePath ?? "";
    const parts = p.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  }, [filePath]);
  // read_file has no expand toggle — content is shown in the right panel.
  // It stays collapsed inline and shows the L badge in the collapsed row.
  const isNoToggle = tc.name === "read_file";
  const isArtifactOp = tc.name === "create_artifact";
  const isDelete = tc.name === "remove_file" || tc.name === "delete";
  const [open, setOpen] = React.useState(false);
  const status = tc.status;
  const isCreatedFile = Boolean(tc.name === "write_file" && tc.result && typeof tc.result === "object" && "created" in tc.result && tc.result !== null && (tc.result as { created: boolean }).created === true);

  // Extract L start / L end from read_file/view_file range results, or fallback to full file.
  const lineRange = React.useMemo(() => {
    if ((tc.name !== "read_file" && tc.name !== "view_file") || !tc.result || typeof tc.result !== "object") return null;
    const r = tc.result as { startLine?: number; endLine?: number; lines?: number; totalLines?: number };
    if (typeof r.startLine === "number" && typeof r.endLine === "number") {
      return { start: r.startLine, end: r.endLine };
    }
    // Full file read fallback: show L 1 - L totalLines
    const total = r.totalLines ?? r.lines;
    if (typeof total === "number" && total > 0) {
      return { start: 1, end: total };
    }
    return null;
  }, [tc.name, tc.result]);

  // Compute diff stats from old/new content directly (consistent with DiffViewer).
  // Falls back to tool arguments (works for both running & done states, and handles streaming args).
  // Memoized: countDiffLines is O(n*m) — don't re-run it on every streaming frame.
  const diffStats = React.useMemo(
    () => computeDiffStats(tc.name, tc.result, args),
    [tc.name, tc.result, args],
  );
  return (
    <div className="group/file-op my-1">
      <button
        type="button"
        onClick={isNoToggle ? undefined : isArtifactOp ? () => {
          const res = typeof tc.result === "object" && tc.result ? (tc.result as Record<string, unknown>) : null;
          const rawPath = String(res?.path ?? filePath ?? "");
          setActiveArtifactPath(rawPath);
          addArtifact(rawPath);
          setRightPanelTab("artifacts");
          setRightPanelOpen(true);
        } : () => setOpen((v) => !v)}
        aria-expanded={isNoToggle || isArtifactOp ? undefined : open}
        aria-label={isNoToggle || isArtifactOp ? undefined : open ? "Collapse" : "Expand"}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 text-left text-xs rounded-sm px-1 transition-colors",
          !isNoToggle && "hover:bg-accent/20 cursor-pointer",
          isNoToggle && "cursor-default",
        )}
      >
        {isNoToggle ? null : status === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-emerald-500 dark:text-emerald-400 shrink-0" />
        ) : status === "done" ? (
          <CheckCircle2 className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
        ) : (
          <ChevronRight
            className={cn(
              "size-3 text-foreground/70 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        {isSearch ? (
          <>
            <Search className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
            <code className="font-mono text-[11px] truncate min-w-0 flex-1 text-foreground">
              {query || tc.name}
            </code>
          </>
        ) : isDir ? (
          <>
            <Folder className="size-3.5 text-amber-500/90 dark:text-amber-400/90 shrink-0" />
            <code className="font-mono text-[11px] truncate min-w-0 flex-1 text-foreground font-medium">
              {displayPath || "directory"}
            </code>
          </>
        ) : filePath ? (
          <>
            <FileTypeIcon ext={ext} className="size-4 shrink-0" />
            <code className={cn("font-mono text-[11px] truncate min-w-0 flex-1", isDelete ? "text-red-500/90 dark:text-red-400/90 line-through" : "text-foreground")}>
              {filePath}
            </code>
            {isCreatedFile && (
              <Badge variant="outline" className="h-3.5 px-1 text-[8px] font-mono border-0 bg-emerald-500/15 text-emerald-400 shrink-0">
                <FilePlus2 className="size-2 mr-0.5" />
                NEW
              </Badge>
            )}
            {isDelete && (
              <Badge variant="outline" className="h-3.5 px-1 text-[8px] font-mono border-0 bg-red-500/15 text-red-500 dark:text-red-400 shrink-0">
                DELETED
              </Badge>
            )}
          </>
        ) : (
          <span className="font-mono text-[11px] text-foreground/80">{tc.name}</span>
        )}
        {/* L start - L end badge for read_file / view_file range views */}
        {lineRange && (
          <span className="shrink-0 font-mono text-[10px] text-foreground/80">
            L{lineRange.start}-L{lineRange.end}
          </span>
        )}
        {/* Diff stats — shown even when collapsed */}
        {diffStats && (
          <span className="flex items-center gap-0.5 shrink-0 font-mono text-[10px]">
            <span className="text-emerald-500 dark:text-emerald-400">+{diffStats.add}</span>
            <span className="text-red-500 dark:text-red-400">-{diffStats.del}</span>
          </span>
        )}
        {!isNoToggle && !isArtifactOp && (
          <ChevronRight
            className={cn(
              "size-3 text-foreground/70 shrink-0 transition-transform ml-auto",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {!isNoToggle && open && (
          <motion.div
            initial={false}
            animate={false}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden pl-5"
          >
            <div className="pt-1">
              <ToolResultBody tc={tc} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

interface SubagentBlockProps {
  tc: LiveToolCall;
}

export function SubagentBlock({ tc }: SubagentBlockProps) {
  const subagents = useAppStore((s) => s.subagents);
  const setActiveSubagentId = useAppStore((s) => s.setActiveSubagentId);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  const parsedArgs = React.useMemo(() => tc.parsedArgs ?? safeParse(tc.args), [tc.parsedArgs, tc.args]);
  const parsedResult: Record<string, unknown> =
    tc.result == null
      ? {}
      : typeof tc.result === "string"
        ? (safeParse(tc.result) ?? {})
        : (tc.result as Record<string, unknown>);
  const subagentId = (parsedResult?.id as string | undefined) || (parsedResult?.subagentId as string | undefined) || (parsedArgs as any)?.id || (parsedArgs as any)?.subagentId;

  const subagent = React.useMemo(() => {
    if (subagentId) {
      return subagents.find((sa) => sa.id === subagentId) ?? null;
    }
    const name = parsedArgs?.name;
    if (name) {
      return subagents.find((sa) => sa.name === name) ?? null;
    }
    return null;
  }, [subagents, subagentId, parsedArgs]);

  const name = String(subagent?.name || (parsedArgs as any)?.name || "Subagent");
  const status = subagent?.status || "pending";

  // Subagent polling is handled by SubagentsPanel (single source of truth).
  // Do NOT poll here — each SubagentBlock would create its own interval,
  // causing N duplicate requests for N spawned subagents.

  const handleClick = () => {
    if (!subagentId) return;
    setActiveSubagentId(subagentId);
    setRightPanelTab("subagents");
  };

  const isExploreOrArchitect = React.useMemo(() => {
    const text = `${name} ${subagent?.task || ""} ${subagent?.systemPrompt || ""}`.toLowerCase();
    return text.includes("explore") || text.includes("architect") || text.includes("research") || text.includes("review") || text.includes("inspect") || text.includes("read-only") || text.includes("plan");
  }, [name, subagent?.task, subagent?.systemPrompt]);

  return (
    <div
      onClick={handleClick}
      className={cn(
        "group relative overflow-hidden flex w-full items-center justify-between rounded-lg border border-border/60 bg-card/80 dark:bg-zinc-950/40 px-3 py-2 text-xs cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-accent/20 dark:hover:bg-zinc-900/50 transition-all duration-200 my-2 shadow-2xs hover:shadow-xs",
        status === "failed" && "border-rose-500/30 hover:border-rose-500/50",
        status === "completed" && "border-emerald-500/20 hover:border-emerald-500/40"
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isExploreOrArchitect ? (
          <Compass className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" aria-label="Explore / Architect agent" />
        ) : (
          <Bot className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" aria-label="General agent" />
        )}
        <span className="font-semibold text-xs text-foreground truncate tracking-tight min-w-0" title={name}>
          {name}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0 ml-3">
        {status === "running" ? (
          <Loader2 className="size-3.5 text-emerald-500 dark:text-emerald-400 animate-spin shrink-0" />
        ) : status === "completed" ? (
          <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-medium">completed</span>
        ) : status === "failed" ? (
          <span className="text-[10px] font-mono text-rose-600 dark:text-rose-400 font-medium">failed</span>
        ) : null}

        <ChevronRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
      </div>
    </div>
  );
}

export function SubagentMessageBlock({ tc }: SubagentBlockProps) {
  const subagents = useAppStore((s) => s.subagents);

  const parsedArgs = React.useMemo(() => tc.parsedArgs ?? safeParse(tc.args), [tc.parsedArgs, tc.args]);
  const parsedResult: Record<string, unknown> =
    tc.result == null
      ? {}
      : typeof tc.result === "string"
        ? (safeParse(tc.result) ?? {})
        : (tc.result as Record<string, unknown>);
  const subagentId = String((parsedArgs as any)?.id ?? "");
  const name = React.useMemo(() => {
    const resultName = String(parsedResult?.name ?? "");
    if (resultName) return resultName;
    if (!subagentId) return "subagent";
    return subagents.find((sa) => sa.id === subagentId)?.name ?? subagentId;
  }, [subagents, subagentId, parsedResult?.name]);
  const resumed = parsedResult?.status === "resumed";
  const failed =
    tc.ok === false || typeof (parsedResult as { error?: unknown })?.error === "string";

  return (
    <div
      aria-hidden
      className={cn(
        "my-4 flex items-center gap-3 text-[11px] font-mono select-none",
        failed ? "text-red-500/70 dark:text-red-400/70" : "text-muted-foreground/60",
      )}
    >
      <div className="h-px flex-1 bg-border/40" />
      <span className="min-w-0 truncate">
        {failed ? `messaged ${name || "subagent"} — failed` : `messaged ${name}`}
        {resumed ? " · resumed" : ""}
      </span>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  );
}

const READ_TOOLS = new Set([
  "read_file",
  "view_file",
  "list_directory",
  "list_dir",
]);

const SEARCH_TOOLS = new Set([
  "grep",
  "grep_search",
  "glob",
]);

/** Extract the search query from a grep/glob tool's args. */
function extractSearchQuery(args: Record<string, unknown> | null | undefined): string {
  if (!args) return "";
  const q = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : "";
  return q;
}

interface ToolBatchBlockProps {
  toolCalls: LiveToolCall[];
  hasNextItem?: boolean;
  isStreaming?: boolean;
  /** "read" merges file reads / directory listings; "search" merges grep / glob queries. */
  kind?: "read" | "search";
}

export const ToolBatchBlock = React.memo(function ToolBatchBlock({
  toolCalls,
  hasNextItem = false,
  isStreaming = false,
  kind = "read",
}: ToolBatchBlockProps) {
  const isRunning = toolCalls.some((tc) => tc.status === "running");
  const userToggledRef = React.useRef(false);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);

  // Stays open while running OR while it is the active iteration in current streaming phase (isStreaming & no next item).
  // Automatically collapses when the next thinking iteration / phase starts (hasNextItem is true) or streaming ends!
  const shouldBeOpen = isRunning || (isStreaming && !hasNextItem);
  const [open, setOpen] = React.useState(shouldBeOpen);

  React.useEffect(() => {
    if (!userToggledRef.current) {
      setOpen(shouldBeOpen);
    }
  }, [shouldBeOpen]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setOpen((v) => !v);
  };

  const totalCount = toolCalls.length;
  let label = "";
  let subLabel = "";

  const fileCount = toolCalls.filter((tc) => tc.name === "read_file" || tc.name === "view_file").length;
  const dirCount = toolCalls.filter((tc) => tc.name === "list_directory" || tc.name === "list_dir").length;

  if (kind === "search") {
    label = `Searched ${totalCount} quer${totalCount === 1 ? "y" : "ies"}`;
  } else {
    if (totalCount === 1) {
      const tc = toolCalls[0];
      if (tc.name === "list_directory" || tc.name === "list_dir") {
        const args = tc.parsedArgs ?? safeParse(tc.args);
        const rawPath = typeof args?.path === "string" ? args.path : typeof args?.DirectoryPath === "string" ? args.DirectoryPath : "";
        const target = (!rawPath || rawPath === "." || rawPath === "./") ? (activeWorkspace?.name || "default") : rawPath;
        label = "Analyzed";
        subLabel = target;
      } else if (tc.name === "read_file" || tc.name === "view_file") {
        const args = tc.parsedArgs ?? safeParse(tc.args);
        const path = typeof args?.path === "string" ? args.path : typeof args?.AbsolutePath === "string" ? args.AbsolutePath : "file";
        label = "Read";
        subLabel = path;
      } else {
        label = "Analyzed";
        subLabel = tc.name;
      }
    } else if (fileCount > 0 && dirCount > 0) {
      label = `Read ${fileCount} file${fileCount === 1 ? "" : "s"} & analyzed ${dirCount} dir${dirCount === 1 ? "" : "s"}`;
    } else if (dirCount > 0) {
      label = `Analyzed ${dirCount} director${dirCount === 1 ? "y" : "ies"}`;
    } else {
      label = `Read ${fileCount || totalCount} file${(fileCount || totalCount) === 1 ? "" : "s"}`;
    }
  }

  const isDirOnly = kind !== "search" && dirCount > 0 && fileCount === 0;
  const BatchIcon = kind === "search" ? Search : isDirOnly ? Folder : BookOpen;

  return (
    <div className="my-1 rounded border border-border/40 bg-zinc-500/5 transition-colors overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {isRunning ? (
          <Loader2 className="size-3.5 animate-spin text-emerald-500 dark:text-emerald-400 shrink-0" />
        ) : (
          <CheckCircle2 className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
        )}
        <BatchIcon className={cn("size-3.5 shrink-0", isDirOnly ? "text-amber-500/90 dark:text-amber-400/90" : "text-emerald-500 dark:text-emerald-400")} />
        <span className="font-mono text-[11px] font-medium text-foreground shrink-0">{label}</span>
        {subLabel && (
          <span className="font-mono text-[11px] text-foreground/80 truncate min-w-0 flex-1">
            <span className="text-foreground/40 mx-1">·</span>
            {subLabel}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="font-mono text-[10px] text-foreground font-medium">{totalCount} item{totalCount === 1 ? "" : "s"}</span>
          <ChevronRight
            className={cn("size-3 text-foreground/80 transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden border-t border-border/20 px-2 py-1 space-y-0.5"
          >
            {toolCalls.map((tc) => (
              <FileOpBlock key={tc.id} tc={tc} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

type FlatGroupItem =
  | { type: "single"; tc: LiveToolCall }
  | { type: "read_group"; toolCalls: LiveToolCall[] }
  | { type: "search_group"; toolCalls: LiveToolCall[] };

function toolGroupKind(tcName: string): "read" | "search" | null {
  if (READ_TOOLS.has(tcName)) return "read";
  if (SEARCH_TOOLS.has(tcName)) return "search";
  return null;
}

export function groupFlatToolCalls(toolCalls: LiveToolCall[]): FlatGroupItem[] {
  const result: FlatGroupItem[] = [];
  let currentGroup: LiveToolCall[] = [];
  let currentKind: "read" | "search" | null = null;

  const flush = () => {
    if (currentGroup.length > 1 && currentKind) {
      result.push({
        type: currentKind === "search" ? "search_group" : "read_group",
        toolCalls: [...currentGroup],
      });
    } else if (currentGroup.length === 1) {
      result.push({ type: "single", tc: currentGroup[0] });
    }
    currentGroup = [];
    currentKind = null;
  };

  for (const tc of toolCalls) {
    if (HIDDEN_TOOLS.has(tc.name)) continue;
    const kind = toolGroupKind(tc.name);
    if (!kind) {
      flush();
      result.push({ type: "single", tc });
      continue;
    }
    if (currentKind !== kind) flush();
    currentGroup.push(tc);
    currentKind = kind;
  }
  flush();
  return result;
}

type SegmentGroupItem =
  | { type: "seg"; seg: any }
  | { type: "read_group"; toolCalls: LiveToolCall[]; key: string }
  | { type: "search_group"; toolCalls: LiveToolCall[]; key: string };

export function groupSegmentItems(
  segments: any[],
  toolCallById: Map<string, LiveToolCall>,
): SegmentGroupItem[] {
  const result: SegmentGroupItem[] = [];
  let currentGroup: { tc: LiveToolCall; seg: any }[] = [];
  let currentKind: "read" | "search" | null = null;

  const flush = () => {
    if (currentGroup.length > 1 && currentKind) {
      result.push({
        type: currentKind === "search" ? "search_group" : "read_group",
        toolCalls: currentGroup.map((item) => item.tc),
        key: `${currentKind === "search" ? "search" : "read"}-group-${currentGroup[0].seg.id}`,
      });
    } else if (currentGroup.length === 1) {
      result.push({ type: "seg", seg: currentGroup[0].seg });
    }
    currentGroup = [];
    currentKind = null;
  };

  for (const seg of segments) {
    if (seg.kind === "text" || seg.kind === "thinking") {
      flush();
      result.push({ type: "seg", seg });
    } else if (seg.kind === "tool_call") {
      const tc = toolCallById.get(seg.toolCallId ?? "");
      if (!tc || HIDDEN_TOOLS.has(tc.name)) continue;

      const kind = toolGroupKind(tc.name);
      if (!kind) {
        flush();
        result.push({ type: "seg", seg });
        continue;
      }
      if (currentKind !== kind) flush();
      currentGroup.push({ tc, seg });
      currentKind = kind;
    }
  }
  flush();
  return result;
}



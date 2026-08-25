"use client";

import * as React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "@/components/theme/theme-provider";
import {
  Check,
  Copy,
  ChevronDown,
  ChevronUp,
  FileCode2,
  Braces,
  FileText,
  Terminal,
  Palette,
  Database,
  FolderTree,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { langIconKind, type LangIconKind } from "@/lib/tool-ui-shared";
import { Button } from "@/components/ui/button";

interface CodeBlockProps {
  language: string | undefined;
  value: string;
  className?: string;
  /** First line number to display (for read_file range views). */
  startLine?: number;
  /** Last line number to display (for read_file range views). */
  endLine?: number;
  /**
   * While the block is still growing (SSE streaming), render plain
   * monospace text instead of running the Prism highlighter — avoids
   * re-highlighting the whole buffer on every streamed token. The full
   * highlighted view (colors, line numbers) kicks in once streaming stops.
   */
  streaming?: boolean;
}

/**
 * CodeBlock — fenced code rendering with a header showing the language
 * badge + line count and a refined Copy button that shows a green check
 * for 2 seconds after a successful copy.
 *
 * - Line numbers gutter (muted-foreground, tabular-nums, select-none)
 *   for blocks ≥ 3 lines. Single-line inline code is rendered by the
 *   parent (the markdown renderer's inline branch).
 * - Collapse / expand for blocks ≥ 20 lines. Collapsed shows the first
 *   8 lines + an "Expand N more lines" button; expanded shows the full
 *   content with a "Collapse" button at the bottom.
 * - Language icon next to the language badge (FileCode2 for ts/tsx/js,
 *   Braces for json, FileText for md/txt, Terminal for bash/sh,
 *   Palette for css, Database for sql). Subtle (size-3.5, muted).
 * - Copy button preserves the green-check-for-2s behaviour.
 */
const COLLAPSE_THRESHOLD = 20;
const COLLAPSED_PREVIEW_LINES = 8;

export const CodeBlock = React.memo(function CodeBlock({
  language,
  value,
  className,
  startLine,
  endLine,
  streaming,
}: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [copied, setCopied] = React.useState(false);
  const isDark = resolvedTheme === "dark";
  const lang = (language || "text").toLowerCase();

  // Compute the line count. An empty string is 0 lines; otherwise we
  // count newlines (so "a\nb" = 2, "a\nb\n" = 2 — trailing newline
  // doesn't add a line, matching how editors display it).
  const lineCount = React.useMemo(() => {
    if (!value) return 0;
    const trimmed = value.replace(/\n+$/, "");
    if (trimmed === "") return 0;
    return trimmed.split("\n").length;
  }, [value]);

  // Collapse state — long blocks (≥ COLLAPSE_THRESHOLD lines) start
  // collapsed; the user can expand to reveal the full content. The
  // collapsed preview shows the first COLLAPSED_PREVIEW_LINES lines.
  const canCollapse = lineCount >= COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = React.useState(false);
  const isCollapsed = canCollapse && !expanded;

  const displayedValue = React.useMemo(() => {
    if (!isCollapsed) return value;
    const lines = value.replace(/\n+$/, "").split("\n");
    return lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n") + "\n";
  }, [value, isCollapsed]);

  const displayedLineCount = React.useMemo(() => {
    if (!displayedValue) return 0;
    return displayedValue.replace(/\n+$/, "").split("\n").length;
  }, [displayedValue]);

  const isTree = lang === "tree" || (lang === "text" && /[├└│─┬]/.test(value));
  const showLineNumbers = !isTree && lineCount >= 3;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const hiddenLines = lineCount - COLLAPSED_PREVIEW_LINES;

  return (
    <div
      className={cn(
        "group relative my-3 overflow-hidden rounded-lg border bg-card",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <LanguageIcon lang={lang} isTree={isTree} />
          <span className="font-mono text-[11px] uppercase tracking-wide text-brand">
            {isTree ? "tree" : lang}
          </span>
          {lineCount > 0 && (
            <>
              <span className="text-muted-foreground/40 text-[11px]" aria-hidden>
                ·
              </span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {startLine !== undefined && endLine !== undefined
                  ? `L${startLine}-L${endLine}`
                  : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
              </span>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] gap-1.5"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <>
              <Check className="size-3 text-brand" aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" aria-hidden /> Copy
            </>
          )}
        </Button>
      </div>
      <div className="relative overflow-x-auto text-[13px] leading-relaxed">
        {streaming ? (
          <pre className="px-4 py-3.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap break-words text-foreground/90">
            {displayedValue}
          </pre>
        ) : (
          <SyntaxHighlighter
            language={isTree ? "text" : lang}
            style={isDark ? oneDark : oneLight}
            customStyle={{
              margin: 0,
              padding: "0.875rem 1rem",
              background: "transparent",
              fontSize: "13px",
              lineHeight: "1.55",
              whiteSpace: isTree ? "pre" : undefined,
            }}
            codeTagProps={{
              style: {
                fontFamily:
                  "var(--font-mono)",
                whiteSpace: isTree ? "pre" : undefined,
              },
            }}
            wrapLongLines={!isTree}
            showLineNumbers={showLineNumbers}
            lineNumberStyle={{
              minWidth: "2.25rem",
              paddingRight: "0.75rem",
              marginRight: "0.75rem",
              userSelect: "none",
              color: "var(--muted-foreground)",
              opacity: 0.55,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              fontFamily:
                "var(--font-mono)",
            }}
          >
            {displayedValue}
          </SyntaxHighlighter>
        )}
        {isCollapsed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent"
          />
        )}
      </div>
      {canCollapse && (
        <div className="flex items-center justify-center border-t bg-muted/30 py-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse code" : "Expand code"}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3" /> Collapse
              </>
            ) : (
              <>
                <ChevronDown className="size-3" /> Expand {hiddenLines} more{" "}
                {hiddenLines === 1 ? "line" : "lines"}
              </>
            )}
          </Button>
        </div>
      )}
      {canCollapse && (
        <span className="sr-only" aria-live="polite">
          {expanded
            ? `Code block expanded to ${lineCount} lines.`
            : `Code block collapsed. Showing ${displayedLineCount} of ${lineCount} lines. Press the Expand button to reveal ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}.`}
        </span>
      )}
    </div>
  );
});

const LANG_ICON: Record<LangIconKind, React.ElementType> = {
  code: FileCode2,
  json: Braces,
  text: FileText,
  shell: Terminal,
  style: Palette,
  sql: Database,
  other: FileText,
};

function LanguageIcon({ lang, isTree }: { lang: string; isTree?: boolean }) {
  const cls = "size-3.5 text-muted-foreground shrink-0";
  if (isTree || lang === "tree") {
    return <FolderTree className={cls} />;
  }
  const Icon = LANG_ICON[langIconKind(lang)];
  return <Icon className={cls} />;
}

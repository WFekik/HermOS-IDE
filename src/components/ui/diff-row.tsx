"use client";

import * as React from "react";
import { SyntaxHighlighter, oneDark, oneLight, normalizePrismLanguage } from "@/lib/prism";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/theme/theme-provider";

/**
 * Shared diff row renderer used by both DiffViewer (tool-call LCS diffs)
 * and GitDiffView (git unified patch diffs).
 *
 * Pro-editor style: full-width red/green row tints WITH syntax-colored code
 * on top, plus a 2px gutter edge and tinted line numbers carrying the
 * add/del signal.
 *
 * Supports line types:
 *  - "context" — unchanged line, muted foreground
 *  - "add"     — added line, emerald edge
 *  - "del"     — deleted line, red edge
 *  - "hunk"    — @@ hunk header, muted bg
 *  - "meta"    — git metadata lines (index, ---, +++, etc.), subtly muted
 */
export interface SharedDiffLine {
  type: "context" | "add" | "del" | "hunk" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/**
 * Single diff code line with syntax colors, memoized by (language, text,
 * theme). Plain text (unknown language, empty or >1000-char lines) skips
 * Prism entirely — pathological regexes on minified lines would jank
 * scrolling, and minified blobs carry no readable token structure anyway.
 */
const DiffCode = React.memo(
  function DiffCode({ text, language, dark }: { text: string; language: string; dark: boolean }) {
    if (!text || language === "text" || text.length > 1000) {
      return <>{text === "" ? " " : text}</>;
    }
    return (
      <SyntaxHighlighter
        language={normalizePrismLanguage(language)}
        style={dark ? oneDark : oneLight}
        PreTag="span"
        customStyle={{ margin: 0, padding: 0, background: "transparent", display: "inline" }}
        codeTagProps={{ style: { fontFamily: "inherit", background: "transparent" } }}
      >
        {text}
      </SyntaxHighlighter>
    );
  },
  (prev, next) => prev.text === next.text && prev.language === next.language && prev.dark === next.dark,
);

export function DiffRow({ line, language = "text" }: { line: SharedDiffLine; language?: string }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  if (line.type === "hunk") {
    return (
      <div className="bg-muted/60 px-3 py-0.5 text-muted-foreground">
        {line.text}
      </div>
    );
  }
  if (line.type === "meta") {
    return (
      <div className="px-3 py-0.5 text-muted-foreground/70 select-none">
        {line.text}
      </div>
    );
  }
  const marker = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
  const isAdd = line.type === "add";
  const isDel = line.type === "del";
  return (
    <div
      className={cn(
        // Editor-style rows: full-width red/green tint WITH syntax-colored
        // code on top, plus a 2px gutter edge and tinted line numbers.
        "flex items-stretch border-s-2 border-s-transparent transition-colors",
        isAdd && "border-s-emerald-500/80 bg-emerald-500/15 hover:bg-emerald-500/20",
        isDel && "border-s-red-500/80 bg-red-500/15 hover:bg-red-500/20",
        !isAdd && !isDel && "hover:bg-accent/30",
      )}
    >
      <span
        className={cn(
          "w-10 shrink-0 select-none border-e border-border/50 px-2 text-end tabular-nums",
          isDel
            ? "text-red-600/80 dark:text-red-400/80"
            : isAdd
              ? "text-emerald-600/90 dark:text-emerald-400/90"
              : "text-muted-foreground/60",
        )}
      >
        {line.newNo ?? line.oldNo ?? ""}
      </span>
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          isAdd && "text-emerald-700 dark:text-emerald-400",
          isDel && "text-red-700 dark:text-red-400",
          line.type === "context" && "text-muted-foreground/60",
        )}
      >
        {marker}
      </span>
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words ps-2 pe-3 text-foreground/80">
        <DiffCode text={line.text} language={language} dark={dark} />
      </span>
    </div>
  );
}

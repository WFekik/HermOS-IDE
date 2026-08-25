"use client";

import {
  Braces,
  Database,
  FileCode2,
  FileText,
  FileType,
  Palette,
  Presentation,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for the tool-call UI building blocks shared by
 * ToolCallCard (tool-call-card.tsx) and MessageRenderer/FileOpBlock
 * (message-renderer.tsx): the file-op tool registry, LCS line counting,
 * diff-stat computation, byte formatting, and the file-extension → icon
 * mappings used by every file/icon picker surface.
 */

/* ------------------------------ File-op tools ------------------------------ */

/** Tool names that operate on a file path argument. */
export const FILE_OP_TOOLS = new Set([
  "read_file",
  "view_file",
  "write_file",
  "write_to_file",
  "edit_file",
  "replace_file_content",
  "multi_edit",
  "multi_replace_file_content",
  "inline_edit",
  "remove_file",
  "delete",
  "create_artifact",
]);

/* ------------------------------ Diff stats ------------------------------ */

/** Count add/del lines between two text blocks using LCS (same algorithm as DiffViewer). */
export function countDiffLines(oldText: string, newText: string): { add: number; del: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  let add = 0, del = 0;
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { del++; i++; }
    else { add++; j++; }
  }
  del += m - i;
  add += n - j;
  return { add, del };
}

/**
 * Compute the +/- line stats shown next to a tool call: prefers the
 * tool result's old/new content (consistent with DiffViewer), falls back
 * to the tool arguments (works for running & done states, including
 * streaming args). Returns null when neither source yields a diff.
 */
export function computeDiffStats(
  toolName: string,
  result: unknown,
  args: Record<string, unknown> | undefined,
): { add: number; del: number } | null {
  if (result && typeof result === "object") {
    const r = result as { oldContent?: string; newContent?: string; created?: boolean; diff?: { additions?: number; deletions?: number } };
    if (typeof r.oldContent === "string" && typeof r.newContent === "string") {
      if (r.oldContent === r.newContent) return { add: 0, del: 0 };
      return countDiffLines(r.oldContent, r.newContent);
    }
    if (r.created && typeof r.newContent === "string") {
      return { add: r.newContent.split("\n").length, del: 0 };
    }
    if (r.diff && typeof r.diff.additions === "number" && typeof r.diff.deletions === "number") {
      return { add: r.diff.additions, del: r.diff.deletions };
    }
  }
  if (args && typeof args === "object") {
    const content = typeof args.content === "string" ? args.content : typeof args.CodeContent === "string" ? args.CodeContent : null;
    if ((toolName === "write_file" || toolName === "write_to_file" || toolName === "create_artifact") && content !== null) {
      const lines = content.length > 0 ? content.split("\n").length : 0;
      return { add: lines, del: 0 };
    }
    const find = typeof args.find === "string" ? args.find : typeof args.TargetContent === "string" ? args.TargetContent : null;
    const replace = typeof args.replace === "string" ? args.replace : typeof args.ReplacementContent === "string" ? args.ReplacementContent : null;
    if ((toolName === "edit_file" || toolName === "replace_file_content" || toolName === "inline_edit") && find !== null && replace !== null) {
      return countDiffLines(find, replace);
    }
    const chunks = Array.isArray(args.edits) ? args.edits : Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : null;
    if ((toolName === "multi_edit" || toolName === "multi_replace_file_content") && chunks) {
      let add = 0, del = 0;
      for (const c of chunks) {
        if (c && typeof c === "object") {
          const f = typeof c.find === "string" ? c.find : typeof c.TargetContent === "string" ? c.TargetContent : "";
          const r = typeof c.replace === "string" ? c.replace : typeof c.ReplacementContent === "string" ? c.ReplacementContent : "";
          const res = countDiffLines(f, r);
          add += res.add;
          del += res.del;
        }
      }
      return { add, del };
    }
  }
  return null;
}

/* ------------------------------ Formatting ------------------------------ */

/** Format a byte count as a compact human-readable string ("" when absent). */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* --------------------------- File icon lookups --------------------------- */

/**
 * Filename-based icon category shared by the workspace file tree and the
 * command palette. Consumers render their own lucide component per kind so
 * each surface keeps its exact visual output.
 */
export type FileNameIconKind = "code" | "json" | "image" | "config" | "text";

export function fileNameIconKind(name: string): FileNameIconKind {
  const lower = name.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower === "package.json"
  ) {
    return "code";
  }
  if (lower.endsWith(".json")) return "json";
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".svg") ||
    lower.endsWith(".webp")
  ) {
    return "image";
  }
  if (
    lower === "dockerfile" ||
    lower.endsWith(".env") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".config.js")
  ) {
    return "config";
  }
  return "text";
}

/**
 * Extension-based icon metadata for file paths (tool-call cards, attachments).
 * Colors mirror the original per-site palettes.
 */
export interface FileTypeIconMeta {
  icon: LucideIcon;
  color: string;
}

const FILE_TYPE_ICONS: Record<string, FileTypeIconMeta> = {
  ts: { icon: FileCode2, color: "text-blue-400" },
  tsx: { icon: FileCode2, color: "text-blue-400" },
  js: { icon: FileCode2, color: "text-yellow-400" },
  jsx: { icon: FileCode2, color: "text-yellow-400" },
  json: { icon: Braces, color: "text-amber-400" },
  css: { icon: Palette, color: "text-pink-400" },
  scss: { icon: Palette, color: "text-pink-400" },
  html: { icon: FileCode2, color: "text-orange-400" },
  md: { icon: FileText, color: "text-zinc-400" },
  py: { icon: FileCode2, color: "text-emerald-400" },
  sh: { icon: TerminalIcon, color: "text-green-400" },
  bash: { icon: TerminalIcon, color: "text-green-400" },
  sql: { icon: Database, color: "text-cyan-400" },
  pptx: { icon: Presentation, color: "text-orange-400" },
  docx: { icon: FileType, color: "text-blue-400" },
  pdf: { icon: FileText, color: "text-red-400" },
};

const DEFAULT_FILE_TYPE_ICON: FileTypeIconMeta = { icon: FileText, color: "text-zinc-400" };

export function fileTypeIconMeta(ext: string): FileTypeIconMeta {
  return FILE_TYPE_ICONS[ext.toLowerCase()] ?? DEFAULT_FILE_TYPE_ICON;
}

/**
 * Language-tag-based icon category for code blocks. The caller handles the
 * special "tree" language before consulting this.
 */
export type LangIconKind = "code" | "json" | "text" | "shell" | "style" | "sql" | "other";

export function langIconKind(lang: string): LangIconKind {
  switch (lang) {
    case "ts":
    case "tsx":
    case "typescript":
    case "js":
    case "jsx":
    case "javascript":
    case "mjs":
    case "cjs":
      return "code";
    case "json":
    case "json5":
    case "jsonc":
      return "json";
    case "md":
    case "markdown":
    case "txt":
    case "text":
      return "text";
    case "bash":
    case "sh":
    case "shell":
    case "zsh":
    case "fish":
    case "bat":
    case "cmd":
    case "powershell":
    case "ps1":
      return "shell";
    case "css":
    case "scss":
    case "sass":
    case "less":
    case "stylus":
      return "style";
    case "sql":
    case "psql":
    case "mysql":
    case "postgres":
      return "sql";
    default:
      return "other";
  }
}

import { mkdir, writeFile, readdir, rm, stat } from "fs/promises";
import path from "path";
import { APP_DATA_DIR, safeUserId } from "@/lib/paths";

export const TRUNCATION_DIR = path.join(APP_DATA_DIR, "truncation");

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const TOOL_OUTPUT_MAX_LINES = 2000;
export const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const RETENTION_DAYS = 7;

/**
 * Per-user truncation directory: truncated outputs can contain file
 * contents, so a shared dir would let one user's agent read another's.
 */
export function truncationUserDir(userId: string): string {
  return path.join(TRUNCATION_DIR, safeUserId(userId));
}

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  direction?: "head" | "tail";
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
}

export interface TruncateLimits {
  maxLines: number;
  maxBytes: number;
}

let limitsCache: TruncateLimits | null = null;

export async function getLimits(): Promise<TruncateLimits> {
  if (limitsCache) return limitsCache;
  limitsCache = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
  return limitsCache;
}

export async function writeTruncation(userId: string, text: string): Promise<string> {
  const dir = truncationUserDir(userId);
  await mkdir(dir, { recursive: true });
  const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, id);
  await writeFile(file, text, "utf-8");
  return file;
}

export async function cleanupTruncation(): Promise<void> {
  try {
    const entries = await readdir(TRUNCATION_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const filePath = path.join(TRUNCATION_DIR, entry);
      try {
        const entryStat = await stat(filePath);
        if (entryStat.isDirectory()) {
          const files = await readdir(filePath);
          for (const f of files) {
            if (!f.startsWith("tool_")) continue;
            const fPath = path.join(filePath, f);
            try {
              const s = await stat(fPath);
              if (s.mtimeMs < cutoff) await rm(fPath);
            } catch {
              // ignore
            }
          }
        } else if (entryStat.mtimeMs < cutoff) {
          await rm(filePath);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // directory doesn't exist
  }
}

const SMALL_STRING_THRESHOLD = 1024;

export async function truncateOutput(
  text: string,
  options: TruncateOptions = {},
  agentHasTaskTool = false,
  userId?: string,
): Promise<TruncateResult> {
  const { maxLines, maxBytes } = await getLimits();
  const resolvedMaxLines = options.maxLines ?? maxLines;
  const resolvedMaxBytes = options.maxBytes ?? maxBytes;

  // Fast path: for small strings with default limits, avoid split/byteLength overhead.
  // Only safe when no custom limits are in play (caller may pass tighter constraints).
  if (text.length < SMALL_STRING_THRESHOLD && !options.maxLines && !options.maxBytes) {
    return { content: text, truncated: false };
  }

  const direction = options.direction ?? "head";

  // Early exit: count newlines instead of splitting the full string.
  // Use Buffer.byteLength for the byte comparison to handle multi-byte chars correctly.
  let newlineCount = 0;
  let limitCheckPos = 0;
  const len = text.length;
  while (limitCheckPos < len && newlineCount <= resolvedMaxLines) {
    if (text[limitCheckPos] === "\n") newlineCount++;
    limitCheckPos++;
  }
  // If chars > maxBytes, byteLength is definitely > maxBytes (byteLength >= chars).
  // If chars <= maxBytes, check actual byteLength to handle multi-byte chars.
  if (newlineCount < resolvedMaxLines) {
    if (len > resolvedMaxBytes) {
      // Definitely over the byte limit — fall through to truncation
    } else if (Buffer.byteLength(text, "utf-8") <= resolvedMaxBytes) {
      return { content: text, truncated: false };
    }
  }

  // Only now split into lines — we know we need to truncate
  const lines = text.split("\n");
  const totalBytes = Buffer.byteLength(text, "utf-8");

  const out: string[] = [];
  let bytes = 0;
  let hitBytes = false;

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < resolvedMaxLines; i++) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
      if (bytes + size > resolvedMaxBytes) {
        hitBytes = true;
        break;
      }
      out.push(lines[i]);
      bytes += size;
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < resolvedMaxLines; i--) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0);
      if (bytes + size > resolvedMaxBytes) {
        hitBytes = true;
        break;
      }
      out.unshift(lines[i]);
      bytes += size;
    }
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length;
  const unit = hitBytes ? "bytes" : "lines";
  const preview = out.join("\n");
  const file = await writeTruncation(userId ?? "default", text);
  void cleanupTruncation();

  const hint = agentHasTaskTool
    ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have a subagent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
    : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;

  return {
    content:
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
    truncated: true,
    outputPath: file,
  };
}

export async function truncateToolOutput(text: string, userId?: string): Promise<TruncateResult> {
  return truncateOutput(
    text,
    {
      maxLines: TOOL_OUTPUT_MAX_LINES,
      maxBytes: TOOL_OUTPUT_MAX_BYTES,
    },
    undefined,
    userId,
  );
}

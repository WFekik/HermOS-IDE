import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { z } from "zod";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  safePath,
  readFileWs,
} from "@/lib/workspace";
import { computeDiff, type DiffLine } from "@/lib/diff";
import {
  withErrorHandler,
  parseJson, apiError, unauthorized, ok } from "@/app/api/_lib/helpers";
import fs from "fs/promises";
import path from "path";

/**
 * Lightweight code formatter (proposed changes only — does NOT write to disk).
 *
 *   POST /api/workspace/format  body { path: string }
 *
 * This is NOT a full prettier. It is a small, dependency-free tidier that:
 *   - JSON (.json): parses + re-stringifies with 2-space indent. If the file
 *     is not valid JSON, returns `{ ok: false, error: "Invalid JSON" }`.
 *   - JS/TS/CSS/MD (.js .jsx .ts .tsx .css .md): trims trailing whitespace
 *     per line, normalises line endings to LF, collapses 3+ consecutive blank
 *     lines to 2, and ensures the file ends with a single trailing newline.
 *
 * Returns `{ ok: true, path, oldContent, newContent, diff }` where `diff` is
 * the `DiffLine[]` from `computeDiff`. If the formatter produces no changes,
 * returns `{ ok: true, path, unchanged: true }` instead.
 *
 * The file is NOT modified on disk — the frontend can apply the proposed
 * `newContent` via the existing `PUT /api/workspace/file` endpoint if the user
 * approves.
 *
 * Requires auth. Rate limited at 20/min/user. File size capped at 1MB.
 */

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 1_000_000;

const formatSchema = z.object({
  path: z.string().trim().min(1).max(300),
});

function languageForPath(rel: string): "json" | "tidy" | "unknown" {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") return "json";
  if (
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".css" ||
    ext === ".md"
  ) {
    return "tidy";
  }
  return "unknown";
}

/**
 * Tidy a JS/TS/CSS/MD file: trim trailing whitespace per line, normalise line
 * endings to LF, collapse 3+ consecutive blank lines to 2, and ensure the file
 * ends with a single trailing newline.
 *
 * Honest scope: this does NOT reformat indentation, wrap long lines, sort
 * imports, add/remove semicolons, or fix style. It only normalises whitespace
 * that almost every editor agrees on.
 */
function tidyText(input: string): string {
  const normalised = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Split into lines. We do NOT treat a trailing newline as creating an extra
  // empty line (matches the convention in workspace.ts/readFileRangeWs).
  const parts = normalised.split("\n");
  if (parts.length > 0 && normalised.endsWith("\n")) parts.pop();

  const trimmed = parts.map((line) => line.replace(/[ \t]+$/g, ""));

  // Collapse 3+ consecutive blank lines to 2.
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of trimmed) {
    if (line === "") {
      blankRun++;
      if (blankRun <= 2) collapsed.push(line);
      // else: skip (this blank is part of a run > 2)
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  // Strip leading blank lines (so the file doesn't start with empties) and
  // strip trailing blank lines (so the file ends with exactly one newline).
  let start = 0;
  while (start < collapsed.length && collapsed[start] === "") start++;
  let end = collapsed.length;
  while (end > start && collapsed[end - 1] === "") end--;
  const body = collapsed.slice(start, end);

  return body.length === 0 ? "" : body.join("\n") + "\n";
}

function formatJson(input: string): { ok: true; out: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid JSON",
    };
  }
  const out = JSON.stringify(parsed, null, 2) + "\n";
  return { ok: true, out };
}

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-format:${user.id}`, {
    capacity: 20,
    refillPerSec: 20 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = formatSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }
  const rel = parsed.data.path;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  // Defense-in-depth: validate path confinement before touching the disk.
  // readFileWs already uses safePath, but we re-check here so we can return a
  // 400 (rather than letting readFileWs throw "Invalid path.") and to keep
  // the size guard local to this route.
  const abs = safePath(user.id, ws.name, rel, ws.rootDir);
  if (!abs) return apiError("Invalid path.", 400);

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return apiError("File not found.", 404);
  if (stat.size > MAX_FILE_BYTES) {
    return apiError(`File too large to format (max ${MAX_FILE_BYTES} bytes).`, 400);
  }

  const lang = languageForPath(rel);
  if (lang === "unknown") {
    return apiError(
      "Unsupported file type for formatting. Supported: .js .jsx .ts .tsx .json .css .md",
      400,
    );
  }

  let file: { path: string; content: string; size: number };
  try {
    file = await readFileWs(user.id, ws.name, rel, undefined, ws.rootDir);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "read failed", 400);
  }
  const oldContent = file.content;

  let newContent: string;
  if (lang === "json") {
    const r = formatJson(oldContent);
    if (!r.ok) {
      return ok({ ok: false, error: "Invalid JSON", detail: r.error });
    }
    newContent = r.out;
  } else {
    newContent = tidyText(oldContent);
  }

  if (newContent === oldContent) {
    return ok({ ok: true, path: rel, unchanged: true });
  }

  const diff: DiffLine[] = computeDiff(oldContent, newContent);
  return ok({
    ok: true,
    path: rel,
    oldContent,
    newContent,
    diff,
  });
});

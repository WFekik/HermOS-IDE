import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  readFileWs,
} from "@/lib/workspace";
import { extractSymbols, languageFromExt, type SymbolInfo, type SymbolLanguage } from "@/lib/symbols";
import {
  withErrorHandler,
  apiError, unauthorized, ok } from "@/app/api/_lib/helpers";

/**
 * GET /api/workspace/symbols?path=<rel>
 *
 * Extract JS/TS symbols (functions, classes, interfaces, types, consts,
 * exports, imports) from a workspace file using a lightweight regex-based
 * extractor (no AST parser dependency).
 *
 * - path: required, relative to the workspace root (≤ 300 chars).
 * - Supported extensions: .ts → "typescript", .tsx → "tsx", .js/.mjs/.cjs →
 *   "javascript", .jsx → "jsx". Other extensions return an empty symbol list.
 *
 * Requires auth. Rate limited at 30/min/user.
 *
 * Response: { symbols: SymbolInfo[], path, language }
 */
export const dynamic = "force-dynamic";

const MAX_PATH_LEN = 300;

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-symbols:${user.id}`, RATE_LIMITS.chat);
  if (limited) return limited;

  const url = new URL(req.url);
  const rel = (url.searchParams.get("path") || "").trim();
  if (!rel) return apiError("Missing path query.", 400);
  if (rel.length > MAX_PATH_LEN) {
    return apiError(`Path too long (max ${MAX_PATH_LEN} chars).`, 400);
  }
  if (rel.includes("..")) {
    return apiError("Path traversal is not allowed.", 400);
  }

  // Determine language from extension BEFORE reading the file (so we can
  // short-circuit unsupported file types without a disk read).
  const language: SymbolLanguage | null = languageFromExt(rel);
  if (!language) {
    return ok({ symbols: [], path: rel, language: null });
  }

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  let file: { path: string; content: string; size: number };
  try {
    file = await readFileWs(user.id, ws.name, rel, undefined, ws.rootDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "read failed";
    // readFileWs throws "File not found." for missing files and "Invalid path."
    // for traversal attempts — surface a 404 / 400 accordingly.
    if (msg === "File not found.") return apiError(msg, 404);
    if (msg === "Invalid path.") return apiError(msg, 400);
    return apiError(msg, 400);
  }

  const symbols: SymbolInfo[] = extractSymbols(file.content, language);
  return ok({ symbols, path: rel, language });
});

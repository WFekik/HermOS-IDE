import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  grepWorkspace,
  type GrepMatch,
} from "@/lib/workspace";
import {
  withErrorHandler,
  apiError,
  unauthorized,
  ok,
} from "@/app/api/_lib/helpers";

/**
 * Real content search across workspace files — like `grep -r`.
 *
 *   GET /api/workspace/grep?q=<query>&path=<rel>&filePattern=<glob>&maxResults=<n>&regex=<0|1>
 *
 * - q: 1–200 chars. Matched as a case-insensitive regular expression when
 *   `regex=1` is set (same semantics as the agent's `grep` tool), otherwise
 *   as a case-insensitive substring. Invalid regexes return 400.
 * - path: optional relative sub-path to scope the search (defaults to ws root);
 *   may point at a file or a directory.
 * - filePattern: optional glob matched against file basenames (e.g. "*.ts").
 *   Allowed chars: alphanumeric + `* ? . -` (1–100 chars).
 * - maxResults: 1–200 (default 100).
 *
 * Rate limited at 30/min/user. Auth required.
 */
export const dynamic = "force-dynamic";

const FILE_PATTERN_RE = /^[A-Za-z0-9*?.-]{1,100}$/;
const SUBPATH_RE = /^[A-Za-z0-9._/\-]{0,500}$/;

/**
 * Security guard (ReDoS): reject regexes that can backtrack catastrophically.
 * A quantified group that itself contains a quantifier or an alternation
 * (`(a+)+`, `(ab?)*`, `(a|b)+`, `(a{2,})+`) permits exponential backtracking
 * against long lines; single-level constructs (`(foo)+`, `a|b`, `a+`, `[ab]+`)
 * are fine. Code-search patterns never need nested repetition, so rejecting
 * them is a security decision to keep this endpoint CPU-bounded.
 */
function isReDoSPattern(pattern: string): boolean {
  // Drop escapes (`\(`, `\*`, ...) so literal characters don't count as
  // group/quantifier syntax.
  const stripped = pattern.replace(/\\./g, "");
  return (
    /\([^()]*[+*?{][^()]*\)[+*?{}]/.test(stripped) ||
    /\([^()]*\|[^()]*\)[+*?{]/.test(stripped)
  );
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-grep:${user.id}`, RATE_LIMITS.chat);
  if (limited) return limited;
  // Residual ReDoS risk: `isReDoSPattern` above rejects catastrophic
  // (exponential) backtracking, but linear-ish worst cases (large
  // alternations, long literal scans over huge files) still consume CPU —
  // bounded by the 60/min rate limit (RATE_LIMITS.chat) and the 200-char
  // query cap. This is a documented trade-off: full regex support is
  // required for code search. No further hardening without dropping
  // regex mode entirely.

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return apiError("Query is required.", 400);
  if (q.length > 200) return apiError("Query too long (max 200 chars).", 400);

  // Regex mode matches the agent `grep` tool's semantics exactly: the query
  // is a case-insensitive regular expression. Invalid patterns return 400
  // with an escape hint instead of silently matching nothing.
  const regexParam = (url.searchParams.get("regex") || "").trim().toLowerCase();
  const useRegex = regexParam === "1" || regexParam === "true" || regexParam === "yes";
  let regex: RegExp | undefined;
  if (useRegex) {
    if (isReDoSPattern(q)) {
      return apiError(
        "Regular expression rejected: nested repetition ((a+)+, (a|b)+, ...) is not allowed.",
        400,
      );
    }
    try {
      regex = new RegExp(q, "i");
    } catch (e) {
      return apiError(
        `Invalid regular expression: ${e instanceof Error ? e.message : "unknown error"}. Escape special characters (e.g. "catch \\\\{" or "foo\\\\.bar").`,
        400,
      );
    }
  }

  const filePattern = (url.searchParams.get("filePattern") || "").trim();
  if (filePattern && !FILE_PATTERN_RE.test(filePattern)) {
    return apiError(
      "Invalid filePattern (allowed: alphanumeric, *, ?, ., -; 1–100 chars).",
      400,
    );
  }

  const subPath = (url.searchParams.get("path") || "").trim();
  if (subPath && !SUBPATH_RE.test(subPath)) {
    return apiError("Invalid path.", 400);
  }
  // Reject path traversal attempts explicitly (safePath also enforces this,
  // but failing fast gives a clearer error).
  if (subPath.includes("..")) {
    return apiError("Path traversal is not allowed.", 400);
  }

  let maxResults = 100;
  const maxResultsParam = url.searchParams.get("maxResults");
  if (maxResultsParam !== null) {
    const parsed = Number.parseInt(maxResultsParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
      return apiError("maxResults must be an integer between 1 and 200.", 400);
    }
    maxResults = parsed;
  }

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  let matches: GrepMatch[];
  try {
    matches = await grepWorkspace(user.id, ws.name, q, {
      maxResults,
      filePattern: filePattern || undefined,
      subPath: subPath || undefined,
      regex,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Search failed.";
    return apiError(msg, 400);
  }

  return ok({
    matches,
    query: q,
    workspace: { name: ws.name },
  });
});

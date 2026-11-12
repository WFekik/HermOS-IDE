import { readdirSync } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  readFileWs,
  readFileRangeWs,
  writeFileWs,
  createFileWs,
  deletePathWs,
  mkdirWs,
  isSubpathOrEqual,
  safePath,
  safePathFromRoot,
  MAX_FILE_BYTES,
} from "@/lib/workspace";
import { ARTIFACTS_DIR } from "@/lib/paths";
import { parseJson, apiError, ok, withErrorHandler } from "@/app/api/_lib/helpers";
import { noNulBytes, byteCappedContent } from "@/lib/validation";

export const dynamic = "force-dynamic";

const pathSchema = z.string().trim().min(1).max(300).refine(noNulBytes, {
  message: "Invalid path.",
});

const writeSchema = z.object({
  path: pathSchema,
  content: byteCappedContent(MAX_FILE_BYTES),
}).refine((d) => noNulBytes(d.content), {
  message: "Content cannot contain NUL bytes",
  path: ["content"],
});

const createSchema = z.object({
  path: pathSchema,
  type: z.enum(["file", "dir"]).default("file"),
  content: byteCappedContent(MAX_FILE_BYTES).optional(),
}).refine((d) => d.content === undefined || noNulBytes(d.content), {
  message: "Content cannot contain NUL bytes",
  path: ["content"],
});

async function resolveWs(userId: string) {
  return (await getActiveWorkspace(userId)) ?? (await ensureDefaultWorkspace(userId));
}

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Resolve the artifact roots for a request.
 *
 * `conversationId` arrives from the query string, so it is validated and
 * containment-checked before being used as a path segment: an escaped
 * conversation root would make every absolute-path read below resolve against
 * an attacker-chosen directory (arbitrary local file access).
 */
function resolveArtifactRoots(
  userId: string,
  conversationIdParam: string | null,
): { userDir: string; conversationDir: string | null; invalid: boolean } {
  const userDir = path.join(ARTIFACTS_DIR, userId);
  const conversationId = (conversationIdParam ?? "").trim();
  if (!conversationId) return { userDir, conversationDir: null, invalid: false };
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { userDir, conversationDir: null, invalid: true };
  }
  const conversationDir = path.resolve(userDir, conversationId);
  if (!isSubpathOrEqual(conversationDir, path.resolve(userDir))) {
    return { userDir, conversationDir: null, invalid: true };
  }
  return { userDir, conversationDir, invalid: false };
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const limited = await withRateLimit(req, `ws-files:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const url = new URL(req.url);
  const rawRel = url.searchParams.get("path") || "";
  if (!rawRel) return apiError("Missing path query.", 400);
  // NUL bytes are invalid in every path API — reject as a 400 instead of
  // letting fs throw an unhandled ERR_INVALID_ARG_VALUE.
  if (rawRel.includes("\u0000")) return apiError("Invalid path.", 400);
  // Strip file:// prefix so clicking file:// links in rendered markdown
  // resolves correctly instead of returning a silent 500.
  const rel = rawRel.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");

  const {
    userDir: artifactUserDir,
    conversationDir: conversationArtifactDir,
    invalid: invalidConversation,
  } = resolveArtifactRoots(user.id, url.searchParams.get("conversationId"));
  if (invalidConversation) return apiError("Invalid conversation.", 400);

  // Raw binary file read for images and media files in artifacts
  if (url.searchParams.get("raw") === "true") {
    const ws = await resolveWs(user.id);
    const cleanPath = rel;
    const fs = await import("fs/promises");
    const { existsSync } = await import("fs");
    const { safePath, safePathFromRoot } = await import("@/lib/workspace");

    let absPath = safePath(user.id, ws.name, cleanPath, ws.rootDir);
    if (!absPath && path.isAbsolute(cleanPath) && existsSync(cleanPath)) {
      absPath = conversationArtifactDir
        ? safePathFromRoot(conversationArtifactDir, cleanPath)
        : null;
      absPath = absPath ?? safePathFromRoot(artifactUserDir, cleanPath);
    }
    if (!absPath && conversationArtifactDir) {
      const direct = path.join(conversationArtifactDir, path.basename(cleanPath));
      if (existsSync(direct)) {
        absPath = safePathFromRoot(conversationArtifactDir, direct);
      }
    }
    if (!absPath) return apiError("Invalid path.", 400);

    const buf = await fs.readFile(absPath).catch(() => null);
    if (!buf) return apiError("Image file not found.", 404);
    const ext = path.extname(cleanPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
      ".html": "text/html",
      ".htm": "text/html",
      ".xhtml": "application/xhtml+xml",
      ".xml": "application/xml",
      ".xsl": "application/xml",
      ".xslt": "application/xml",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    // SVG/HTML/XML XSS mitigation: these types can execute script when rendered inline
    // from the app origin (e.g. <svg onload=...> or <script> in html). Mirror the
    // attachments route's safe behavior: force download via Content-Disposition:
    // attachment and isolate via CSP sandbox + nosniff. Inline without sandbox would
    // run in the app origin and allow XSS exfiltration of local secrets. Global CSP
    // from next.config.ts already sets default-src 'self', but per-response sandbox
    // is required for user-supplied SVG/HTML so it cannot inherit the app origin.
    const riskyInline = /(text\/html|application\/xhtml\+xml|text\/xml|application\/xml|image\/svg\+xml)/i.test(contentType);
    const filename = path.basename(cleanPath) || "file";
    const disposition = riskyInline
      ? `attachment; filename="${encodeURIComponent(filename)}"`
      : `inline; filename="${encodeURIComponent(filename)}"`;
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buf.length),
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
        ...(riskyInline ? { "Content-Security-Policy": "sandbox" } : {}),
        "Cache-Control": riskyInline ? "private, no-store" : "public, max-age=3600",
      },
    });
  }

  const startRaw = url.searchParams.get("start");
  const endRaw = url.searchParams.get("end");
  const hasStart = startRaw !== null;
  const hasEnd = endRaw !== null;

  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      return apiError("Both 'start' and 'end' query params are required for range reads.", 400);
    }
    const startNum = Number.parseInt(startRaw, 10);
    const endNum = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
      return apiError("'start' and 'end' must be integers.", 400);
    }
    if (startNum < 1) return apiError("'start' must be ≥ 1.", 400);
    if (endNum < startNum) {
      return apiError("'end' must be ≥ 'start'.", 400);
    }
    const ws = await resolveWs(user.id);
    const range = await readFileRangeWs(user.id, ws.name, rel, startNum, endNum, ws.rootDir);
    return ok({ file: range });
  }

  const { statSync, existsSync, readFileSync } = await import("fs");
  const ws = await resolveWs(user.id);

  // Directly read absolute artifact files existing on disk (within workspace or the current user's artifacts)
  const isAbsExisting = path.isAbsolute(rel) && existsSync(rel);
  let artifactAbs = isAbsExisting
    ? (conversationArtifactDir ? safePathFromRoot(conversationArtifactDir, rel) : null) ??
      safePathFromRoot(artifactUserDir, rel)
    : null;
  if (!artifactAbs && conversationArtifactDir) {
    const directPath = path.join(conversationArtifactDir, path.basename(rel));
    if (existsSync(directPath)) {
      artifactAbs = safePathFromRoot(conversationArtifactDir, directPath);
    }
  }
  const workspaceAbs = isAbsExisting ? safePathFromRoot(ws.rootDir, rel) : null;
  const resolvedAbs = artifactAbs ?? workspaceAbs;

  if (resolvedAbs) {
    try {
      const stat = statSync(resolvedAbs);
      if (stat.isFile()) {
        const content = readFileSync(resolvedAbs, "utf8");
        return ok({ content, file: { path: rel, content, size: stat.size } });
      }
    } catch {
      /* fall through to workspace reading */
    }
  }

  const absPath = safePath(user.id, ws.name, rel, ws.rootDir);

  if (absPath) {
    try {
      const stat = statSync(absPath);
      // Auto-page files > 500 KB to initial 1,000 line chunk to prevent browser freezes
      if (stat.size > 500_000) {
        const range = await readFileRangeWs(user.id, ws.name, rel, 1, 1000, ws.rootDir);
        return ok({ content: range.content, file: range });
      }
    } catch {
      /* fall through to standard read */
    }
  }

  /**
   * Find an artifact by name under the user's artifact directory.
   *
   * Artifacts are stored at `<artifacts>/<userId>/<conversationId>/<filename>`,
   * so the same basename can legitimately exist under several conversation
   * subdirectories. To make basename-only matching deterministic:
   *   1. prefer a candidate whose on-disk path mirrors the requested path
   *      (handles both bare names and absolute on-disk artifact paths), and
   *   2. otherwise prefer the most recently modified candidate — the one the
   *      client is most likely viewing.
   */
  function findBestArtifact(dir: string, requestedRel: string): string | null {
    if (!existsSync(dir)) return null;
    const targetName = path.basename(requestedRel);
    const matches: string[] = [];
    const walk = (current: string) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
          matches.push(fullPath);
        }
      }
    };
    walk(dir);

    // Mirror match: reduce the requested path to an artifact-relative suffix
    // and prefer a candidate ending with it, so the same conversation's file
    // wins over an unrelated one with the same basename.
    const dirLower = dir.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    const relLower = requestedRel.replace(/\\/g, "/").toLowerCase();
    const relIdx = relLower.indexOf(dirLower);
    const suffix = (relIdx >= 0 ? relLower.slice(relIdx + dirLower.length) : relLower).replace(/^\/+/, "");
    if (suffix.includes("/")) {
      const normalized = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const exact = matches.find((m) => normalized(m).endsWith(`/${suffix}`));
      if (exact) return exact;
    }

    let best: string | null = null;
    let bestMtime = 0;
    for (const m of matches) {
      try {
        const s = statSync(m);
        if (s.isFile() && s.mtimeMs > bestMtime) {
          best = m;
          bestMtime = s.mtimeMs;
        }
      } catch {
        /* unreadable candidate — skip */
      }
    }
    return best;
  }

  try {
    const file = await readFileWs(user.id, ws.name, rel, undefined, ws.rootDir);
    return ok({ content: file.content, file });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "";
    if (message !== "File not found." && message !== "Invalid path.") {
      throw err;
    }

    // Artifact fallback: artifacts live outside the workspace at
    // <artifacts>/<userId>/<conversationId>/<filename>, so a request for an
    // artifact path (absolute on-disk path or bare filename) won't resolve in
    // the workspace. Only fall back for requests scoped to the user's own
    // artifact directory — never for arbitrary or path-traversal workspace
    // paths, which should still 404.
    const isBareFilename = rel === path.basename(rel);
    const isArtifactScoped = path.isAbsolute(rel) && safePathFromRoot(artifactUserDir, rel) !== null;
    if (isBareFilename || isArtifactScoped) {
      let foundArtifactPath: string | null = null;
      if (conversationArtifactDir) {
        const directConvPath = path.join(conversationArtifactDir, path.basename(rel));
        if (existsSync(directConvPath)) {
          foundArtifactPath = safePathFromRoot(artifactUserDir, directConvPath);
        }
      }
      if (!foundArtifactPath && !conversationArtifactDir) {
        foundArtifactPath = findBestArtifact(artifactUserDir, rel);
      }
      if (foundArtifactPath) {
        try {
          const stat = statSync(/* turbopackIgnore: true */ foundArtifactPath);
          if (stat.isFile()) {
            const content = readFileSync(/* turbopackIgnore: true */ foundArtifactPath, "utf8");
            return ok({ content, file: { path: foundArtifactPath, content, size: stat.size } });
          }
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return apiError("File not found.", 404);
  }
});

export const PUT = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const limited = await withRateLimit(req, `ws-files-write:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<any>(req);
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid write request.", 400, {
      details: parsed.error.flatten(),
    });
  }

  const ws = await resolveWs(user.id);
  try {
    const res = await writeFileWs(user.id, ws.name, parsed.data.path, parsed.data.content, ws.rootDir);
    return ok({ file: res });
  } catch (e) {
    // writeFileWs validates too (defense in depth behind the schema): map
    // its client errors to 400 so they never surface as 500s.
    const msg = e instanceof Error ? e.message : "Write failed.";
    if (msg === "Invalid path." || msg.startsWith("Content too large") || msg.startsWith("Refusing to save")) {
      return apiError(msg, 400);
    }
    throw e;
  }
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const limited = await withRateLimit(req, `ws-files-write:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<any>(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid create request.", 400, {
      details: parsed.error.flatten(),
    });
  }

  const ws = await resolveWs(user.id);
  if (parsed.data.type === "dir") {
    // Directory creation is not a file write — a folder named `evil.bat`
    // is harmless.
    const res = await mkdirWs(user.id, ws.name, parsed.data.path, ws.rootDir);
    return ok({ dir: res });
  }
  try {
    const res = await createFileWs(user.id, ws.name, parsed.data.path, parsed.data.content ?? "", ws.rootDir);
    return ok({ file: res });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed.";
    if (msg === "Invalid path." || msg.startsWith("Content too large") || msg.startsWith("Refusing to save")) {
      return apiError(msg, 400);
    }
    throw e;
  }
});

export const DELETE = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const limited = await withRateLimit(req, `ws-files-write:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const url = new URL(req.url);
  const rel = url.searchParams.get("path") || "";
  if (!rel) return apiError("Missing path query.", 400);
  if (rel.includes("\u0000")) return apiError("Invalid path.", 400);

  const ws = await resolveWs(user.id);
  try {
    const res = await deletePathWs(user.id, ws.name, rel, ws.rootDir);
    return ok({ deleted: res });
  } catch (e) {
    // Fail-closed guards (sibling-workspace refusal, unverifiable boundary)
    // are client-actionable rejections, not server faults — map them like
    // PUT/POST. Only genuine verification failures stay 500.
    const msg = e instanceof Error ? e.message : "Delete failed.";
    if (
      msg === "Invalid path." ||
      msg === "Cannot delete workspace root." ||
      msg.startsWith("Refusing to delete")
    ) {
      return apiError(msg, 400);
    }
    throw e;
  }
});

import { readdirSync } from "fs";
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
  deniedWriteExtension,
} from "@/lib/workspace";
import { parseJson, apiError, ok, withErrorHandler } from "@/app/api/_lib/helpers";
import { noNulBytes } from "@/lib/validation";

export const dynamic = "force-dynamic";

const writeSchema = z.object({
  path: z.string().trim().min(1).max(300),
  content: z.string().max(1_000_000),
}).refine((d) => noNulBytes(d.content), {
  message: "Content cannot contain NUL bytes",
  path: ["content"],
});

const createSchema = z.object({
  path: z.string().trim().min(1).max(300),
  type: z.enum(["file", "dir"]).default("file"),
  content: z.string().max(1_000_000).optional(),
}).refine((d) => d.content === undefined || noNulBytes(d.content), {
  message: "Content cannot contain NUL bytes",
  path: ["content"],
});

async function resolveWs(userId: string) {
  return (await getActiveWorkspace(userId)) ?? (await ensureDefaultWorkspace(userId));
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

  // Raw binary file read for images and media files in artifacts
  if (url.searchParams.get("raw") === "true") {
    const ws = await resolveWs(user.id);
    const cleanPath = rel;
    const fs = await import("fs/promises");
    const path = await import("path");
    const { existsSync } = await import("fs");
    const { safePath, safePathFromRoot } = await import("@/lib/workspace");

    const { ARTIFACTS_DIR } = await import("@/lib/paths");
    const artifactsUserDir = path.join(ARTIFACTS_DIR, user.id);
    let absPath = safePath(user.id, ws.name, cleanPath, ws.rootDir);
    if (!absPath && path.isAbsolute(cleanPath) && existsSync(cleanPath)) {
      absPath = safePathFromRoot(artifactsUserDir, cleanPath);
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

  const pathModule = await import("path");
  const { statSync, existsSync, readFileSync } = await import("fs");
  const ws = await resolveWs(user.id);

  // Directly read absolute artifact files existing on disk (within workspace or the current user's artifacts)
  const { ARTIFACTS_DIR } = await import("@/lib/paths");
  const artifactsUserDir = pathModule.join(ARTIFACTS_DIR, user.id);
  const { safePathFromRoot } = await import("@/lib/workspace");
  const isAbsExisting = pathModule.isAbsolute(rel) && existsSync(rel);
  const artifactAbs = isAbsExisting ? safePathFromRoot(artifactsUserDir, rel) : null;
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

  const { safePath } = await import("@/lib/workspace");
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
    const targetName = pathModule.basename(requestedRel);
    const matches: string[] = [];
    const walk = (current: string) => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = pathModule.join(current, entry.name);
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
    const isBareFilename = rel === pathModule.basename(rel);
    const isArtifactScoped = pathModule.isAbsolute(rel) && safePathFromRoot(artifactsUserDir, rel) !== null;
    if (isBareFilename || isArtifactScoped) {
      const foundArtifactPath = findBestArtifact(artifactsUserDir, rel);
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

  const body = await parseJson<any>(req);
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid write request.", 400, {
      details: parsed.error.flatten(),
    });
  }

  const ws = await resolveWs(user.id);
  const denied = deniedWriteExtension(parsed.data.path);
  if (denied) {
    return apiError(`Writing files with the "${denied}" extension is not allowed.`, 400);
  }
  const res = await writeFileWs(user.id, ws.name, parsed.data.path, parsed.data.content, ws.rootDir);
  return ok({ file: res });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

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
    // is harmless, so the executable-extension deny-list does not apply.
    const res = await mkdirWs(user.id, ws.name, parsed.data.path, ws.rootDir);
    return ok({ dir: res });
  }
  const denied = deniedWriteExtension(parsed.data.path);
  if (denied) {
    return apiError(`Creating files with the "${denied}" extension is not allowed.`, 400);
  }
  const res = await createFileWs(user.id, ws.name, parsed.data.path, parsed.data.content ?? "", ws.rootDir);
  return ok({ file: res });
});

export const DELETE = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const url = new URL(req.url);
  const rel = url.searchParams.get("path") || "";
  if (!rel) return apiError("Missing path query.", 400);

  const ws = await resolveWs(user.id);
  const res = await deletePathWs(user.id, ws.name, rel, ws.rootDir);
  return ok({ deleted: res });
});

// TODO(experimental/unwired): Kept intentionally — lightweight autosave endpoint
// is implemented and tested but not yet wired to the Monaco editor's debounce
// loop (editor currently uses PUT /api/workspace/file). Retained for future
// real-time autosave; safe to keep.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  writeFileWs,
  deniedWriteExtension,
} from "@/lib/workspace";
import { z } from "zod";
import {
  withErrorHandler,
  parseJson, apiError, unauthorized, ok } from "@/app/api/_lib/helpers";

/**
 * POST /api/workspace/autosave  body { path, content }
 *
 * Lightweight autosave — writes the file as fast as possible with no
 * history, no diff, no audit log. The IDE calls this on a debounce after
 * the user stops typing in the editor (typically every 1–2s).
 *
 * Compared to `PUT /api/workspace/file`:
 *   - No audit log entry (autosaves would flood the audit log; explicit
 *     saves via PUT still audit-log normally).
 *   - No checkpoint / history entry (autosaves aren't user-visible
 *     "save points"; the file just gets written to disk).
 *   - Does NOT emit a synthetic file-watch event — the underlying
 *     `fs.watch` in `src/lib/file-watcher.ts` will fire naturally when
 *     the file changes on disk, which the SSE endpoint forwards to
 *     connected clients. Emitting here would double-fire.
 *   - Higher rate limit (120/min/user vs 60/min for PUT) because autosave
 *     is frequent by design.
 *
 * Security:
 *   - Auth required (401 on no session).
 *   - Path confined via `safePath` inside `writeFileWs` (rejects `..`,
 *     confines to workspace root).
 *   - Content capped at 1 MB (matches `writeFileWs`'s internal cap).
 *   - Path length ≤ 300 chars.
 */
export const dynamic = "force-dynamic";

const autosaveSchema = z.object({
  path: z.string().trim().min(1).max(300),
  content: z.string().max(1_000_000),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  // 120/min/user — autosave fires on a debounce while typing; 2/s sustained
  // is plenty for any realistic editing cadence.
  const limited = await withRateLimit(req, `ws-autosave:${user.id}`, {
    capacity: 120,
    refillPerSec: 120 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (body === null) {
    return apiError("Invalid JSON body.", 400);
  }
  const parsed = autosaveSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, {
      details: parsed.error.flatten(),
    });
  }

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  // Match PUT /api/workspace/file: reject denied executable extensions as a
  // 400 (client-visible validation), not a 500 from writeFileWs.
  const denied = deniedWriteExtension(parsed.data.path);
  if (denied) {
    return apiError(`Writing files with the "${denied}" extension is not allowed.`, 400);
  }

  try {
    // writeFileWs enforces: safePath (no traversal), 1 MB content cap,
    // parent-dir creation, UTF-8 write. Returns { path, bytes }.
    const r = await writeFileWs(user.id, ws.name, parsed.data.path, parsed.data.content, ws.rootDir);
    return ok({ ok: true, path: r.path, bytes: r.bytes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "autosave failed";
    // writeFileWs throws "Invalid path." for traversal attempts and
    // "Content too large (>1MB)." for oversize payloads — both are 400s.
    if (msg === "Invalid path.") return apiError(msg, 400);
    if (msg.startsWith("Content too large")) return apiError(msg, 400);
    return apiError(msg, 500);
  }
});

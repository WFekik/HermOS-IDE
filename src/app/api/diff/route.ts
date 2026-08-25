// TODO(experimental/unwired): Kept intentionally for roadmap — diff preview API is
// not yet called from the UI but provides pure text-diff + workspace-file diff
// for future editor integration (e.g. pre-apply edit preview). Safe to keep; do
// not delete without product decision.
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  readFileWs,
} from "@/lib/workspace";
import { computeDiff, formatUnifiedDiff } from "@/lib/diff";
import {
  withErrorHandler,
  parseJson,
  apiError,
  unauthorized,
  ok,
} from "@/app/api/_lib/helpers";

/**
 * Diff API.
 *
 * Two modes:
 *   POST /api/diff       — diff two arbitrary text blobs.
 *     body: { oldContent: string, newContent: string, path?: string }
 *     → { diff: DiffLine[], unified: string }
 *
 *   GET /api/diff?path=<rel>&newContent=<...>
 *     — diff a workspace file against proposed new content. Reads the file
 *       from the user's active workspace, computes the diff vs `newContent`.
 *       Useful for previewing an edit before applying it.
 *     → same shape as POST.
 *
 * Both require auth + 30/min/user rate limit. Inputs are validated with zod
 * and capped at 1 MB per content blob.
 */

export const dynamic = "force-dynamic";

const MAX_CONTENT = 1_000_000;

const postSchema = z.object({
  oldContent: z.string().max(MAX_CONTENT),
  newContent: z.string().max(MAX_CONTENT),
  path: z.string().trim().max(300).optional(),
});

async function resolveWs(userId: string) {
  return await getActiveWorkspace(userId) ?? await ensureDefaultWorkspace(userId);
}

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `diff:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid diff request.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { oldContent, newContent, path } = parsed.data;
  const diff = computeDiff(oldContent, newContent);
  const unified = formatUnifiedDiff(oldContent, newContent, path);
  return ok({ diff, unified });
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `diff:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const rel = url.searchParams.get("path") || "";
  const newContent = url.searchParams.get("newContent") ?? "";
  if (!rel) return apiError("Missing path query.", 400);
  if (newContent.length > MAX_CONTENT) {
    return apiError("newContent too large (>1MB).", 413);
  }
  const ws = await resolveWs(user.id);
  let oldContent: string;
  try {
    const file = await readFileWs(user.id, ws.name, rel);
    oldContent = file.content;
  } catch (e) {
    return apiError(
      e instanceof Error ? e.message : "Failed to read workspace file.",
      400,
    );
  }
  const diff = computeDiff(oldContent, newContent);
  const unified = formatUnifiedDiff(oldContent, newContent, rel);
  return ok({ diff, unified });
});

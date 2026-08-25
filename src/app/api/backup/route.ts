// TODO(experimental/unwired): Kept intentionally for roadmap — database backup
// streaming endpoint is authenticated + rate-limited and not yet surfaced in the
// UI. Retained as a tested, working recovery path for power users / future
// settings panel. Safe to keep; do not delete without product decision.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db, dbReady, DB_FILE_PATH } from "@/lib/db";
import { withErrorHandler, apiError } from "@/app/api/_lib/helpers";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";

export const dynamic = "force-dynamic";

/**
 * GET /api/backup
 *
 * Streams a consistent copy of the local SQLite database as a downloadable
 * file. Runs `PRAGMA wal_checkpoint(FULL)` first so all committed WAL frames
 * are merged into the main db file before it is read.
 *
 * Auth required; rate limited at 10/min/user (backup is heavy).
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `backup:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  await dbReady;

  if (!DB_FILE_PATH) {
    return apiError("Backup is only supported for local SQLite databases.", 400);
  }
  if (!existsSync(DB_FILE_PATH)) {
    return apiError("Database file not found.", 404);
  }

  // Checkpoint WAL so the streamed file contains all committed data. Runs
  // before the file is opened for streaming; failure is non-fatal (we stream
  // the main file as-is — WAL remains authoritative for readers).
  try {
    await db.$executeRawUnsafe("PRAGMA wal_checkpoint(FULL);");
  } catch (err) {
    console.warn("[backup] wal_checkpoint failed (streaming as-is):", err);
  }

  const stat = statSync(DB_FILE_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const nodeStream = createReadStream(DB_FILE_PATH);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="hermos-backup-${stamp}.db"`,
      "Content-Length": String(stat.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
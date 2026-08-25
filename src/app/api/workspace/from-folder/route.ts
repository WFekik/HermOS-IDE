import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import { parseJson, apiError, ok, enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { db } from "@/lib/db";
import { invalidateRootDirCache } from "@/lib/workspace";
import { statSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const fromFolderSchema = z.object({
  path: z.string().trim().min(1).max(2048),
});

/**
 * POST /api/workspace/from-folder
 *
 * Opens a native folder as a workspace. The folder path is stored directly
 * as the workspace's rootDir instead of creating a subdirectory.
 *
 * Local-only: the desktop app runs on the user's own machine, so the picked
 * path is trusted — but still validated (exists, is a directory, not a
 * filesystem root) so a bad pick can never poison the workspace table.
 *
 * Body: { path: string }
 * Returns: { workspace: { id, name, isActive } }
 */
export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return apiError("Unauthorized", 401);
  }

  const limited = await withRateLimit(req, `ws-from-folder:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = fromFolderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  // Normalize (resolve `..`, trailing separators, etc.) so the stored rootDir
  // is canonical — keeps the workspace dedupe check and every downstream
  // containment check consistent.
  const folderPath = path.resolve(parsed.data.path.trim());

  // Must exist AND be a directory — a file as rootDir breaks the workspace
  // tree/file ops downstream.
  let folderStat;
  try {
    folderStat = statSync(folderPath);
  } catch {
    return apiError("Folder does not exist.", 400);
  }
  if (!folderStat.isDirectory()) {
    return apiError("Not a directory.", 400);
  }

  // Reject filesystem roots (`C:\`, `/`, UNC share roots): opening a whole
  // volume as a workspace would hand the file API the entire disk.
  const parsedPath = path.parse(folderPath);
  if (parsedPath.root === folderPath) {
    return apiError("A filesystem root cannot be opened as a workspace.", 400);
  }

  const folderName = path.basename(folderPath) || "workspace";

  const existing = await db.workspace.findFirst({
    where: { userId: user.id, rootDir: folderPath },
  });

  if (existing) {
    // Already exists - atomically switch active workspace in a transaction
    const [, updated] = await db.$transaction([
      db.workspace.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false },
      }),
      db.workspace.update({
        where: { id: existing.id },
        data: { isActive: true, updatedAt: new Date() },
      }),
      db.user.update({
        where: { id: user.id },
        data: { workspaceName: existing.name },
      }),
    ]);

    invalidateRootDirCache(user.id, updated.name);
    return ok({ workspace: { id: updated.id, name: updated.name, isActive: true } });
  }

  const baseName = folderName.length > 64 ? folderName.substring(0, 64) : folderName;

  // Deduplicate name against existing user workspaces
  const userWorkspaces = await db.workspace.findMany({
    where: { userId: user.id },
    select: { name: true },
  });
  const existingNames = new Set(userWorkspaces.map((w) => w.name));

  let candidateName = baseName;
  let counter = 1;
  while (existingNames.has(candidateName)) {
    const suffix = ` (${counter})`;
    const maxBaseLen = Math.max(1, 64 - suffix.length);
    const truncatedBase = baseName.length > maxBaseLen ? baseName.substring(0, maxBaseLen) : baseName;
    candidateName = `${truncatedBase}${suffix}`;
    counter++;
  }

  let ws;
  let finalName = candidateName;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = await db.$transaction([
        db.workspace.updateMany({
          where: { userId: user.id, isActive: true },
          data: { isActive: false },
        }),
        db.workspace.create({
          data: {
            userId: user.id,
            name: finalName,
            rootDir: folderPath,
            isActive: true,
          },
        }),
        db.user.update({
          where: { id: user.id },
          data: { workspaceName: finalName },
        }),
      ]);
      ws = result[1];
      break;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "P2002" && attempt < 9) {
        counter++;
        const suffix = ` (${counter})`;
        const maxBaseLen = Math.max(1, 64 - suffix.length);
        const truncatedBase = baseName.length > maxBaseLen ? baseName.substring(0, maxBaseLen) : baseName;
        finalName = `${truncatedBase}${suffix}`;
        continue;
      }
      throw err;
    }
  }

  if (!ws) {
    return apiError("Failed to create workspace.", 500);
  }

  invalidateRootDirCache(user.id, ws.name);
  return ok({ workspace: { id: ws.id, name: ws.name, isActive: true } });
}
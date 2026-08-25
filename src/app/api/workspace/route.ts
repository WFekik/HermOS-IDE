import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import {
  getActiveWorkspace,
  openWorkspace,
  closeWorkspace,
  renameWorkspace,
  deleteWorkspace,
  listWorkspaces,
  listUserWorkspaces,
  ensureDefaultWorkspace,
  resolveWorkspace,
  switchWorkspace,
} from "@/lib/workspace";
import { parseJson, apiError, unauthorized, ok, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const openSchema = z.object({
  action: z.enum(["open", "close", "list", "rename", "delete", "root", "switch"]).default("open"),
  name: z.string().trim().min(1).max(64).optional(),
  workspaceId: z.string().trim().min(1).max(64).optional(),
  newName: z.string().trim().min(1).max(64).optional(),
});

/**
 * GET /api/workspace
 *
 * Returns the user's active workspace plus the full list of their workspaces
 * (newest-first by `updatedAt`) so the frontend can render a workspace
 * switcher in the top bar without a second round-trip.
 *
 * Shape:
 *   {
 *     workspace: { id, name, isActive },         // active workspace (auto-
 *                                                  // provisioned if the user
 *                                                  // had none — preserves the
 *                                                  // pre-22-B behaviour)
 *     workspaces: Array<WorkspaceListItem>       // all the user's workspaces,
 *                                                  // newest-first
 *   }
 *
 * Backwards-compat: the original GET auto-provisioned a default workspace via
 * `ensureDefaultWorkspace` when the user had none. We preserve that so any
 * existing caller (e.g. the IDE shell on first load) still sees a workspace
 * object instead of null. The new `workspaces` array is additive — existing
 * consumers ignore unknown keys.
 *
 * Rate-limited at 60/min/user (terminal bucket) — the same as the prior
 * implementation, since this is the most-called workspace endpoint.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-files:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  // Fetch the active workspace + the full list in parallel — these are two
  // independent reads against the same table, so a Promise.all saves a
  // round-trip vs. sequencing them.
  const [active, all] = await Promise.all([
    getActiveWorkspace(user.id),
    listUserWorkspaces(user.id),
  ]);

  const ws = active ?? await ensureDefaultWorkspace(user.id);

  // If the user still has no workspace (ensureDefaultWorkspace returns null),
  // return null — the frontend handles a missing workspace gracefully.
  return ok({
    workspace: ws ? { id: ws.id, name: ws.name, isActive: true, rootDir: ws.rootDir } : null,
    workspaces: ws ? all : all, // all already includes rootDir from listUserWorkspaces
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-files:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });

  const { action, name, workspaceId, newName } = parsed.data;
  if (action === "list") {
    const list = await listWorkspaces(user.id);
    return ok({ workspaces: list });
  }
  if (action === "close") {
    await closeWorkspace(user.id);
    return ok({ ok: true });
  }
  if (action === "rename") {
    if (!workspaceId) return apiError("workspaceId is required.", 400);
    if (!newName) return apiError("newName is required.", 400);
    try {
      const ws = await renameWorkspace(user.id, workspaceId, newName);
      return ok({ workspace: { id: ws.id, name: ws.name, isActive: ws.isActive, rootDir: ws.rootDir } });
    } catch (e) {
      return apiError(e instanceof Error ? e.message : "Rename failed", 400);
    }
  }
  if (action === "delete") {
    if (!workspaceId) return apiError("workspaceId is required.", 400);
    try {
      await deleteWorkspace(user.id, workspaceId);
      return ok({ ok: true });
    } catch (e) {
      return apiError(e instanceof Error ? e.message : "Delete failed", 400);
    }
  }
  if (action === "root") {
    if (!workspaceId) return apiError("workspaceId is required.", 400);
    const ws = await resolveWorkspace(user.id, workspaceId);
    if (!ws) return apiError("Workspace not found", 404);
    return ok({ rootDir: ws.rootDir });
  }
  if (action === "switch") {
    if (!workspaceId) return apiError("workspaceId is required.", 400);
    const ws = await switchWorkspace(user.id, workspaceId);
    if (!ws) return apiError("Workspace not found", 404);
    return ok({ workspace: { id: ws.id, name: ws.name, isActive: true, rootDir: ws.rootDir } });
  }
  if (!name) return apiError("Workspace name is required.", 400);
  const ws = await openWorkspace(user.id, name);
  return ok({ workspace: { id: ws.id, name: ws.name, isActive: true, rootDir: ws.rootDir } });
}

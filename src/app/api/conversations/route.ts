import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { createConversationSchema } from "@/lib/validation";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "@/lib/ai/providers";
import {
  withErrorHandler,
  parseJson,
  toConversationDTO,
  ok,
  apiError,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  const limitParam = searchParams.get("limit");
  const offsetParam = searchParams.get("offset");

  const limit = Math.min(Math.max(1, parseInt(limitParam ?? "50", 10) || 50), 200);
  const skip = Math.max(0, parseInt(offsetParam ?? "0", 10) || 0);

  const rows = await db.conversation.findMany({
    where: { userId: user.id, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: limit,
    skip,
  });
  return ok({ conversations: rows.map(toConversationDTO) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `conv-create:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (limited) return limited;
  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid conversation payload.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { title, provider, model, mode, systemPrompt, pinned, workspaceId } = parsed.data;
  let finalWorkspaceId = workspaceId ?? null;
  if (finalWorkspaceId) {
    const ws = await db.workspace.findFirst({
      where: { id: finalWorkspaceId, userId: user.id },
    });
    if (!ws) return apiError("Workspace not found.", 404);
  }
  if (!finalWorkspaceId) {
    const activeWs = await db.workspace.findFirst({
      where: { userId: user.id, isActive: true },
    });
    if (activeWs) {
      finalWorkspaceId = activeWs.id;
    }
  }
  const created = await db.conversation.create({
    data: {
      userId: user.id,
      title: title ?? "New conversation",
      provider: provider ?? DEFAULT_PROVIDER,
      model: model ?? DEFAULT_MODEL,
      mode: mode ?? "agent",
      systemPrompt: systemPrompt ?? null,
      pinned: pinned ?? false,
      workspaceId: finalWorkspaceId,
    },
  });
  return ok({ conversation: toConversationDTO(created) });
});

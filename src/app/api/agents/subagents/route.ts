import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  createSubagent,
  getSubagents,
  type Subagent,
} from "@/lib/ai/subagents";
import {
  withErrorHandler,
  parseJson,
  apiError,
  unauthorized,
  ok,
  audit,
} from "@/app/api/_lib/helpers";

/**
 * Subagent management API.
 *
 *   GET  /api/agents/subagents?conversationId=<id>
 *        → { subagents: Subagent[] }   (newest first, this user only)
 *
 *   POST /api/agents/subagents   body { conversationId, name, task, systemPrompt? }
 *        → { subagent }   (created with status="pending"; background run kicked off)
 */

export const dynamic = "force-dynamic";

const createSchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  task: z.string().trim().min(1).max(16_000),
  systemPrompt: z.string().trim().max(16_000).optional(),
});

async function verifyConversationOwnership(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  return !!conv && conv.userId === userId;
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `subagents:${user.id}`, {
    capacity: 60,
    refillPerSec: 1,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") || "";
  if (!conversationId) return apiError("Missing conversationId query.", 400);

  const owned = await verifyConversationOwnership(user.id, conversationId);
  if (!owned) return apiError("Conversation not found.", 404);

  const subagents = getSubagents(user.id, conversationId);
  return ok({ subagents: subagents.map(toDTO) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `subagents:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }
  const d = parsed.data;

  const owned = await verifyConversationOwnership(user.id, d.conversationId);
  if (!owned) return apiError("Conversation not found.", 404);

  const sa = createSubagent(user.id, d.conversationId, {
    name: d.name,
    task: d.task,
    systemPrompt: d.systemPrompt,
  });

  try {
    await audit(
      user.id,
      "subagent_create",
      JSON.stringify({
        conversationId: d.conversationId,
        id: sa.id,
        name: sa.name,
      }),
    );
  } catch {
    /* ignore audit failures */
  }

  return ok({ subagent: toDTO(sa) });
});

/** Strip internal fields and shape the wire DTO. */
function toDTO(sa: Subagent): Subagent {
  return {
    id: sa.id,
    conversationId: sa.conversationId,
    userId: sa.userId,
    name: sa.name,
    task: sa.task,
    systemPrompt: sa.systemPrompt,
    status: sa.status,
    result: sa.result,
    error: sa.error,
    createdAt: sa.createdAt,
    completedAt: sa.completedAt,
  };
}

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { z } from "zod";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";

import { db } from "@/lib/db";
import {
  parseJson,
  toConversationDTO,
  ok,
  apiError,
  notFound,
  audit,
  withErrorHandler,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const branchSchema = z.object({
  // Branch AT this message: messages up to and including it are cloned.
  // Omitted → clone the full transcript.
  messageId: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().max(200).optional(),
});

/**
 * POST /api/conversations/[id]/branch
 *
 * Clones a conversation (row + message history) into a NEW conversation in a
 * single transaction, so branching never loses history. Returns the new
 * conversation id; the client re-points its UI at it and refreshes.
 *
 * body: { messageId?: string, title?: string }
 */
export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-branch:${user.id}`, {
      capacity: 10,
      refillPerSec: 10 / 60,
    });
    if (limited) return limited;

    const { id } = await params;
    const source = await db.conversation.findUnique({ where: { id } });
    if (!source || source.userId !== user.id) {
      return notFound("Conversation not found");
    }

    const body = await parseJson<unknown>(req);
    if (!body) return apiError("Invalid JSON body.", 400);
    const parsed = branchSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid branch payload.", 400, {
        details: parsed.error.flatten(),
      });
    }

    // Deterministic ordering (createdAt collides under queue rotations) so
    // the prefix cut matches exactly what the user saw when they branched.
    const msgsInOrder = await db.message.findMany({
      where: { conversationId: id },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    let copyIds: string[] = msgsInOrder.map((m) => m.id);
    if (parsed.data.messageId) {
      const idx = copyIds.indexOf(parsed.data.messageId);
      if (idx === -1) {
        return apiError("Message not found in conversation.", 404);
      }
      copyIds = copyIds.slice(0, idx + 1);
    }

    const created = await db.$transaction(async (tx) => {
      const conv = await tx.conversation.create({
        data: {
          userId: source.userId,
          title: parsed.data.title ?? `${source.title} (branch)`,
          provider: source.provider,
          model: source.model,
          systemPrompt: source.systemPrompt,
          mode: source.mode,
          pinned: false,
          workspaceId: source.workspaceId,
        },
      });
      if (copyIds.length > 0) {
        const rows = await tx.message.findMany({
          where: { id: { in: copyIds }, conversationId: id },
        });
        // Re-order rows to the deterministic sequence; fresh cuids avoid
        // id collisions and `createdAt` is preserved so chronology survives.
        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered = copyIds
          .map((mid) => byId.get(mid))
          .filter((r): r is NonNullable<typeof r> => !!r);
        await tx.message.createMany({
          data: ordered.map((r) => ({
            conversationId: conv.id,
            role: r.role,
            content: r.content,
            thinking: r.thinking,
            toolCalls: r.toolCalls,
            toolCallId: r.toolCallId,
            model: r.model,
            provider: r.provider,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            promptTokens: r.promptTokens,
            cacheWrites: r.cacheWrites,
            cacheReads: r.cacheReads,
            latencyMs: r.latencyMs,
            segments: r.segments,
            attachments: r.attachments,
            createdAt: r.createdAt,
          })),
        });
      }
      return conv;
    });

    await audit(
      user.id,
      "conversation_branch",
      JSON.stringify({
        sourceId: id,
        newId: created.id,
        messageId: parsed.data.messageId ?? null,
        count: copyIds.length,
      }).slice(0, 2000),
      getClientIp(req),
    );

    return ok({
      conversation: toConversationDTO(created),
      branchedMessageCount: copyIds.length,
    });
  },
);

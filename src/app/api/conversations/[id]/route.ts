import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { patchConversationSchema } from "@/lib/validation";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { clearConversationCache } from "@/lib/ai/executor";
import { clearConversationDelivery } from "@/lib/ai/subagent-delivery";
import { abortAgentStream } from "@/lib/agent-abort";
import { cancelPendingForConversation } from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation } from "@/lib/question-prompt";
import { stopRunningCommand } from "@/lib/workspace";
import { rmSync } from "fs";
import path from "path";
import { CHECKPOINTS_DIR } from "@/lib/paths";
import { deleteAttachmentFiles } from "@/lib/provision-db";
import {
  withErrorHandler,
  parseJson,
  toConversationDTO,
  ok,
  apiError,
  notFound,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const row = await db.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!row || row.userId !== user.id) return notFound("Conversation not found");
    return ok({ conversation: toConversationDTO(row) });
  },
);

export const PATCH = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-patch:${user.id}`, { capacity: 60, refillPerSec: 60 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const body = await parseJson<unknown>(req);
    if (!body) return apiError("Invalid JSON body.", 400);
    const parsed = patchConversationSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid conversation patch.", 400, {
        details: parsed.error.flatten(),
      });
    }
    const existing = await db.conversation.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return notFound("Conversation not found");
    }
    if (parsed.data.workspaceId !== undefined && parsed.data.workspaceId !== null) {
      const ws = await db.workspace.findFirst({
        where: { id: parsed.data.workspaceId, userId: user.id },
      });
      if (!ws) return notFound("Workspace not found");
    }
    const updated = await db.conversation.update({
      where: { id },
      data: { ...parsed.data },
    });
    return ok({ conversation: toConversationDTO(updated) });
  },
);

export const DELETE = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-delete:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const existing = await db.conversation.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return notFound("Conversation not found");
    }
    // Best-effort physical cleanup: remove on-disk artifacts owned by this
    // conversation (checkpoint snapshots + uploaded attachment files). Fetch
    // the attachment paths BEFORE deleting the conversation — the DB rows
    // cascade on delete, so a post-delete query would always be empty and
    // leave the files orphaned on disk.
    // Abort any running agent stream for this conversation before deleting
    // to prevent zombie token burn. Mirrors /api/agents/chat/stop.
    try {
      abortAgentStream(id);
    } catch {}
    try {
      cancelPendingForConversation(id);
    } catch {}
    try {
      cancelPendingQuestionsForConversation(id);
    } catch {}
    try {
      stopRunningCommand(user.id, id);
    } catch {}

    const attachments = await db.attachment.findMany({
      where: { conversationId: id },
      select: { path: true },
    });
    await db.conversation.delete({ where: { id } });
    clearConversationCache(id);
    clearConversationDelivery(user.id, id);
    try {
      rmSync(path.join(CHECKPOINTS_DIR, user.id, id), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    // Unlink uploaded files (realpath-containment-checked inside uploads root).
    deleteAttachmentFiles(attachments.map((a) => a.path));
    return ok({ ok: true });
  },
);

// POST /api/conversations/[id]/undo-compact — remove the latest compaction summary
export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-undo-compact:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const conversation = await db.conversation.findUnique({ where: { id } });
    if (!conversation || conversation.userId !== user.id) {
      return notFound("Conversation not found");
    }

    // Find the most recent compaction summary message (user role with compacted marker)
    const compactSummary = await db.message.findFirst({
      where: {
        conversationId: id,
        role: "user",
        content: { startsWith: "<context_summary compacted=\"true\">" },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!compactSummary) {
      return apiError("No compaction to undo.", 400);
    }

    await db.message.delete({ where: { id: compactSummary.id } });
    return ok({ ok: true, message: "Compaction undone" });
  },
);

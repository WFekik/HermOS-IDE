import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, parseJson, apiError, notFound, ok, audit } from "@/app/api/_lib/helpers";
import {
  loadTodos,
  saveTodos,
  isConversationOwner,
} from "@/lib/todos-service";

/**
 * Per-conversation todo item PATCH/DELETE.
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1000;

const patchSchema = z.object({
  completed: z.boolean().optional(),
  text: z.string().trim().min(1).max(MAX_TEXT).optional(),
});

// PATCH /api/todos/[id]?conversationId=<id> body { completed?, text? }
export const PATCH = withErrorHandler(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `todos:${user.id}`, {
      capacity: 60,
      refillPerSec: 60 / 60,
    });
    if (limited) return limited;

    const { id } = await params;
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!conversationId) return apiError("Missing conversationId query.", 400);

    const owned = await isConversationOwner(user.id, conversationId);
    if (!owned) return notFound("Conversation not found");

    const body = await parseJson<unknown>(req);
    if (body === null) return apiError("Invalid JSON body.", 400);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
    }
    if (parsed.data.completed === undefined && parsed.data.text === undefined) {
      return apiError("Nothing to update (provide `completed` and/or `text`).", 400);
    }

    const current = await loadTodos(user.id, conversationId);
    const idx = current.findIndex((t) => t.id === id);
    if (idx === -1) return notFound("Todo not found");

    const item = {
      ...current[idx],
      completed: parsed.data.completed ?? current[idx].completed,
      text: parsed.data.text !== undefined ? parsed.data.text : current[idx].text,
    };
    current[idx] = item;
    await saveTodos(user.id, conversationId, current);

    try {
      await audit(
        user.id,
        "todo_update",
        JSON.stringify({ conversationId, id, completed: item.completed }),
      );
    } catch {
      /* ignore */
    }
    return ok({ todo: item });
  },
);

// DELETE /api/todos/[id]?conversationId=<id>
export const DELETE = withErrorHandler(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `todos:${user.id}`, {
      capacity: 60,
      refillPerSec: 60 / 60,
    });
    if (limited) return limited;

    const { id } = await params;
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!conversationId) return apiError("Missing conversationId query.", 400);

    const owned = await isConversationOwner(user.id, conversationId);
    if (!owned) return notFound("Conversation not found");

    const current = await loadTodos(user.id, conversationId);
    const idx = current.findIndex((t) => t.id === id);
    if (idx === -1) return notFound("Todo not found");

    current.splice(idx, 1);
    await saveTodos(user.id, conversationId, current);

    try {
      await audit(user.id, "todo_delete", JSON.stringify({ conversationId, id }));
    } catch {
      /* ignore */
    }
    return ok({ ok: true });
  },
);

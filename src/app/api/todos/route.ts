import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, parseJson, apiError, ok, audit } from "@/app/api/_lib/helpers";
import {
  TodoItem,
  MAX_TODOS,
  loadTodos,
  saveTodos,
  isConversationOwner,
} from "@/lib/todos-service";

/**
 * Per-conversation todo list API.
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1000;

const createSchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(MAX_TEXT),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `todos:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") || "";
  if (!conversationId) return apiError("Missing conversationId query.", 400);

  const owned = await isConversationOwner(user.id, conversationId);
  if (!owned) return apiError("Conversation not found.", 404);

  const todos = await loadTodos(user.id, conversationId);
  return ok({ todos });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `todos:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  const owned = await isConversationOwner(user.id, parsed.data.conversationId);
  if (!owned) return apiError("Conversation not found.", 404);

  const current = await loadTodos(user.id, parsed.data.conversationId);
  if (current.length >= MAX_TODOS) {
    return apiError(`Todo list is full (max ${MAX_TODOS}).`, 400);
  }

  const newTodo: TodoItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: parsed.data.text,
    completed: false,
    createdAt: new Date().toISOString(),
  };

  current.push(newTodo);
  await saveTodos(user.id, parsed.data.conversationId, current);

  try {
    await audit(
      user.id,
      "todo_create",
      JSON.stringify({ conversationId: parsed.data.conversationId, id: newTodo.id }),
    );
  } catch {
    /* ignore */
  }

  return ok({ todo: newTodo });
});

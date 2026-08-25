import { db } from "@/lib/db";

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string | null;
  priority?: "low" | "medium" | "high";
  activeStep?: string | null;
}

export const MAX_TODOS = 50;

export function todosPluginName(conversationId: string): string {
  return `__todo_list_${conversationId}__`;
}

/** Check whether a conversation belongs to a user. */
export async function isConversationOwner(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  if (!conversationId) return false;
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  return !!conv && conv.userId === userId;
}

/** Load the todos array for a conversation. Returns [] if none. */
export async function loadTodos(userId: string, conversationId: string): Promise<TodoItem[]> {
  const row = await db.plugin.findFirst({
    where: { userId, name: todosPluginName(conversationId) },
  });
  if (!row || !row.config) return [];
  try {
    const parsed = JSON.parse(row.config);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is TodoItem =>
          t &&
          typeof t === "object" &&
          typeof t.id === "string" &&
          typeof t.text === "string" &&
          typeof t.completed === "boolean" &&
          typeof t.createdAt === "string",
      )
      .slice(0, MAX_TODOS);
  } catch {
    return [];
  }
}

/** Persist the todos array for a conversation. */
export async function saveTodos(
  userId: string,
  conversationId: string,
  todos: TodoItem[],
): Promise<void> {
  const json = JSON.stringify(todos.slice(0, MAX_TODOS));
  const name = todosPluginName(conversationId);
  await db.plugin.upsert({
    where: { userId_name: { userId, name } },
    update: { config: json },
    create: {
      userId,
      name,
      description: "Todo list (auto-managed)",
      type: "plugin",
      source: "system",
      enabled: true,
      config: json,
    },
  });
}

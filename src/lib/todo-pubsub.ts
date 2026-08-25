/**
 * In-process pub/sub for real-time todo updates.
 */

export interface AgentTodoLite {
  id: string;
  content: string;
  status: string;
  priority: string;
}

interface Subscription {
  listener: (todos: AgentTodoLite[]) => void;
}

const channels = new Map<string, Set<Subscription>>();

function key(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** Deliver to local listeners; one bad listener never breaks the others. */
function deliver(userId: string, conversationId: string, todos: AgentTodoLite[]): void {
  const set = channels.get(key(userId, conversationId));
  if (!set) return;
  for (const sub of set) {
    try {
      sub.listener(todos);
    } catch {
      // ignore — single bad listener shouldn't kill the broadcast
    }
  }
}

/**
 * Broadcast a new full todo list. Called from the agent's
 * `todo_write` tool implementation (and from any code that mutates
 * the underlying list).
 *
 * Listener failure is swallowed; one bad subscriber should never
 * break the others.
 */
export function publishTodos(
  userId: string,
  conversationId: string,
  todos: AgentTodoLite[],
): void {
  deliver(userId, conversationId, todos);
}

/**
 * Subscribe to updates. The listener is called with the full new
 * array each time `publishTodos` is invoked for the same
 * user/conversation pair.
 *
 * Returns an unsubscribe function. Always call it on cleanup
 * (component unmount, conversation switch, SSE disconnect).
 */
export function subscribeTodoUpdates(
  userId: string,
  conversationId: string,
  listener: (todos: AgentTodoLite[]) => void,
): () => void {
  const k = key(userId, conversationId);
  const set = channels.get(k) ?? new Set<Subscription>();
  const sub: Subscription = { listener };
  set.add(sub);
  channels.set(k, set);
  return () => {
    const cur = channels.get(k);
    if (!cur) return;
    cur.delete(sub);
    if (cur.size === 0) channels.delete(k);
  };
}

export async function loadAgentTodosForConversation(
  userId: string,
  conversationId: string,
): Promise<AgentTodoLite[]> {
  const { getTodos } = await import("@/lib/ai/tools");
  const list = await getTodos(userId, conversationId);
  return list.map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    priority: t.priority ?? "medium",
  }));
}

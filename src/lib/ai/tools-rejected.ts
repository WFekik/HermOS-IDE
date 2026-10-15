/**
 * Per-conversation tools-rejected cache — extracted from executor.ts with no
 * behavior change. Tracks conversations where the provider rejected tool
 * definitions so the loop permanently disables native tools and switches to
 * text-fallback prompts. Keys are compound `conv:provider:model` so switching
 * models/providers doesn't stay stuck; bare checks match any compound key.
 */

function toolsRejectedKey(convId: string, provider?: string, model?: string): string {
  return `${convId}:${provider || ""}:${model || ""}`;
}

const toolsRejectedCache = new Map<string, boolean>();
const TOOLS_REJECTED_CACHE_MAX = 500;

export function setToolsRejected(convId: string, provider?: string, model?: string): void {
  if (toolsRejectedCache.size >= TOOLS_REJECTED_CACHE_MAX) {
    const key = toolsRejectedCache.keys().next();
    if (!key.done) toolsRejectedCache.delete(key.value);
  }
  const compoundKey = toolsRejectedKey(convId, provider, model);
  toolsRejectedCache.set(compoundKey, true);
}

export function isToolsRejected(convId: string, provider?: string, model?: string): boolean {
  if (provider || model) {
    return toolsRejectedCache.has(toolsRejectedKey(convId, provider, model));
  }
  // Bare check: true if ANY compound key exists for this conversation
  // (a bare key is never written — checking it directly is always false).
  const prefix = `${convId}:`;
  for (const key of toolsRejectedCache.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** Clear the tools-rejected flag for a conversation (read tracker is cleared by the caller in executor.ts). */
export function clearToolsRejectedCache(conversationId: string): void {
  const prefix = `${conversationId}:`;
  for (const key of Array.from(toolsRejectedCache.keys())) {
    if (key === conversationId || key.startsWith(prefix)) {
      toolsRejectedCache.delete(key);
    }
  }
}

/** Test hook: reset the cache. */
export function __resetToolsRejectedForTests(): void {
  toolsRejectedCache.clear();
}

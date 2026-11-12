/**
 * Display helper for conversation titles. Untitled conversations are stored
 * with the legacy English default "New conversation" (creation routes,
 * pending placeholders, and the title-generation gate in
 * generate-title/route.ts all depend on that exact value) — so translate at
 * the display layer instead of migrating stored data.
 */
export const UNTITLED_CONVERSATION_TITLE = "New conversation";

export function displayConversationTitle(
  title: string | null | undefined,
  translate: (key: string) => string,
): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === UNTITLED_CONVERSATION_TITLE.toLowerCase()) {
    return translate("new_conversation");
  }
  return title as string;
}

/**
 * Deterministic heuristic title extracted from the first user message.
 * Provides instant fallback titles when LLM title generation is skipped or fails.
 */
export function cleanHeuristicTitle(raw: string): string {
  if (!raw || typeof raw !== "string") return "Chat";
  let text = raw
    .replace(/<context_summary[\s\S]*?<\/context_summary>/gi, "")
    .replace(/<subagent_report[\s\S]*?<\/subagent_report>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();

  text = text.replace(/^\/[a-zA-Z0-9_-]+\s+/, "");
  text = text.replace(/@[a-zA-Z0-9_./\\:-]+/g, "");
  text = text.trim();

  text = text.replace(/^(hey|hi|hello|greetings)\s+(there\s+)?(bot|hermos|assistant)?[,.!]?\s*/i, "");
  text = text.replace(/^(can|could|would)\s+you\s+(please\s+)?(help\s+me\s+(with|to\s+)?|show\s+me\s+|tell\s+me\s+)?/i, "");
  text = text.replace(/^(please\s+)?(help\s+me\s+(with|to\s+)?)/i, "");
  text = text.replace(/^(now\s+)?(i\s+wanna\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|i'd\s+like\s+to\s+|how\s+do\s+i\s+|how\s+to\s+|how\s+can\s+i\s+)/i, "");

  text = text.trim();
  if (!text) return "Chat";

  const firstLine = text.split(/[\r\n]|\.(?:\s+|$)|[?!](?:\s+|$)/)[0].trim() || text;
  const words = firstLine
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}#+]+|[^\p{L}\p{N}#+]+$/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "Chat";

  const picked: string[] = [];
  let length = 0;
  for (const w of words) {
    if (picked.length >= 5 || (length + w.length > 36 && picked.length >= 2)) break;
    picked.push(w);
    length += w.length + 1;
  }

  while (
    picked.length > 2 &&
    /^(in|on|at|for|with|and|or|the|a|an|to|of|when|is|are|that|this|if|then|from|by|as)$/i.test(picked[picked.length - 1])
  ) {
    picked.pop();
  }

  const title = picked
    .map((w) => {
      if (/[A-Z]/.test(w.slice(1))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");

  return title.slice(0, 48).trim() || "Chat";
}

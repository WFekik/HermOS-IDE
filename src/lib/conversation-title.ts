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
  if (!trimmed || trimmed === UNTITLED_CONVERSATION_TITLE) {
    return translate("new_conversation");
  }
  return title as string;
}

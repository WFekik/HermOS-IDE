/** Pre-flight secret redaction for message history and system prompts sent to LLMs. */
import { scrubSensitiveSecrets } from "@/lib/sanitize-content";
import {
  DEFAULT_SECURITY_SETTINGS,
  type SecuritySettings,
} from "@/lib/security-types";

/** The minimal structural slice of an agent history row that can carry secrets. */
export interface ScrubMessageLike {
  content?: string | null;
  thinking?: string | null;
}

/** Redact a single string according to security settings; preserves null/undefined. */
export function scrubString(
  value: string | null | undefined,
  settings: SecuritySettings = DEFAULT_SECURITY_SETTINGS,
): string | null | undefined {
  if (!value || !settings.autoScrubSecrets) return value;
  return scrubSensitiveSecrets(value, settings.customRedactionRegex);
}

/**
 * Redact message history rows for wire transmission. Returns original reference
 * if scrubbing is disabled or no changes occurred.
 */
export function scrubHistoryForWire<T extends ScrubMessageLike>(
  history: T[],
  settings: SecuritySettings = DEFAULT_SECURITY_SETTINGS,
): T[] {
  if (!settings.autoScrubSecrets || !Array.isArray(history) || history.length === 0) {
    return history;
  }
  let anyChanged = false;
  const next = history.map((row) => {
    const content = row.content == null ? row.content : scrubString(row.content, settings);
    const thinking = row.thinking == null ? row.thinking : scrubString(row.thinking, settings);
    if (content === row.content && thinking === row.thinking) return row;
    anyChanged = true;
    return { ...row, content, thinking };
  });
  return anyChanged ? next : history;
}

/** Redact a single free-form prompt string (e.g. system or compaction prompt). */
export function scrubPromptString(
  prompt: string | null | undefined,
  settings: SecuritySettings = DEFAULT_SECURITY_SETTINGS,
): string | null | undefined {
  return scrubString(prompt, settings);
}
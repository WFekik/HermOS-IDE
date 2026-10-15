import { z } from "zod";
import { isValidRedactionRegex } from "@/lib/security-types";

/**
 * Settings manifest — validation only, never silent coercion.
 * Invalid values are rejected by the caller (setter returns false / keeps
 * current state) so misconfigurations stay visible instead of being
 * silently clamped into something the user didn't choose.
 */

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;
export const FONT_SIZE_DEFAULT = 15;

export const fontSizeSchema = z.number().int().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX);

/** True when the value is an in-range font size. No coercion. */
export function isValidFontSize(n: unknown): n is number {
  return fontSizeSchema.safeParse(n).success;
}

export const contextConfigSchema = z.object({
  pruneProtectTokens: z.number().int().min(1000).max(500000),
  compactionBuffer: z.number().int().min(1000).max(200000),
  outputTokenCap: z.number().int().min(1000).max(500000),
  tailTurns: z.number().int().min(1).max(10),
});

export type ContextConfig = z.infer<typeof contextConfigSchema>;

/** True when every present known key is in range. Unknown keys are stripped
 * (forward-compat) — only known keys participate in validation. */
export function sanitizeContextPatch(
  input: Partial<ContextConfig>,
): Partial<ContextConfig> | null {
  if (typeof input !== "object" || input === null) return null;
  const parsed = contextConfigSchema.partial().safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

/** True when every present known key is in range (unknown keys stripped). */
export function isValidContextPatch(input: Partial<ContextConfig>): boolean {
  return sanitizeContextPatch(input) !== null;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export function isValidHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/** True when every hex-looking value in the patch is a valid #rrggbb. Non-strings pass through. */
export function isValidThemePatch(patch: Record<string, unknown>): boolean {
  for (const v of Object.values(patch)) {
    if (v === undefined) continue;
    if (typeof v === "string" && v.startsWith("#") && !isValidHex(v)) return false;
  }
  return true;
}

export { isValidRedactionRegex };

/**
 * Quota-aware localStorage write. Returns false on failure (caller keeps the
 * in-memory value so the UI stays correct). Never throws — but never silent
 * either (warns with the key).
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    if (typeof window === "undefined") return true;
    window.localStorage.setItem(key, value);
    return true;
  } catch (e) {
    const name = e instanceof Error ? e.name : String(e);
    console.warn(`[settings] localStorage write failed for ${key} (${name}) — keeping in-memory value`);
    return false;
  }
}

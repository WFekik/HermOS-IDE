/**
 * Shared, dependency-free types for HermOS security settings, safe for
 * both client and server imports without coupling to DB or AI libraries.
 */
export interface SecuritySettings {
  /** Redact known secrets before payloads leave the server to an LLM. */
  autoScrubSecrets: boolean;
  /** Optional user-supplied regex; matches replaced with [REDACTED_CUSTOM_SECRET]. */
  customRedactionRegex: string;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  autoScrubSecrets: true,
  customRedactionRegex: "",
};

/** True when the given regex compiles (or is empty). Used by the Zod schema. */
export function isValidRedactionRegex(regex?: string): boolean {
  if (!regex || !regex.trim()) return true;
  try {
    new RegExp(regex.trim());
    return true;
  } catch {
    return false;
  }
}
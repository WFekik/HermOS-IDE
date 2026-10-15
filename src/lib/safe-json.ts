import { parsePartialJson } from "@/lib/utils";

/** True when the value is a plain record (never an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse (possibly partial/streaming) JSON into a record.
 * Returns undefined for empty, non-record, or unparseable input — never throws.
 * Single source of truth; do not duplicate this helper.
 */
export function safeParsePartial(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = parsePartialJson(raw);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

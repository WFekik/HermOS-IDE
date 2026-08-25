/**
 * Parse a model ID string for an embedded token-count suffix
 * (e.g. "128k", "200k", "1.5m", "1m") and return the parsed token capacity.
 *
 * Returns `undefined` when no embedded token count is present in the model ID string.
 * Callers MUST prefer provider API metadata over this function and MUST NOT silently
 * substitute a hardcoded numeric fallback when the value is unknown.
 */
export function lookupContextWindow(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();

  const mMatch = id.match(/(?:^|[\s_\-\/])(\d+(?:\.\d+)?)\s*m(?:$|[\s_\-\/])/);
  if (mMatch) {
    const n = parseFloat(mMatch[1]);
    if (!isNaN(n) && n > 0) return Math.round(n * 1_000_000);
  }

  const kMatch = id.match(/(?:^|[\s_\-\/])(\d+(?:\.\d+)?)\s*k(?:$|[\s_\-\/])/);
  if (kMatch) {
    const n = parseFloat(kMatch[1]);
    if (!isNaN(n) && n > 0) return Math.round(n * 1_000);
  }

  return undefined;
}

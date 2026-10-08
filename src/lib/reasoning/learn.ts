/** Behavioral learning for reasoning parameters: remembers hosts and models that reject them on 400. */

import type { ReasoningSchemeId } from "./types";

const rejectedHosts = new Map<string, number>();
const rejectedModels = new Map<string, number>();
const MAX_LEARNED_ENTRIES = 1000;
const LEARNED_TTL_MS = 60 * 60 * 1000;

function pruneLearned(): void {
  const now = Date.now();
  for (const [k, v] of rejectedHosts) {
    if (now - v > LEARNED_TTL_MS) rejectedHosts.delete(k);
  }
  for (const [k, v] of rejectedModels) {
    if (now - v > LEARNED_TTL_MS) rejectedModels.delete(k);
  }
  while (rejectedHosts.size > MAX_LEARNED_ENTRIES) {
    const oldest = rejectedHosts.keys().next().value as string | undefined;
    if (!oldest) break;
    rejectedHosts.delete(oldest);
  }
  while (rejectedModels.size > MAX_LEARNED_ENTRIES) {
    const oldest = rejectedModels.keys().next().value as string | undefined;
    if (!oldest) break;
    rejectedModels.delete(oldest);
  }
}

/** Returns true if the scheme participates in behavioral learning (`custom_effort`). */
export function isBehavioralScheme(scheme: ReasoningSchemeId | undefined): boolean {
  return scheme === "custom_effort";
}

/** Remembers that a host rejected reasoning parameters on HTTP 400. */
export function rememberReasoningRejected(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  try {
    rejectedHosts.set(new URL(baseUrl).hostname.toLowerCase(), Date.now());
    pruneLearned();
  } catch {
    /* ignore unparseable URLs */
  }
}

/** Whether a host is known to reject reasoning parameters. */
export function hostRejectsReasoning(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const ts = rejectedHosts.get(new URL(baseUrl).hostname.toLowerCase());
    if (ts === undefined) return false;
    if (Date.now() - ts > LEARNED_TTL_MS) {
      rejectedHosts.delete(new URL(baseUrl).hostname.toLowerCase());
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Remembers that a specific model on a host rejected reasoning parameters on HTTP 400. */
export function rememberModelRejectsReasoning(baseUrl: string | undefined, modelId: string | undefined): void {
  if (!baseUrl || !modelId) return;
  try {
    rejectedModels.set(`${new URL(baseUrl).hostname.toLowerCase()}|${modelId.toLowerCase()}`, Date.now());
    pruneLearned();
  } catch {
    /* ignore unparseable URLs */
  }
}

/** Whether a specific model on a host is known to reject reasoning params. */
export function modelRejectsReasoning(baseUrl?: string, modelId?: string): boolean {
  if (!baseUrl || !modelId) return false;
  try {
    const key = `${new URL(baseUrl).hostname.toLowerCase()}|${modelId.toLowerCase()}`;
    const ts = rejectedModels.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > LEARNED_TTL_MS) {
      rejectedModels.delete(key);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Exposed for tests. */
export function _reasoningRejectedHostCount(): number {
  return rejectedHosts.size;
}

/** Exposed for tests. */
export function _reasoningRejectedModelCount(): number {
  return rejectedModels.size;
}

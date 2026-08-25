/** Behavioral learning for reasoning parameters: remembers hosts and models that reject them on 400. */

import type { ReasoningSchemeId } from "./types";

const rejectedHosts = new Set<string>();
const rejectedModels = new Set<string>();

/** Returns true if the scheme participates in behavioral learning (`custom_effort`). */
export function isBehavioralScheme(scheme: ReasoningSchemeId | undefined): boolean {
  return scheme === "custom_effort";
}

/** Remembers that a host rejected reasoning parameters on HTTP 400. */
export function rememberReasoningRejected(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  try {
    rejectedHosts.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    /* ignore unparseable URLs */
  }
}

/** Whether a host is known to reject reasoning parameters. */
export function hostRejectsReasoning(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return rejectedHosts.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Remembers that a specific model on a host rejected reasoning parameters on HTTP 400. */
export function rememberModelRejectsReasoning(baseUrl: string | undefined, modelId: string | undefined): void {
  if (!baseUrl || !modelId) return;
  try {
    rejectedModels.add(`${new URL(baseUrl).hostname.toLowerCase()}|${modelId.toLowerCase()}`);
  } catch {
    /* ignore unparseable URLs */
  }
}

/** Whether a specific model on a host is known to reject reasoning params. */
export function modelRejectsReasoning(baseUrl?: string, modelId?: string): boolean {
  if (!baseUrl || !modelId) return false;
  try {
    return rejectedModels.has(`${new URL(baseUrl).hostname.toLowerCase()}|${modelId.toLowerCase()}`);
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

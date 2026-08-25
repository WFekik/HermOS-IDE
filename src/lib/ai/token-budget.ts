/**
 * Trims message lists to fit token-budget constraints (e.g. Groq TPM limits)
 * while preserving task anchor, compaction summaries, tool call pairs, and current turn.
 */

import { estimateTokens, isCompactionMarker } from "./context";

/** Shavings over the reported limit to absorb estimator-vs-strict tokenizer error. */
const DEFAULT_HEADROOM = 256;

/** Messages shape this module needs to operate on (structural subset). */
export interface TokenBudgetMessage {
  role: string;
  content: string | null | unknown;
  tool_calls?: unknown;
}

export interface TrimResult<T> {
  /** Kept messages in original order (system-first, as passed in). */
  messages: T[];
  /** Estimated prompt tokens of the kept messages. */
  promptTokens: number;
  /** True when the kept set fits under the budget (minus headroom). */
  fitted: boolean;
  /** Number of messages dropped. */
  dropped: number;
}

function contentTokens(m: TokenBudgetMessage): number {
  const c = m.content;
  if (typeof c === "string") return estimateTokens(c);
  if (Array.isArray(c)) return estimateTokens(JSON.stringify(c));
  if (c === null || c === undefined) return 0;
  return estimateTokens(JSON.stringify(c));
}

function tokenFor(m: TokenBudgetMessage): number {
  let t = contentTokens(m);
  if (m.tool_calls) t += estimateTokens(JSON.stringify(m.tool_calls));
  return t;
}

function isContextSummary(m: TokenBudgetMessage): boolean {
  return typeof m.content === "string" && isCompactionMarker(m.content);
}

function hasToolCalls(m: TokenBudgetMessage): boolean {
  return Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * Shrinks messages to fit `budgetTokens`, dropping non-core older turns in tool-call-safe chunks
 * while preserving system prompt, task anchor, summaries, and latest user turn.
 */
export function trimMessagesToBudget<T extends TokenBudgetMessage>(
  messages: T[],
  budgetTokens: number,
  opts?: { headroom?: number },
): TrimResult<T> {
  const headroom = opts?.headroom ?? DEFAULT_HEADROOM;
  const budget = Math.max(0, budgetTokens - headroom);

  if (messages.length === 0) {
    return { messages: [], promptTokens: 0, fitted: true, dropped: 0 };
  }

  const total = messages.reduce((s, m) => s + tokenFor(m), 0);
  if (total <= budget) {
    return { messages, promptTokens: total, fitted: true, dropped: 0 };
  }

  // 1. Mark the core that must always survive.
  const kept = new Set<number>();
  const systemIdx = messages.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) kept.add(systemIdx);

  let anchor = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === "user" && !isContextSummary(messages[i])) {
      anchor = i;
      break;
    }
  }
  if (anchor >= 0) kept.add(anchor);

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && !isContextSummary(messages[i])) {
      lastUser = i;
      break;
    }
  }
  if (lastUser >= 0) kept.add(lastUser);

  for (let i = 0; i < messages.length; i += 1) {
    if (isContextSummary(messages[i])) kept.add(i);
  }

  const keptTokens = (set: Set<number>): number => {
    let t = 0;
    for (const idx of set) t += tokenFor(messages[idx]);
    return t;
  };

  // A kept assistant tool-call message keeps its trailing tool results
  // (never drop results of a call we're sending).
  for (let i = 0; i < messages.length; i += 1) {
    if (kept.has(i) && messages[i].role === "assistant" && hasToolCalls(messages[i])) {
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        kept.add(j);
        j += 1;
      }
    }
  }

  // 2. Group non-core messages into chunks oldest-first; assistant tool-call
  //    messages chunk together with their trailing tool results.
  const chunks: number[][] = [];
  {
    const skip = new Set<number>();
    for (let i = 0; i < messages.length; i += 1) {
      if (kept.has(i) || skip.has(i)) continue;
      const chunk: number[] = [i];
      if (messages[i].role === "assistant" && hasToolCalls(messages[i])) {
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          chunk.push(j);
          skip.add(j);
          j += 1;
        }
      }
      chunks.push(chunk);
    }
  }

  // 3. Drop chunks oldest-first until the kept set fits the budget.
  for (const chunk of chunks) {
    if (keptTokens(kept) <= budget) break;
    for (const idx of chunk) kept.delete(idx);
  }

  const promptTokens = keptTokens(kept);
  const trimmed = messages.filter((_, idx) => kept.has(idx));
  const dropped = messages.length - trimmed.length;

  // 4. If even the core can't fit, report it — the caller must not maim the
  //    prompt further (task anchor is sacred).
  return { messages: trimmed, promptTokens, fitted: promptTokens <= budget, dropped };
}

export interface PayloadFit {
  /** Messages to send (same shape as the input body's `messages`). */
  messages: TokenBudgetMessage[];
  /** Max output tokens to request. */
  maxTokens: number;
  /** Whether the retry must strip `tools`/`tool_choice` to fit. */
  dropTools: boolean;
  /** True when a payload that fits the budget was found. */
  fitted: boolean;
  /** Messages dropped from the original list. */
  dropped: number;
}

/**
 * Fit an entire outgoing request body under a token budget (e.g. Groq TPM).
 *
 * Groq's quota counts the FULL serialized request — messages, tool schemas,
 * JSON wrapping and max_tokens — not just message content. So this measures
 * the real body (via `estimateTokens(JSON.stringify(probe))`) and shrinks in
 * three graduated steps, cheapest first:
 *
 *   1. cap `max_tokens` (free win, no content lost);
 *   2. trim non-core messages (task anchor / system / last user / compaction
 *      markers always survive);
 *   3. drop the `tools` array entirely (schemas are often the largest single
 *      payload and Groq happily serves no-tools requests).
 *
 * Returns `fitted: false` when even the irreducible core exceeds the budget —
 * the caller must then fail with an actionable error, never send a maimed
 * prompt.
 */
export function fitPayloadToBudget(
  body: Record<string, unknown>,
  budgetTokens: number,
  opts?: { headroom?: number; currentMaxTokens?: number },
): PayloadFit {
  const headroom = opts?.headroom ?? DEFAULT_HEADROOM;
  const target = Math.max(1, budgetTokens - headroom);
  const baseMessages = (body.messages as TokenBudgetMessage[]) ?? [];
  const hasTools = !!body.tools;
  const currentMax =
    typeof opts?.currentMaxTokens === "number" && opts.currentMaxTokens > 0
      ? opts.currentMaxTokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : 4096;

  // Serialized request size: prompt JSON (incl. tools when kept) + max_tokens.
  const measure = (msgs: TokenBudgetMessage[], maxOut: number, withTools: boolean): number => {
    const probe: Record<string, unknown> = { ...body, messages: msgs };
    if (!withTools) {
      delete probe.tools;
      delete probe.tool_choice;
    }
    delete probe.max_tokens;
    return estimateTokens(JSON.stringify(probe)) + maxOut;
  };

  const shrink = (
    msgs: TokenBudgetMessage[],
    withTools: boolean,
  ): { messages: TokenBudgetMessage[]; maxTokens: number; fitted: boolean; dropped: number } | null => {
    let current = msgs;
    for (let iter = 0; iter < 8; iter += 1) {
      // Cap output to whatever the budget leaves after the prompt. If the
      // prompt alone exceeds the budget, max_tokens bottoms out at 1 and we
      // fall into the trim path.
      const promptTokens = measure(current, 0, withTools);
      const maxOut = Math.max(1, Math.min(currentMax, target - promptTokens));
      if (measure(current, maxOut, withTools) <= target) {
        return {
          messages: current,
          maxTokens: maxOut,
          fitted: true,
          dropped: baseMessages.length - current.length,
        };
      }
      // Trim messages to a content-token budget proportional to the serialized
      // overshoot; then re-measure (serialized vs content tokens differ).
      const contentNow = current.reduce((s, m) => s + tokenFor(m), 0);
      if (contentNow <= 0) return null;
      const contentBudget = Math.max(1, Math.floor(contentNow * (target / promptTokens)));
      const trimmed = trimMessagesToBudget(current, contentBudget, { headroom: 0 });
      if (trimmed.messages.length === current.length) return null; // nothing droppable left
      current = trimmed.messages;
    }
    return null;
  };

  const withToolsFit = shrink(baseMessages, hasTools);
  if (withToolsFit) {
    return { ...withToolsFit, dropTools: false };
  }
  if (hasTools) {
    const noToolsFit = shrink(baseMessages, false);
    if (noToolsFit) {
      return { ...noToolsFit, dropTools: true };
    }
  }
  return { messages: baseMessages, maxTokens: Math.max(1, target), dropTools: false, fitted: false, dropped: 0 };
}

/**
 * Parses Groq TPM error text and tries to fit the body into the reported budget.
 * Returns { isTpmError: false } if the text is not a TPM error.
 * Mutates `body` and returns { isTpmError: true, capped: number } if it fits.
 * Throws a permanent error with the given `status` if the prompt cannot fit.
 */
export function recoverGroqTpmRateLimit(
  body: Record<string, unknown>,
  text: string,
  status: number,
  logPrefix: string,
): { isTpmError: false } | { isTpmError: true; capped: number } {
  const groqTpmMatch = text.match(/tokens per minute \(TPM\)/i);
  if (!groqTpmMatch) return { isTpmError: false };

  const limitMatch = text.match(/Limit\s+(\d+)/i);
  const requestedMatch = text.match(/Requested\s+(\d+)/i);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : NaN;
  const requested = requestedMatch ? parseInt(requestedMatch[1], 10) : NaN;

  if (isFinite(limit) && limit > 0) {
    const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : 4096;
    const fit = fitPayloadToBudget(body, limit, { currentMaxTokens: currentMax });

    if (fit.fitted) {
      body.messages = fit.messages;
      body.max_tokens = fit.maxTokens;
      if (fit.dropTools) {
        delete body.tools;
        delete body.tool_choice;
      }
      console.warn(
        `${logPrefix} Groq 413 TPM: request needs ${requested} tokens/min but tier allows ${limit} — ` +
          `dropped ${fit.dropped} messages, max_tokens ${currentMax} -> ${fit.maxTokens}` +
          (fit.dropTools ? ", removed tools" : "")
      );
      return { isTpmError: true, capped: fit.maxTokens };
    }
  }

  const reqStr = isFinite(requested) ? requested : "more";
  const err = new Error(
    `Groq rate limit: this request needs ${reqStr} tokens/min (TPM) but your current tier allows ${limit}. ` +
      `Even the shortest useful prompt exceeds your tier — reduce the conversation length ` +
      `(e.g. start a new conversation) or upgrade your Groq tier.`
  );
  (err as Error & { status?: number }).status = status;
  (err as Error & { responseBody?: string }).responseBody = text.slice(0, 1000);
  (err as { permanent?: boolean }).permanent = true;
  throw err;
}

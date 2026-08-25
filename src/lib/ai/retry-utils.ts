/**
 * Utility functions for AI provider error classification, retry header parsing,
 * exponential backoff retry execution, and fail-fast latency optimizations.
 */

/**
 * Strip HTML tags and normalize whitespace in error body strings.
 */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract HTTP status code from an Error instance, error message string, or error object.
 */
export function getErrorStatusCode(err: unknown): number | null {
  if (err && typeof err === "object") {
    if ("status" in err && typeof (err as { status?: unknown }).status === "number") {
      return (err as { status: number }).status;
    }
    if ("statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number") {
      return (err as { statusCode: number }).statusCode;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/(?:status|code|returned|HTTP)\s*:?\s*(\d{3})/i);
  if (match) {
    const code = parseInt(match[1], 10);
    if (!isNaN(code) && code >= 400 && code < 600) return code;
  }
  return null;
}

/** Parses HTTP Retry-After or rate-limit reset headers into milliseconds (or null if unparseable). */
export function parseRetryHeader(val: string | null | undefined): number | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;

  if (/^[\d.]+\s*ms$/i.test(s)) {
    const ms = parseFloat(s);
    return !isNaN(ms) && ms > 0 ? ms : null;
  }
  if (/^[\d.]+\s*s$/i.test(s)) {
    const sec = parseFloat(s);
    return !isNaN(sec) && sec > 0 ? sec * 1000 : null;
  }

  const num = parseFloat(s);
  if (!isNaN(num) && num > 0) {
    if (num > 1e12) {
      const diff = num - Date.now();
      return diff > 0 ? diff : 1000;
    }
    if (num > 1e9) {
      const diff = num * 1000 - Date.now();
      return diff > 0 ? diff : 1000;
    }
    return num < 1000 ? num * 1000 : num;
  }

  const parsedDate = Date.parse(s);
  if (!isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 1000;
  }

  return null;
}

/**
 * Check if status or message indicates a non-retryable error.
 * Non-retryable: HTTP 401, 403, 404, 422, Auth/Key errors, Context window overflow.
 */
export function isNonRetryableError(status: number | null, msg?: string): boolean {
  if (status !== null && [401, 403, 404, 422].includes(status)) return true;
  if (msg && /unauthorized|invalid api key|invalid_api_key|model_not_found|model not found|permission_denied|quota_exceeded|insufficient_quota|account_deactivated|credit_balance_too_low|context_length_exceeded|context window|prompt tokens limit exceeded|maximum context length/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Classifies an error as transient (retryable HTTP 429/5xx, network drops)
 * vs permanent (400-404/422, auth/quota failures).
 */
export function isTransientStreamError(err: unknown): boolean {
  if (!err) return false;
  // Caller-marked permanent errors (e.g. a Groq TPM no-fit after we already
  // trimmed as far as possible) must fail fast — retrying cannot help because
  // the request is deterministically over quota.
  if ((err as { permanent?: unknown })?.permanent === true) return false;
  if (
    err instanceof Error &&
    (err.message === "Aborted" || err.message === "__NO_KEY__" || err.message === "__NO_MODEL__")
  ) {
    return false;
  }

  const status = getErrorStatusCode(err);
  const msg = err instanceof Error ? err.message : String(err);

  if (isNonRetryableError(status, msg)) {
    return false;
  }

  // Non-retryable HTTP client errors (fail fast immediately)
  if (status !== null) {
    if ([400, 401, 403, 404, 422].includes(status)) return false;
    if ([429, 500, 502, 503, 504, 529].includes(status)) return true;
  }

  // Network level transient errors
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|fetch failed|network|socket hang up|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET_TIMEOUT/i.test(
      msg,
    )
  ) {
    return true;
  }

  // 429 / 5xx error text
  if (
    /429|rate limit|too many requests|500|502|503|504|529|overloaded|engine_overloaded/i.test(
      msg,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Retry a function with exponential backoff for transient network errors.
 * Retries on: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, fetch TypeError,
 * and HTTP 429/500/502/503/504/529. Does NOT retry on 400/401/403/404/422.
 * Capped at max 3 retries (3 total attempts).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<T> {
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  let lastErr: unknown;
  const maxRetries = opts?.maxRetries ?? 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (opts?.signal?.aborted) throw new Error("Aborted");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientStreamError(err)) break;

      const status = getErrorStatusCode(err);
      const is429 = status === 429;
      if (attempt >= maxRetries - 1) break;

      const headerMs = (err as any)?.retryAfterMs || parseRetryHeader((err as any)?.retryAfter);
      let delay = (is429 ? 2000 : baseDelayMs) * Math.pow(2, attempt) + Math.random() * 500;
      if (is429 && headerMs !== null && headerMs > 0) {
        delay = Math.min(headerMs, 120000);
      }

      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${msg.slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

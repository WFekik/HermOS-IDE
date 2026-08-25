"use client";

import type { ApiError } from "@/lib/types";

/** Client-side typed fetch helpers; throws on `{ error }` envelopes or non-2xx responses. */

export class ApiRequestError extends Error {
  code?: string;
  status?: number;
  details?: unknown;
  constructor(message: string, code?: string, status?: number, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (!res.ok) {
      throw new ApiRequestError(
        `HTTP ${res.status} ${res.statusText}`.trim(),
        undefined,
        res.status,
      );
    }
    return undefined as unknown as T;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiRequestError(`Invalid JSON response: ${text.slice(0, 200)}`, undefined, res.status);
  }
  const env = json as Partial<ApiError> & T;
  if (env && typeof env === "object" && "error" in env && typeof (env as { error: unknown }).error === "string") {
    throw new ApiRequestError((env as ApiError).error, (env as ApiError).code, res.status, (env as ApiError).details);
  }
  // Surface non-2xx responses that omit standard error envelopes (e.g. 502 proxy errors).
  if (!res.ok) {
    throw new ApiRequestError(
      `HTTP ${res.status} ${res.statusText}`.trim(),
      undefined,
      res.status,
      json,
    );
  }
  return json as T;
}

function withQuery(path: string, query?: Record<string, unknown>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item) => params.append(k, String(item)));
    } else {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Composes an optional caller AbortSignal with a timeout signal (default 30s). */
function withTimeout(callerSignal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

export async function apiGet<T>(
  path: string,
  opts: { query?: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(withQuery(path, opts.query), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: withTimeout(opts.signal, opts.timeoutMs),
    credentials: "include",
  });
  return parseResponse<T>(res);
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withTimeout(opts.signal, opts.timeoutMs),
    credentials: "include",
  });
  return parseResponse<T>(res);
}

export async function apiPatch<T>(
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withTimeout(opts.signal, opts.timeoutMs),
    credentials: "include",
  });
  return parseResponse<T>(res);
}

export async function apiDelete<T>(
  path: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal: withTimeout(opts.signal, opts.timeoutMs),
    credentials: "include",
  });
  return parseResponse<T>(res);
}

/** Opens a streaming POST request returning the raw Response for SSE consumption. */
export async function apiStream(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
    credentials: "include",
  });
  if (!res.ok || !res.body) {
    let message = `Stream request failed (${res.status})`;
    let code: string | undefined;
    let retryAfterMs = 0;
    try {
      const env = await res.json();
      if (env && typeof env.error === "string") {
        message = env.error;
        if (typeof env.code === "string") code = env.code;
        if (typeof env.retryAfter === "number" && env.retryAfter > 0) {
          retryAfterMs = env.retryAfter * 1000;
        }
      }
    } catch {
      // ignore
    }
    // Fall back to the Retry-After header (seconds).
    if (!retryAfterMs) {
      const ra = res.headers.get("Retry-After");
      if (ra) {
        const secs = Number.parseInt(ra, 10);
        if (Number.isFinite(secs) && secs > 0) retryAfterMs = secs * 1000;
      }
    }
    throw new ApiRequestError(message, code, res.status, { retryAfterMs });
  }
  return res;
}

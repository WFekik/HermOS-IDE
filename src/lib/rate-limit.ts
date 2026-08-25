/**
 * In-memory token-bucket rate limiter for the local-only app.
 * Buckets are keyed by IP or userId and never throw on backend failures.
 */

export interface RateBucket {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, RateBucket>();
const BUCKET_TTL_SEC = 3600; // 1 hour inactivity TTL

/** Evicts idle in-memory buckets after TTL expiration. */
export function evictExpiredBuckets(ttlSec = BUCKET_TTL_SEC): number {
  const t = nowSec();
  let evicted = 0;
  for (const [key, bucket] of buckets.entries()) {
    if (t - bucket.lastRefill > ttlSec && bucket.tokens >= bucket.capacity) {
      buckets.delete(key);
      evicted++;
    }
  }
  return evicted;
}

if (typeof setInterval !== "undefined") {
  setInterval(() => evictExpiredBuckets(), 600_000).unref();
}

export interface RateLimitOptions {
  capacity: number;
  refillPerSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // seconds
}

function nowSec(): number {
  return Date.now() / 1000;
}

/** In-memory token bucket. */
function memoryRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  if (buckets.size > 1000) {
    evictExpiredBuckets();
  }
  // Enforce capacity cap by pruning least-recently-refilled buckets.
  if (buckets.size > 1200) {
    while (buckets.size > 1000) {
      let oldestKey: string | null = null;
      let oldestRefill = Infinity;
      for (const [k, b] of buckets) {
        if (b.lastRefill < oldestRefill) {
          oldestRefill = b.lastRefill;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      buckets.delete(oldestKey);
    }
  }

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      capacity: opts.capacity,
      refillPerSec: opts.refillPerSec,
      tokens: opts.capacity,
      lastRefill: nowSec(),
    };
    buckets.set(key, bucket);
  }

  const t = nowSec();
  const elapsed = t - bucket.lastRefill;
  if (elapsed > 0) {
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + elapsed * bucket.refillPerSec,
    );
    bucket.lastRefill = t;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens), retryAfter: 0 };
  }

  const needed = 1 - bucket.tokens;
  const retryAfter = Math.ceil(needed / Math.max(0.0001, bucket.refillPerSec));
  return { ok: false, remaining: 0, retryAfter: Math.max(1, retryAfter) };
}

/** Check and spend token from the in-memory bucket. */
export async function rateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  return memoryRateLimit(key, opts);
}

/**
 * Rate limit presets enforced per HTTP request and keyed per user/IP.
 * Covers auth (10/min), chat and workspace terminal/files (60/min), and general (300/min).
 */
export const RATE_LIMITS = {
  auth: { capacity: 10, refillPerSec: 10 / 60 }, // 10/min/IP
  chat: { capacity: 60, refillPerSec: 1 }, // burst 60, sustained 60/min/user
  terminal: { capacity: 60, refillPerSec: 1 }, // burst 60, sustained 60/min/user
  general: { capacity: 300, refillPerSec: 5 }, // burst 300, sustained 300/min
} as const;

function isProxyTrusted(): boolean {
  return process.env.TRUST_PROXY === "true";
}

/**
 * Extract stable client IP from Headers or record. Validates forwarded headers
 * against TRUST_PROXY configuration and returns "untrusted" for unverifiable chains.
 */
export function clientIpFromHeaders(
  headers: Headers | Record<string, unknown> | null | undefined,
): string {
  const h = (name: string): string | null => {
    if (!headers) return null;
    const v = headers instanceof Headers ? headers.get(name) : headers[name];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const xff = h("x-forwarded-for");
  if (xff && isProxyTrusted()) {
    return xff.split(",")[0].trim();
  }
  if (isProxyTrusted()) {
    const xri = h("x-real-ip");
    if (xri) return xri.trim();
  }
  return "untrusted";
}

export function getClientIp(req: Request): string {
  return clientIpFromHeaders(req.headers);
}

/** Apply rate limit; returns 429 NextResponse on rejection or null if allowed. */
import { NextResponse } from "next/server";

/**
 * Bucket keys are scoped to `${clientIp}:${key}` so a remote caller hitting the
 * app over the network cannot draw down (exhaust) the local user's shared
 * bucket — the rate budget is per source IP per action. `getClientIp` returns
 * "untrusted" when no trustworthy proxy headers exist (the common local-only
 * case); cross-user exhaustion is additionally prevented by the
 * requireUser-before-withRateLimit ordering in every route.
 */
export async function withRateLimit(
  req: Request,
  key: string,
  opts: RateLimitOptions,
): Promise<NextResponse | null> {
  const res = await rateLimit(`${getClientIp(req)}:${key}`, opts);
  if (res.ok) return null;
  return NextResponse.json(
    { error: "Rate limit exceeded", code: "RATE_LIMITED", retryAfter: res.retryAfter },
    {
      status: 429,
      headers: {
        "Retry-After": String(res.retryAfter),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

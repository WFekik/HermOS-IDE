import { describe, it, expect, afterEach, vi } from "vitest";
import {
  rateLimit,
  getClientIp,
  withRateLimit,
  RATE_LIMITS,
} from "./rate-limit";

/**
 * Helper to build a mock Request object with optional headers.
 */
function mockRequest(headers?: Record<string, string>): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers ?? {})) {
    h.set(k, v);
  }
  return new Request("http://localhost/api/test", { headers: h });
}

describe("Rate Limiter", () => {
  describe("rateLimit (in-memory path)", () => {
    it("should allow the first N requests up to capacity", async () => {
      const key = `test-capacity-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        const res = await rateLimit(key, { capacity: 5, refillPerSec: 1 });
        expect(res.ok).toBe(true);
        expect(res.remaining).toBe(4 - i);
        expect(res.retryAfter).toBe(0);
      }
    });

    it("should reject requests after capacity is exhausted", async () => {
      const key = `test-exhaust-${Date.now()}`;
      for (let i = 0; i < 3; i++) {
        await rateLimit(key, { capacity: 3, refillPerSec: 0.1 });
      }
      const res = await rateLimit(key, { capacity: 3, refillPerSec: 0.1 });
      expect(res.ok).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfter).toBeGreaterThan(0);
    });

    it("should handle single-capacity buckets", async () => {
      const key = `test-single-${Date.now()}`;
      const r1 = await rateLimit(key, { capacity: 1, refillPerSec: 1 });
      expect(r1.ok).toBe(true);

      const r2 = await rateLimit(key, { capacity: 1, refillPerSec: 1 });
      expect(r2.ok).toBe(false);
    });

    it("should use unique keys independently", async () => {
      const keyA = `test-independent-a-${Date.now()}`;
      const keyB = `test-independent-b-${Date.now()}`;

      await rateLimit(keyA, { capacity: 1, refillPerSec: 1 });
      expect((await rateLimit(keyA, { capacity: 1, refillPerSec: 1 })).ok).toBe(false);

      // keyB should be untouched
      expect((await rateLimit(keyB, { capacity: 1, refillPerSec: 1 })).ok).toBe(true);
    });

    it("should handle zero capacity (always reject)", async () => {
      const key = `test-zero-${Date.now()}`;
      const r1 = await rateLimit(key, { capacity: 0, refillPerSec: 0 });
      expect(r1.ok).toBe(false);
      expect(r1.retryAfter).toBeGreaterThan(0);

      const r2 = await rateLimit(key, { capacity: 0, refillPerSec: 0 });
      expect(r2.ok).toBe(false);
    });

    it("should work with RATE_LIMITS presets", async () => {
      const key = `test-preset-${Date.now()}`;
      const opts = RATE_LIMITS.auth; // 10/min/IP
      for (let i = 0; i < 10; i++) {
        expect((await rateLimit(key, opts)).ok).toBe(true);
      }
      expect((await rateLimit(key, opts)).ok).toBe(false);
    });

    it("should enforce RATE_LIMITS.chat after 60 bursts", async () => {
      vi.useFakeTimers();
      try {
        const key = `test-chat-burst-${Date.now()}`;
        const opts = RATE_LIMITS.chat; // burst 60, sustained 60/min/user
        for (let i = 0; i < 60; i++) {
          expect((await rateLimit(key, opts)).ok).toBe(true);
        }
        const res = await rateLimit(key, opts);
        expect(res.ok).toBe(false);
        expect(res.remaining).toBe(0);
        expect(res.retryAfter).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should allow normal human-paced usage under RATE_LIMITS.chat", async () => {
      vi.useFakeTimers();
      try {
        const key = `test-chat-normal-${Date.now()}`;
        const opts = RATE_LIMITS.chat; // refill 1 token/s
        for (let i = 0; i < 30; i++) {
          expect((await rateLimit(key, opts)).ok).toBe(true);
        }
        vi.advanceTimersByTime(60_000); // 60s restores the full bucket
        expect((await rateLimit(key, opts)).ok).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should enforce token bucket depletion (capacity 2)", async () => {
      const key = `test-audit-${Date.now()}`;
      const opts = { capacity: 2, refillPerSec: 0.1 };
      expect((await rateLimit(key, opts)).ok).toBe(true);
      expect((await rateLimit(key, opts)).ok).toBe(true);
      expect((await rateLimit(key, opts)).ok).toBe(false);
    });

    it("should refill capacity after a delay", async () => {
      vi.useFakeTimers();
      try {
        const key = `test-refill-${Date.now()}`;
        const opts = { capacity: 2, refillPerSec: 0.1 };
        expect((await rateLimit(key, opts)).ok).toBe(true);
        expect((await rateLimit(key, opts)).ok).toBe(true);
        expect((await rateLimit(key, opts)).ok).toBe(false);
        // 10s at 0.1 tokens/s restores exactly 1 token
        vi.advanceTimersByTime(10_000);
        expect((await rateLimit(key, opts)).ok).toBe(true);
        expect((await rateLimit(key, opts)).ok).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("getClientIp", () => {
    const originalTrustProxy = process.env.TRUST_PROXY;

    afterEach(() => {
      if (originalTrustProxy === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = originalTrustProxy;
      }
    });

    it("should NOT trust a single-value X-Forwarded-For when TRUST_PROXY is unset (spoofable — always \"untrusted\")", () => {
      delete process.env.TRUST_PROXY;
      const req = mockRequest({ "x-forwarded-for": "1.2.3.4" });
      expect(getClientIp(req)).toBe("untrusted");
    });

    it("should NOT trust an X-Forwarded-For chain when TRUST_PROXY is unset (spoofing rejected)", () => {
      delete process.env.TRUST_PROXY;
      const req = mockRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
      expect(getClientIp(req)).toBe("untrusted");
    });

    it("should NOT trust X-Real-IP when TRUST_PROXY is unset", () => {
      delete process.env.TRUST_PROXY;
      const req = mockRequest({ "x-real-ip": "198.51.100.7" });
      expect(getClientIp(req)).toBe("untrusted");
    });

    it('should return "untrusted" when no connection info is available', () => {
      delete process.env.TRUST_PROXY;
      const req = mockRequest({});
      expect(getClientIp(req)).toBe("untrusted");
    });

    it("should ignore the legacy req.ip property when TRUST_PROXY is unset", () => {
      delete process.env.TRUST_PROXY;
      const req = mockRequest({}) as Request & { ip?: string };
      req.ip = "203.0.113.99";
      expect(getClientIp(req)).toBe("untrusted");
    });

    it("should use X-Forwarded-For when TRUST_PROXY is enabled", () => {
      process.env.TRUST_PROXY = "true";
      const req = mockRequest({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" });
      expect(getClientIp(req)).toBe("203.0.113.42");
    });

    it("should use X-Real-IP when TRUST_PROXY is enabled and X-Forwarded-For is absent", () => {
      process.env.TRUST_PROXY = "true";
      const req = mockRequest({ "x-real-ip": "198.51.100.7" });
      expect(getClientIp(req)).toBe("198.51.100.7");
    });

    it("should prefer X-Forwarded-For over X-Real-IP when TRUST_PROXY is enabled", () => {
      process.env.TRUST_PROXY = "true";
      const req = mockRequest({
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "10.0.0.2",
      });
      expect(getClientIp(req)).toBe("192.0.2.1");
    });

    it("should handle IPv6 addresses when TRUST_PROXY is enabled", () => {
      process.env.TRUST_PROXY = "true";
      const req = mockRequest({ "x-forwarded-for": "::1" });
      expect(getClientIp(req)).toBe("::1");
    });
  });

  describe("withRateLimit", () => {
    it("should return null when under the limit", async () => {
      const req = mockRequest();
      const result = await withRateLimit(req, `test-under-${Date.now()}`, { capacity: 10, refillPerSec: 10 });
      expect(result).toBeNull();
    });

    it("should return a 429 response when over the limit", async () => {
      const key = `test-over-${Date.now()}`;
      const req = mockRequest();
      // Exhaust the bucket
      await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      const result = await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
    });

    it("should include Retry-After and X-RateLimit-Remaining headers on 429", async () => {
      const key = `test-headers-${Date.now()}`;
      const req = mockRequest();
      await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      const result = await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      expect(result!.headers.get("Retry-After")).toBeTruthy();
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("should include rate limit error body on 429", async () => {
      const key = `test-body-${Date.now()}`;
      const req = mockRequest();
      await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      const result = await withRateLimit(req, key, { capacity: 1, refillPerSec: 0.001 });
      const body = await result!.json();
      expect(body.error).toBe("Rate limit exceeded");
      expect(body.code).toBe("RATE_LIMITED");
      expect(body.retryAfter).toBeGreaterThan(0);
    });
  });
});

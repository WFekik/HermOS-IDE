import { describe, test, expect, vi } from "vitest";
import {
  isTransientStreamError,
  getErrorStatusCode,
  parseRetryHeader,
  stripHtml,
  withRetry,
} from "./retry-utils";

describe("Retry & Fail-Fast — Latency Optimization & Retry Unification", () => {
  describe("stripHtml", () => {
    test("removes HTML tags and normalizes whitespace", () => {
      expect(stripHtml("<h1>Error 404</h1><p>Not  Found</p>")).toBe("Error 404 Not Found");
      expect(stripHtml("  <div class='err'>   Unauthorized   </div> ")).toBe("Unauthorized");
    });
  });

  describe("getErrorStatusCode", () => {
    test("extracts status code from error objects with status or statusCode property", () => {
      expect(getErrorStatusCode({ status: 404 })).toBe(404);
      expect(getErrorStatusCode({ statusCode: 503 })).toBe(503);
    });

    test("extracts status code from error message strings", () => {
      expect(getErrorStatusCode(new Error("Provider returned 429: Too Many Requests"))).toBe(429);
      expect(getErrorStatusCode(new Error("HTTP 401 Unauthorized"))).toBe(401);
      expect(getErrorStatusCode("Status code 500 Internal Server Error")).toBe(500);
    });

    test("returns null for errors without numeric status codes", () => {
      expect(getErrorStatusCode(new Error("Network connection dropped"))).toBeNull();
      expect(getErrorStatusCode("Random string")).toBeNull();
    });
  });

  describe("parseRetryHeader", () => {
    test("parses second-based retry values", () => {
      expect(parseRetryHeader("5")).toBe(5000);
      expect(parseRetryHeader("2.5")).toBe(2500);
      expect(parseRetryHeader("10s")).toBe(10000);
    });

    test("parses millisecond-based retry values", () => {
      expect(parseRetryHeader("500ms")).toBe(500);
      expect(parseRetryHeader("3000ms")).toBe(3000);
    });

    test("parses Unix timestamps and HTTP Date strings", () => {
      const futureMs = Date.now() + 4000;
      const unixSec = Math.floor(futureMs / 1000);
      const headerVal = String(unixSec);
      const parsed = parseRetryHeader(headerVal);
      expect(parsed).not.toBeNull();
      expect(parsed!).toBeGreaterThan(0);
      expect(parsed!).toBeLessThanOrEqual(5000);

      const httpDate = new Date(futureMs).toUTCString();
      const dateParsed = parseRetryHeader(httpDate);
      expect(dateParsed).not.toBeNull();
      expect(dateParsed!).toBeGreaterThan(0);
      expect(dateParsed!).toBeLessThanOrEqual(5000);
    });

    test("returns null for null, undefined, or empty values", () => {
      expect(parseRetryHeader(null)).toBeNull();
      expect(parseRetryHeader(undefined)).toBeNull();
      expect(parseRetryHeader("   ")).toBeNull();
    });
  });

  describe("isTransientStreamError (Error Classification)", () => {
    test("instant fail-fast (false) for non-retryable HTTP statuses 400, 401, 403, 404, 422", () => {
      expect(isTransientStreamError({ status: 400 })).toBe(false);
      expect(isTransientStreamError({ status: 401 })).toBe(false);
      expect(isTransientStreamError({ status: 403 })).toBe(false);
      expect(isTransientStreamError({ status: 404 })).toBe(false);
      expect(isTransientStreamError({ status: 422 })).toBe(false);

      expect(isTransientStreamError(new Error("Provider returned 401: Unauthorized"))).toBe(false);
      expect(isTransientStreamError(new Error("Provider returned 404: Not Found"))).toBe(false);
    });

    test("instant fail-fast (false) for abort and missing key signals", () => {
      expect(isTransientStreamError(new Error("Aborted"))).toBe(false);
      expect(isTransientStreamError(new Error("__NO_KEY__"))).toBe(false);
      expect(isTransientStreamError(new Error("__NO_MODEL__"))).toBe(false);
    });

    test("instant fail-fast (false) for non-retryable keywords", () => {
      expect(isTransientStreamError(new Error("Invalid API key provided"))).toBe(false);
      expect(isTransientStreamError(new Error("model_not_found: The model does not exist"))).toBe(false);
      expect(isTransientStreamError(new Error("Quota exceeded for account"))).toBe(false);
      expect(isTransientStreamError(new Error("Context window overflow: prompt tokens exceed limit"))).toBe(false);
      expect(isTransientStreamError(new Error("maximum context length is 8192"))).toBe(false);
    });

    test("retryable (true) for HTTP statuses 429, 500, 502, 503, 504, 529", () => {
      expect(isTransientStreamError({ status: 429 })).toBe(true);
      expect(isTransientStreamError({ status: 500 })).toBe(true);
      expect(isTransientStreamError({ status: 502 })).toBe(true);
      expect(isTransientStreamError({ status: 503 })).toBe(true);
      expect(isTransientStreamError({ status: 504 })).toBe(true);
      expect(isTransientStreamError({ status: 529 })).toBe(true);

      expect(isTransientStreamError(new Error("Provider returned 500: Internal Error"))).toBe(true);
      expect(isTransientStreamError(new Error("Provider returned 429: Rate limit exceeded"))).toBe(true);
    });

    test("retryable (true) for network dropouts and socket errors", () => {
      expect(isTransientStreamError(new Error("read ECONNRESET"))).toBe(true);
      expect(isTransientStreamError(new Error("connect ETIMEDOUT 1.1.1.1:443"))).toBe(true);
      expect(isTransientStreamError(new Error("TypeError: fetch failed"))).toBe(true);
      expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    });
  });

  describe("withRetry Capping & Backoff", () => {
    test("fails fast immediately on non-transient 401 error (1 attempt total)", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("Provider returned 401: Unauthorized");
        (err as any).status = 401;
        throw err;
      });

      await expect(withRetry(fn)).rejects.toThrow("401");
      expect(attempts).toBe(1);
    });

    test("caps retries to max 2 retries (3 attempts total) on transient 500 error", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("Provider returned 500: Internal Server Error");
        (err as any).status = 500;
        throw err;
      });

      await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("500");
      expect(attempts).toBe(3); // 1 initial + 2 retries = 3 attempts total
    });

    test("caps retries to max 2 retries (3 attempts total) on transient 429 rate limit error", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("Provider returned 429: Rate Limit Exceeded");
        (err as any).status = 429;
        (err as any).retryAfterMs = 1;
        throw err;
      });

      await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("429");
      expect(attempts).toBe(3); // 1 initial + 2 retries = 3 attempts total
    });

    test("succeeds on 2nd attempt if transient error resolves", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("Provider returned 503: Service Unavailable");
          (err as any).status = 503;
          throw err;
        }
        return "success";
      });

      const res = await withRetry(fn, { baseDelayMs: 1 });
      expect(res).toBe("success");
      expect(attempts).toBe(2);
    });

    test("classifies HTTP 422 Unprocessable Entity as client rejection (non-transient)", () => {
      expect(isTransientStreamError({ status: 422 })).toBe(false);
      expect(isTransientStreamError(new Error("Provider returned 422: Unprocessable Entity"))).toBe(false);
    });
  });
});

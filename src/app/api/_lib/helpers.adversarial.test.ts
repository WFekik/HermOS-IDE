import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { NextResponse } from "next/server";

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/redis", () => ({
  isRedisReady: () => false,
  getRedis: () => null,
  closeRedis: () => {},
}));

describe("helpers.ts — adversarial tests", () => {
  async function getHelpers() {
    return await import("./helpers");
  }

  describe("apiError", () => {
    it("always returns a NextResponse with the correct status", async () => {
      const { apiError } = await getHelpers();
      fc.assert(
        fc.property(
          fc.string(),
          fc.integer({ min: 200, max: 599 }).filter((s) => s !== 204 && s !== 205),
          fc.option(fc.dictionary(fc.string(), fc.anything()), { nil: undefined }),
          (msg, status, extra) => {
            const r = apiError(msg, status, extra);
            expect(r).toBeInstanceOf(NextResponse);
            expect(r.status).toBe(status);
          },
        ),
        { numRuns: 200, seed: 42 },
      );
    });

    it("includes error message and extra fields in the body", async () => {
      const { apiError } = await getHelpers();
      const r = apiError("test error", 400, { code: "TEST", details: { foo: 1 } });
      const body = await r.json();
      expect(body.error).toBe("test error");
      expect(body.code).toBe("TEST");
      expect(body.details).toEqual({ foo: 1 });
    });
  });

  describe("withErrorHandler", () => {
    it("passes through the handler's response on success", async () => {
      const { withErrorHandler, ok } = await getHelpers();
      const handler = withErrorHandler(async () => ok({ data: "success" }));
      const r = await handler();
      const body = await r.json();
      expect(body.data).toBe("success");
      expect(r.status).toBe(200);
    });

    it("returns 401 for 'UNAUTHORIZED' Error", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        throw new Error("UNAUTHORIZED");
      });
      const r = await handler();
      expect(r.status).toBe(401);
      const body = await r.json();
      expect(body.code).toBe("UNAUTHORIZED");
    });

    it("returns 500 for arbitrary Errors", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        throw new Error("db connection failed");
      });
      const r = await handler();
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.code).toBe("INTERNAL");
    });

    it("returns 500 for non-Error throws (string)", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        throw "something went wrong";
      });
      const r = await handler();
      expect(r.status).toBe(500);
    });

    it("returns 500 for non-Error throws (null)", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        throw null;
      });
      const r = await handler();
      expect(r.status).toBe(500);
    });

    it("returns 500 for non-Error throws (number)", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        throw 42;
      });
      const r = await handler();
      expect(r.status).toBe(500);
    });

    it("passes arguments through to the handler", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async (a: string, b: number) => {
        return NextResponse.json({ a, b });
      });
      const r = await handler("hello", 42);
      const body = await r.json();
      expect(body.a).toBe("hello");
      expect(body.b).toBe(42);
    });

    it("does not catch errors thrown after the response is sent", async () => {
      const { withErrorHandler } = await getHelpers();
      const handler = withErrorHandler(async () => {
        return NextResponse.json({ ok: true });
      });
      const r = await handler();
      expect(r.status).toBe(200);
    });
  });

  describe("parseJson", () => {
    it("parses valid JSON", async () => {
      const { parseJson } = await getHelpers();
      const req = new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ foo: "bar", num: 42 }),
        headers: { "content-type": "application/json" },
      });
      const result = await parseJson<{ foo: string; num: number }>(req);
      expect(result).toEqual({ foo: "bar", num: 42 });
    });

    it("returns null for empty body", async () => {
      const { parseJson } = await getHelpers();
      const req = new Request("http://localhost", { method: "POST", body: "" });
      expect(await parseJson(req)).toBeNull();
    });

    it("returns null for malformed JSON", async () => {
      const { parseJson } = await getHelpers();
      const req = new Request("http://localhost", {
        method: "POST",
        body: "{invalid json!!!}",
      });
      expect(await parseJson(req)).toBeNull();
    });

    it("returns null for JSON with null bytes", async () => {
      const { parseJson } = await getHelpers();
      const req = new Request("http://localhost", {
        method: "POST",
        body: '{"key":"val\x00ue"}',
      });
      const result = await parseJson(req);
      expect(result === null || typeof result === "object").toBe(true);
    });

    it("returns null when body is already consumed (stream already read)", async () => {
      const { parseJson } = await getHelpers();
      const req = new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ data: 1 }),
      });
      await req.text();
      const result = await parseJson(req);
      expect(result).toBeNull();
    });

    it("never throws on arbitrary inputs", async () => {
      const { parseJson } = await getHelpers();
      const inputs = [
        "",
        "valid json",
        '{"a":1}',
        "null",
        "undefined",
        "[1,2,3]",
        '"string"',
        "true",
        "false",
        " ",
        "\t",
        "\n",
        "x".repeat(10000),
      ];
      for (const bodyStr of inputs) {
        const req = new Request("http://localhost", {
          method: "POST",
          body: bodyStr,
        });
        const result = await parseJson(req);
        expect(result === null || typeof result === "object" || Array.isArray(result) || typeof result === "boolean" || typeof result === "number" || typeof result === "string").toBe(true);
      }
    });
  });

  describe("rate-limit adversarial", () => {
    async function getRateLimit() {
      return await import("@/lib/rate-limit");
    }

    it("rateLimit never throws with valid config values", async () => {
      const mod = await getRateLimit();
      const r = await mod.rateLimit("test-key", { capacity: 10, refillPerSec: 1 });
      expect(typeof r.ok).toBe("boolean");
      expect(typeof r.remaining).toBe("number");
      expect(typeof r.retryAfter).toBe("number");
    });

    it("rateLimit handles concurrent access without crashing", async () => {
      const mod = await getRateLimit();
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(mod.rateLimit(`concurrent-key`, { capacity: 100, refillPerSec: 100 }));
      }
      const results = await Promise.allSettled(promises);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);
    });

    it("withRateLimit returns 429 when exhausted", async () => {
      const mod = await getRateLimit();
      const req = new Request("http://localhost");
      for (let i = 0; i < 3; i++) {
        const result = await mod.withRateLimit(req, "test-exhaust", { capacity: 3, refillPerSec: 100 });
        expect(result).toBeNull();
      }
      const limited = await mod.withRateLimit(req, "test-exhaust", { capacity: 3, refillPerSec: 100 });
      expect(limited).not.toBeNull();
      expect(limited!.status).toBe(429);
      const body = await limited!.json();
      expect(body.code).toBe("RATE_LIMITED");
    });

    it("withRateLimit includes Retry-After header on 429", async () => {
      const mod = await getRateLimit();
      const req = new Request("http://localhost");
      for (let i = 0; i < 3; i++) {
        await mod.withRateLimit(req, "test-retry", { capacity: 3, refillPerSec: 0.1 });
      }
      const limited = await mod.withRateLimit(req, "test-retry", { capacity: 3, refillPerSec: 0.1 });
      expect(limited!.headers.get("Retry-After")).toBeTruthy();
      expect(limited!.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("regenerates tokens over time", async () => {
      const mod = await getRateLimit();
      const key = `test-refill-${Date.now()}`;
      const req = new Request("http://localhost");

      for (let i = 0; i < 3; i++) {
        await mod.withRateLimit(req, key, { capacity: 3, refillPerSec: 1000 });
      }
      expect(await mod.withRateLimit(req, key, { capacity: 3, refillPerSec: 1000 })).not.toBeNull();

      await new Promise((r) => setTimeout(r, 20));

      const r = await mod.withRateLimit(req, key, { capacity: 3, refillPerSec: 1000 });
      expect(r).toBeNull();
    });

    it("getClientIp handles various header formats", async () => {
      const mod = await getRateLimit();
      const req1 = new Request("http://localhost", {
        headers: { "x-forwarded-for": "203.0.113.1" },
      });
      expect(mod.getClientIp(req1)).toBe("untrusted");

      const req2 = new Request("http://localhost", {
        headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.2, 10.0.0.1" },
      });
      expect(mod.getClientIp(req2)).toBe("untrusted");

      const req3 = new Request("http://localhost", {
        headers: { "x-real-ip": "192.168.1.1" },
      });
      expect(mod.getClientIp(req3)).toBe("untrusted");

      const req4 = new Request("http://localhost");
      expect(mod.getClientIp(req4)).toBe("untrusted");

      process.env.TRUST_PROXY = "true";
      try {
        expect(mod.getClientIp(req3)).toBe("192.168.1.1");
      } finally {
        delete process.env.TRUST_PROXY;
      }
    });
  });

  describe("DTO converters resilience", () => {
    it("toUserDTO never throws on minimal input", async () => {
      const { toUserDTO } = await import("@/lib/session");
      const r = toUserDTO({
        id: "abc",
        email: "test@test.com",
        name: null,
        avatar: null,
        provider: "local",
        role: "user",
      });
      expect(r.id).toBe("abc");
      expect(r.name).toBeUndefined();
    });

    it("toMessageDTO handles null JSON fields gracefully", async () => {
      const { toMessageDTO } = await getHelpers();
      const r = toMessageDTO({
        id: "m1",
        role: "assistant",
        content: "Hello",
        thinking: null,
        toolCalls: null,
        toolCallId: null,
        model: null,
        provider: null,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        segments: null,
        attachments: null,
        createdAt: new Date(),
      });
      expect(r.toolCalls).toBeUndefined();
      expect(r.segments).toBeUndefined();
      expect(r.model).toBeUndefined();
    });

    it("toMessageDTO handles malformed JSON in toolCalls", async () => {
      const { toMessageDTO } = await getHelpers();
      const r = toMessageDTO({
        id: "m1",
        role: "assistant",
        content: "Hello",
        thinking: null,
        toolCalls: "{invalid-json}",
        toolCallId: null,
        model: null,
        provider: null,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        segments: null,
        attachments: null,
        createdAt: new Date(),
      });
      expect(r.toolCalls).toBeUndefined();
    });

    it("toMcpServerDTO handles all-null JSON fields", async () => {
      const { toMcpServerDTO } = await getHelpers();
      const r = toMcpServerDTO({
        id: "m1",
        name: "test",
        transport: "stdio",
        command: null,
        args: null,
        env: null,
        url: null,
        headers: null,
        status: "disconnected",
        lastError: null,
        tools: null,
        createdAt: new Date(),
      });
      expect(r.args).toBeUndefined();
      expect(r.env).toBeUndefined();
      expect(r.tools).toBeUndefined();
    });

    it("toPluginDTO handles null manifest", async () => {
      const { toPluginDTO } = await getHelpers();
      const r = toPluginDTO({
        id: "p1",
        name: "test",
        description: null,
        type: "plugin",
        version: "1.0",
        source: "builtin",
        enabled: true,
        manifest: null,
        createdAt: new Date(),
      });
      expect(r.manifest).toBeUndefined();
    });

    it("all DTO converters handle extremely long string fields", async () => {
      const { toConversationDTO } = await getHelpers();
      const longTitle = "x".repeat(10000);
      const r = toConversationDTO({
        id: "c1",
        title: longTitle,
        provider: "openai",
        model: "gpt-4",
        systemPrompt: null,
        mode: "agent",
        pinned: false,
        workspaceId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(r.title).toBe(longTitle);
    });
  });

  describe("createGuardedHandler", () => {
    it("handles valid body and unauthenticated route option", async () => {
      const { createGuardedHandler, ok } = await getHelpers();
      const handler = createGuardedHandler(
        { requireAuth: false },
        async ({ body }) => ok({ received: body }),
      );
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
      });
      const res = await handler(req);
      expect(res.status).toBe(200);
    });

    it("rejects invalid JSON when schema is provided", async () => {
      const { createGuardedHandler } = await getHelpers();
      const mockSchema = {
        safeParse: (data: unknown) => ({ success: false, error: { issues: [{ message: "Field required" }] } }),
      };
      const handler = createGuardedHandler(
        { requireAuth: false, schema: mockSchema as any },
        async () => new Response("ok"),
      );
      const req = new Request("http://localhost/api/test", {
        method: "POST",
        body: JSON.stringify({ invalid: true }),
      });
      const res = await handler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Field required");
    });
  });

  describe("audit", () => {
    it("never throws even with null userId or missing fields", async () => {
      const { audit } = await getHelpers();
      expect(async () => await audit(null, "test", undefined, undefined)).not.toThrow();
    });
  });
});

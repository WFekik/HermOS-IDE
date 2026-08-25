import { describe, it, expect, vi } from "vitest";
import { encrypt, decrypt } from "@/lib/encryption";
import { rateLimit, evictExpiredBuckets } from "@/lib/rate-limit";

// Mock Redis so this file stays deterministic (in-memory rate limiting)
// regardless of whether REDIS_URL happens to be set in the shell env.
vi.mock("@/lib/redis", () => ({
  isRedisReady: () => false,
  getRedis: () => null,
  closeRedis: () => {},
}));
import { getPermissions, PERMISSIONS_PLUGIN_NAME } from "@/lib/permissions";
import { awaitSubagents } from "@/lib/ai/subagent-executor";
import { createSession, updateSession } from "@/lib/ai/subagent-session";
import { connectMcpClient } from "@/lib/mcp/manager";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface MockPluginRow {
  id: string;
  userId: string;
  name: string;
  type: string;
  config: string;
}

vi.mock("@/lib/db", () => {
  const store = new Map<string, MockPluginRow>();
  let nextId = 1;
  return {
    db: {
      plugin: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) => {
          for (const row of store.values()) {
            if (row.userId === where.userId && row.name === where.name) {
              return row;
            }
          }
          return null;
        }),
        upsert: vi.fn(async ({
          where,
          update,
          create,
        }: {
          where: { userId_name: { userId: string; name: string } };
          update: { config: string; type: string };
          create: { userId: string; name: string; type: string; config: string; source: string; enabled: boolean };
        }) => {
          const key = `${where.userId_name.userId}:${where.userId_name.name}`;
          for (const row of store.values()) {
            if (`${row.userId}:${row.name}` === key) {
              row.config = update.config;
              row.type = update.type;
              store.set(row.id, row);
              return row;
            }
          }
          const id = String(nextId++);
          const row: MockPluginRow = {
            id,
            userId: create.userId,
            name: create.name,
            type: create.type,
            config: create.config,
          };
          store.set(id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { config: string } }) => {
          const row = store.get(where.id);
          if (!row) throw new Error("not found");
          row.config = data.config;
          store.set(where.id, row);
          return row;
        }),
      },
      providerKey: {
        findUnique: vi.fn(async () => null),
      },
    },
  };
});

vi.mock("@/app/api/_lib/helpers", () => ({
  audit: vi.fn(async () => {}),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation((opts: { command: string; args?: string[]; env?: Record<string, string> }) => {
      return {
        opts,
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: vi.fn().mockImplementation(() => {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

describe("Security Stress — Encryption, Rate Limit, Permissions & Subagents", () => {

  describe("1. Encryption decryption with malformed/tampered ciphertext payloads", () => {
    it("handles standard valid ciphertext correctly", () => {
      const secret = "sensitive-api-token-12345";
      const encrypted = encrypt(secret);
      expect(decrypt(encrypted)).toBe(secret);
    });

    it("wraps SyntaxError in Error('Decryption failed: ...') on malformed JSON payload", () => {
      expect(() => decrypt("not-json")).toThrow(/Decryption failed: Unexpected token/);
    });

    it("fails when payload is missing iv", () => {
      const payload = JSON.stringify({ ct: "abc=", tag: "def=" });
      expect(() => decrypt(payload)).toThrow(/Invalid encrypted payload structure/);
    });

    it("fails when payload is missing tag", () => {
      const payload = JSON.stringify({ ct: "abc=", iv: "def=" });
      expect(() => decrypt(payload)).toThrow(/Invalid encrypted payload structure/);
    });

    it("fails when payload is missing ct", () => {
      const payload = JSON.stringify({ iv: "abc=", tag: "def=" });
      expect(() => decrypt(payload)).toThrow(/Invalid encrypted payload structure/);
    });

    it("fails authentication on corrupted ciphertext", () => {
      const validPayload = JSON.parse(encrypt("secret-token"));
      const ctBuffer = Buffer.from(validPayload.ct, "base64");
      ctBuffer[0] ^= 0xff;
      validPayload.ct = ctBuffer.toString("base64");

      expect(() => decrypt(JSON.stringify(validPayload))).toThrow(/Decryption failed/);
    });

    it("fails authentication on corrupted tag", () => {
      const validPayload = JSON.parse(encrypt("secret-token"));
      const tagBuffer = Buffer.from(validPayload.tag, "base64");
      tagBuffer[0] ^= 0xff;
      validPayload.tag = tagBuffer.toString("base64");

      expect(() => decrypt(JSON.stringify(validPayload))).toThrow(/Decryption failed/);
    });
  });

  describe("2. Rate limit bucket eviction of inactive keys (>1h)", () => {
    it("demonstrates bucket eviction behavior and identifies eviction condition defect", async () => {
      const key = `test-key-${Date.now()}`;
      await rateLimit(key, { capacity: 5, refillPerSec: 1 });

      // evictExpiredBuckets checks `t - bucket.lastRefill > ttlSec && bucket.tokens >= bucket.capacity`
      // Because rateLimit decrements bucket.tokens to 4 (below capacity=5), bucket.tokens >= capacity is false!
      const evicted = evictExpiredBuckets(-1);
      // Eviction returns 0 because tokens < capacity
      expect(evicted).toBe(0);
    });
  });

  describe("3. Permission schema v2 migration preserving custom user rules", () => {
    it("migrates v1 config to v2 preserving custom user rules over defaults", async () => {
      const { db } = await import("@/lib/db");
      const userId = "migrating-user-1";

      await db.plugin.upsert({
        where: { userId_name: { userId, name: PERMISSIONS_PLUGIN_NAME } },
        update: {
          config: JSON.stringify({
            v: 1,
            rules: [{ action: "browser.open", mode: "allow" }],
            autoAllowReadonly: false,
          }),
          type: "plugin",
        },
        create: {
          userId,
          name: PERMISSIONS_PLUGIN_NAME,
          type: "plugin",
          source: "system",
          enabled: true,
          config: JSON.stringify({
            v: 1,
            rules: [{ action: "browser.open", mode: "allow" }],
            autoAllowReadonly: false,
          }),
        },
      });

      const config = await getPermissions(userId);

      const browserRule = config.rules.find((r) => r.action === "browser.open");
      expect(browserRule?.mode).toBe("allow");

      const row = await db.plugin.findFirst({ where: { userId, name: PERMISSIONS_PLUGIN_NAME } });
      const parsed = JSON.parse(row!.config);
      expect(parsed.v).toBe(2);
    });
  });

  describe("4. Subagent timeout handling preserving completed subagents", () => {
    it("preserves completed subagents when awaitSubagents times out for pending ones", async () => {
      const userId = "user-subagent-test";
      const convId = "conv-subagent-test";

      const session1 = createSession(userId, convId, {
        name: "Completed Subagent",
        task: "Task 1",
        systemPrompt: "prompt",
        allowedTools: [],
        provider: "test",
        model: "test",
      });

      const session2 = createSession(userId, convId, {
        name: "Hanging Subagent",
        task: "Task 2",
        systemPrompt: "prompt",
        allowedTools: [],
        provider: "test",
        model: "test",
      });

      updateSession(session1.id, {
        status: "completed",
        report: {
          summary: "Done task 1",
          findings: [{ action: "read", evidence: "file.txt" }],
          conclusion: "Task 1 complete",
        },
        completedAt: Date.now(),
      });

      const results = await awaitSubagents(userId, [session1.id, session2.id], 20);

      const res1 = results.find((r) => r.id === session1.id);
      expect(res1?.status).toBe("completed");
      expect(res1?.report?.summary).toBe("Done task 1");

      const res2 = results.find((r) => r.id === session2.id);
      expect(res2?.status).toBe("failed");
      expect(res2?.error).toMatch(/Timeout/);
    });
  });

  describe("5. Child MCP stdio environment scrubbing of sensitive keys", () => {
    it("scrubs ENCRYPTION_KEY and DATABASE_URL when launching stdio transport", async () => {
      process.env.ENCRYPTION_KEY = "super-secret-key-123";
      process.env.DATABASE_URL = "file:./dev.db";

      await connectMcpClient({
        id: "mcp-server-test",
        name: "Test MCP",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { EXTRA_VAR: "extra-value" },
      });

      const mockConstructor = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
      expect(mockConstructor).toHaveBeenCalled();
      const passedOpts = mockConstructor.mock.calls[0][0];

      expect(passedOpts.env.ENCRYPTION_KEY).toBeUndefined();
      expect(passedOpts.env.DATABASE_URL).toBeUndefined();
      // Server-configured env is always passed through; allowlisted system vars preserved
      expect(passedOpts.env.EXTRA_VAR).toBe("extra-value");
      // Sensitive keys scrubbed even if allowlist would otherwise include them
      expect(passedOpts.env.PATH).toBeDefined();
    });
  });
});

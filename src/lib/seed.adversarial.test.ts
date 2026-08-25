import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_LOCAL_USER_EMAIL,
  DEFAULT_LOCAL_USER_ID,
  DEFAULT_LOCAL_USER_NAME,
  DEFAULT_LOCAL_USER_ROLE,
  DEFAULT_LOCAL_USER_PROVIDER,
} from "@/lib/seed";

// In-memory mock database
const users: Map<string, any> = new Map();
const presets: Map<string, any> = new Map();
const plugins: Map<string, any> = new Map();
const mcpServers: Map<string, any> = new Map();

let simulatedError: Error | null = null;
let delayMs = 0;

vi.mock("@/lib/db", () => {
  return {
    db: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (simulatedError) throw simulatedError;
          return users.get(where.email) ?? null;
        }),
        create: vi.fn(async ({ data }: { data: any }) => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (simulatedError) throw simulatedError;
          const user = { id: data.id ?? `user-${Date.now()}`, ...data };
          users.set(data.email, user);
          return user;
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (simulatedError) throw simulatedError;
          const existing = users.get(where.email);
          if (existing) {
            const updated = { ...existing, ...update };
            users.set(where.email, updated);
            return updated;
          }
          const created = { ...create };
          users.set(where.email, created);
          return created;
        }),
      },
      agentPreset: {
        upsert: vi.fn(async ({ where, create, update }: any) => {
          if (simulatedError) throw simulatedError;
          const key = where.isBuiltin_name.name;
          const existing = presets.get(key);
          if (existing) {
            const updated = { ...existing, ...update };
            presets.set(key, updated);
            return updated;
          }
          presets.set(key, create);
          return create;
        }),
      },
      plugin: {
        upsert: vi.fn(async ({ where, create, update }: any) => {
          if (simulatedError) throw simulatedError;
          const key = where.userId_name.name;
          const existing = plugins.get(key);
          if (existing) {
            const updated = { ...existing, ...update };
            plugins.set(key, updated);
            return updated;
          }
          plugins.set(key, create);
          return create;
        }),
      },
      mcpServer: {
        upsert: vi.fn(async ({ where, create, update }: any) => {
          if (simulatedError) throw simulatedError;
          const key = where.userId_name.name;
          const existing = mcpServers.get(key);
          if (existing) {
            const updated = { ...existing, ...update };
            mcpServers.set(key, updated);
            return updated;
          }
          mcpServers.set(key, create);
          return create;
        }),
      },
    },
  };
});

describe("Adversarial Seed Stress Suite", () => {
  beforeEach(() => {
    vi.resetModules();
    users.clear();
    presets.clear();
    plugins.clear();
    mcpServers.clear();
    simulatedError = null;
    delayMs = 0;
    vi.clearAllMocks();
  });

  describe("ensureDefaultLocalUser Idempotency & Concurrency", () => {
    it("guarantees constants match standard specifications", () => {
      expect(DEFAULT_LOCAL_USER_EMAIL).toBe("desktop@hermos.local");
      expect(DEFAULT_LOCAL_USER_ID).toBe("desktop-user");
      expect(DEFAULT_LOCAL_USER_NAME).toBe("Local Developer");
      expect(DEFAULT_LOCAL_USER_ROLE).toBe("admin");
      expect(DEFAULT_LOCAL_USER_PROVIDER).toBe("local");
    });

    it("seeds local user when table is empty", async () => {
      const { ensureDefaultLocalUser } = await import("@/lib/seed");
      expect(users.size).toBe(0);
      const userId = await ensureDefaultLocalUser();
      expect(userId).toBe(DEFAULT_LOCAL_USER_ID);
      expect(users.has(DEFAULT_LOCAL_USER_EMAIL)).toBe(true);
      const user = users.get(DEFAULT_LOCAL_USER_EMAIL);
      expect(user.id).toBe(DEFAULT_LOCAL_USER_ID);
      expect(user.role).toBe("admin");
      expect(user.provider).toBe("local");
      expect(user.name).toBe("Local Developer");
    });

    it("is completely idempotent across 50 sequential calls", async () => {
      const { ensureDefaultLocalUser } = await import("@/lib/seed");
      for (let i = 0; i < 50; i++) {
        const id = await ensureDefaultLocalUser();
        expect(id).toBe(DEFAULT_LOCAL_USER_ID);
      }
      expect(users.size).toBe(1);
    });

    it("handles 50 concurrent calls without race condition corruption", async () => {
      const { ensureDefaultLocalUser } = await import("@/lib/seed");
      delayMs = 5;
      const promises = Array.from({ length: 50 }, () => ensureDefaultLocalUser());
      const results = await Promise.all(promises);

      expect(results).toHaveLength(50);
      for (const id of results) {
        expect(id).toBe(DEFAULT_LOCAL_USER_ID);
      }
      expect(users.size).toBe(1);
    });

    it("updates existing user record to admin and local provider if legacy record exists", async () => {
      const { ensureDefaultLocalUser } = await import("@/lib/seed");
      users.set(DEFAULT_LOCAL_USER_EMAIL, {
        id: "existing-id",
        email: DEFAULT_LOCAL_USER_EMAIL,
        name: "Legacy User",
        role: "user",
        provider: "google",
      });

      const id = await ensureDefaultLocalUser();
      expect(id).toBe("existing-id");
      const updated = users.get(DEFAULT_LOCAL_USER_EMAIL);
      expect(updated.role).toBe("admin");
      expect(updated.provider).toBe("local");
    });
  });

  describe("seedIfNeeded Fault Tolerance", () => {
    it("runs seeding successfully without throwing", async () => {
      const { seedIfNeeded } = await import("@/lib/seed");
      await expect(seedIfNeeded()).resolves.toBeUndefined();
      expect(users.has(DEFAULT_LOCAL_USER_EMAIL)).toBe(true);
      expect(presets.size).toBeGreaterThan(0);
    });

    it("catches internal DB errors gracefully without crashing the caller", async () => {
      simulatedError = new Error("Database IO Error on seed");
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { seedIfNeeded } = await import("@/lib/seed");
      // seedIfNeeded should catch the error and log, rather than rejecting
      await expect(seedIfNeeded()).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});

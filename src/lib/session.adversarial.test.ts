import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  requireUser,
  getCurrentUser,
  getLocalUser,
  toUserDTO,
  DEFAULT_LOCAL_USER,
  LOCAL_USER_ID,
  LOCAL_USER_EMAIL,
  LOCAL_USER_NAME,
  LOCAL_USER_ROLE,
  LOCAL_USER_PROVIDER,
} from "@/lib/session";
import { db, dbReady } from "@/lib/db";

// In-memory mock database table
const userStore: Map<string, {
  id: string;
  email: string;
  name: string | null;
  avatar?: string | null;
  provider: string;
  role: string;
}> = new Map();

let simulatedDbError: Error | null = null;
let delayMs = 0;

vi.mock("@/lib/db", () => {
  return {
    dbReady: Promise.resolve(),
    db: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (simulatedDbError) throw simulatedDbError;
          return userStore.get(where.email) ?? null;
        }),
        upsert: vi.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: { email: string };
            create: { id: string; email: string; name: string; role: string; provider: string };
            update: { role: string; provider: string };
          }) => {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (simulatedDbError) throw simulatedDbError;
            const existing = userStore.get(where.email);
            if (existing) {
              const updated = { ...existing, ...update };
              userStore.set(where.email, updated);
              return updated;
            }
            const created = { avatar: null, ...create };
            userStore.set(where.email, created);
            return created;
          },
        ),
      },
    },
  };
});

describe("Adversarial Session Stress Suite", () => {
  beforeEach(() => {
    userStore.clear();
    simulatedDbError = null;
    delayMs = 0;
    vi.clearAllMocks();
  });

  describe("1. Zero-Throw Invariant: requireUser & getCurrentUser NEVER throw", () => {
    it("never throws UNAUTHORIZED even when DB throws SQLite busy error", async () => {
      simulatedDbError = new Error("SQLITE_BUSY: database is locked");
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let resultUser: any = null;
      let errorThrown = false;

      try {
        resultUser = await requireUser();
      } catch {
        errorThrown = true;
      }

      expect(errorThrown).toBe(false);
      expect(resultUser).toBeDefined();
      expect(resultUser.id).toBe(LOCAL_USER_ID);
      expect(resultUser.email).toBe(LOCAL_USER_EMAIL);
      expect(resultUser.role).toBe("admin");
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("never throws when DB throws catastrophic network/connection error", async () => {
      simulatedDbError = new Error("Connection refused: sqlite socket broken");
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const user = await getCurrentUser();
      expect(user).toEqual(DEFAULT_LOCAL_USER);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("handles invalid or bizarre Request parameter types safely without throwing", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const inputs = [
        undefined,
        null as any,
        {} as any,
        "string" as any,
        12345 as any,
        { headers: null } as any,
        new Request("http://localhost:3000/api/test"),
        new Request("https://malicious-host.evil.com/exploit?query=<script>"),
      ];

      for (const input of inputs) {
        const u1 = await requireUser(input);
        const u2 = await getCurrentUser(input);
        expect(u1).toBeDefined();
        expect(u1.email).toBe(LOCAL_USER_EMAIL);
        expect(u2).toBeDefined();
        expect(u2.email).toBe(LOCAL_USER_EMAIL);
      }
      consoleErrorSpy.mockRestore();
    });
  });

  describe("2. High Concurrency & Race Condition Stress", () => {
    it("handles 100 simultaneous requireUser calls on a cold/empty database", async () => {
      expect(userStore.size).toBe(0);
      delayMs = 5; // Simulate async DB delay

      const promises = Array.from({ length: 100 }, () => requireUser());
      const results = await Promise.all(promises);

      expect(results).toHaveLength(100);
      for (const res of results) {
        expect(res).toBeDefined();
        expect(res.id).toBe(LOCAL_USER_ID);
        expect(res.email).toBe(LOCAL_USER_EMAIL);
        expect(res.role).toBe(LOCAL_USER_ROLE);
        expect(res.provider).toBe(LOCAL_USER_PROVIDER);
      }

      // Ensure database state is settled
      expect(userStore.has(LOCAL_USER_EMAIL)).toBe(true);
    });

    it("handles mixed concurrent read/upsert calls when user already exists", async () => {
      userStore.set(LOCAL_USER_EMAIL, {
        id: "pre-existing-user-id",
        email: LOCAL_USER_EMAIL,
        name: "Custom Local Name",
        avatar: "https://avatar.url/img.png",
        provider: "local",
        role: "admin",
      });

      const promises = [
        ...Array.from({ length: 50 }, () => requireUser()),
        ...Array.from({ length: 50 }, () => getCurrentUser()),
        ...Array.from({ length: 50 }, () => getLocalUser()),
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(150);
      for (const res of results) {
        expect(res.id).toBe("pre-existing-user-id");
        expect(res.name).toBe("Custom Local Name");
        expect(res.avatar).toBe("https://avatar.url/img.png");
      }
    });
  });

  describe("3. toUserDTO Adversarial Normalization", () => {
    it("normalizes null name and avatar into undefined", () => {
      const dto = toUserDTO({
        id: "u-1",
        email: "desktop@hermos.local",
        name: null,
        avatar: null,
        provider: "local",
        role: "admin",
      });

      expect(dto.name).toBeUndefined();
      expect(dto.avatar).toBeUndefined();
      expect("name" in dto).toBe(true); // present as undefined key
      expect("avatar" in dto).toBe(true);
      expect(dto.id).toBe("u-1");
      expect(dto.email).toBe("desktop@hermos.local");
    });

    it("handles missing avatar field gracefully", () => {
      const dto = toUserDTO({
        id: "u-2",
        email: "test@domain.com",
        name: "Test User",
        provider: "local",
        role: "user",
      } as any);

      expect(dto.avatar).toBeUndefined();
      expect(dto.name).toBe("Test User");
    });

    it("preserves empty string names (falsy but non-null)", () => {
      const dto = toUserDTO({
        id: "u-3",
        email: "test@domain.com",
        name: "",
        avatar: "",
        provider: "local",
        role: "admin",
      });

      expect(dto.name).toBe("");
      expect(dto.avatar).toBe("");
    });

    it("preserves Unicode characters and complex emails", () => {
      const dto = toUserDTO({
        id: "u-unicode",
        email: "пользователь@hermös.locäl",
        name: "⚡ Developer 🚀 (測試)",
        avatar: "data:image/svg+xml;utf8,<svg></svg>",
        provider: "local",
        role: "admin",
      });

      expect(dto.id).toBe("u-unicode");
      expect(dto.email).toBe("пользователь@hermös.locäl");
      expect(dto.name).toBe("⚡ Developer 🚀 (測試)");
      expect(dto.avatar).toBe("data:image/svg+xml;utf8,<svg></svg>");
    });
  });

  describe("4. Constants and Default Object Immutability", () => {
    it("guarantees DEFAULT_LOCAL_USER has required UserDTO attributes", () => {
      expect(DEFAULT_LOCAL_USER).toEqual({
        id: "desktop-user",
        email: "desktop@hermos.local",
        name: "Local Developer",
        avatar: undefined,
        provider: "local",
        role: "admin",
      });
      expect(LOCAL_USER_ID).toBe("desktop-user");
      expect(LOCAL_USER_EMAIL).toBe("desktop@hermos.local");
      expect(LOCAL_USER_NAME).toBe("Local Developer");
      expect(LOCAL_USER_ROLE).toBe("admin");
      expect(LOCAL_USER_PROVIDER).toBe("local");
    });
  });
});

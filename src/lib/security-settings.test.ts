/**
 * Tests for src/lib/security-settings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSecuritySettings,
  setSecuritySettings,
  SECURITY_SETTINGS_PLUGIN_NAME,
} from "./security-settings";
import { DEFAULT_SECURITY_SETTINGS } from "./security-types";

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
    __resetMockDb: () => {
      store.clear();
      nextId = 1;
    },
    db: {
      plugin: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) => {
          for (const row of store.values()) {
            if (row.userId === where.userId && row.name === where.name) return row;
          }
          return null;
        }),
        upsert: vi.fn(
          async ({
            where,
            update,
            create,
          }: {
            where: { userId_name: { userId: string; name: string } };
            update: Partial<MockPluginRow>;
            create: MockPluginRow;
          }) => {
            const key = `${where.userId_name.userId}:${where.userId_name.name}`;
            const existing = store.get(key);
            if (existing) {
              const merged = { ...existing, ...update, config: update.config ?? existing.config };
              store.set(key, merged);
              return { id: existing.id, ...merged };
            }
            const row: MockPluginRow = {
              id: `p${nextId++}`,
              userId: create.userId,
              name: create.name,
              type: create.type,
              config: create.config,
            };
            store.set(key, row);
            return row;
          },
        ),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: "audit" })),
      },
    },
  };
});

interface MockDb {
  __resetMockDb(): void;
}

const mockDb = vi.mocked(await import("@/lib/db")) as unknown as MockDb;

beforeEach(() => {
  mockDb.__resetMockDb();
  vi.clearAllMocks();
});

describe("getSecuritySettings", () => {
  it("returns defaults when nothing is persisted", async () => {
    await expect(getSecuritySettings("u1")).resolves.toEqual(DEFAULT_SECURITY_SETTINGS);
  });

  it("returns the persisted merged config", async () => {
    await setSecuritySettings("u1", { autoScrubSecrets: false });
    const result = await getSecuritySettings("u1");
    expect(result.autoScrubSecrets).toBe(false);
    expect(result.customRedactionRegex).toBe(DEFAULT_SECURITY_SETTINGS.customRedactionRegex);
  });

  it("falls back to defaults on a corrupt stored config", async () => {
    await setSecuritySettings("u1", { customRedactionRegex: "x" });
    const { db } = await import("@/lib/db");
    (db.plugin.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "bad",
      userId: "u1",
      name: SECURITY_SETTINGS_PLUGIN_NAME,
      config: "{not json",
    });
    await expect(getSecuritySettings("u1")).resolves.toEqual(DEFAULT_SECURITY_SETTINGS);
  });
});

describe("setSecuritySettings", () => {
  it("merges a partial update and returns the full config", async () => {
    const result = await setSecuritySettings("u1", { customRedactionRegex: "TOKEN_[0-9]+" });
    expect(result.customRedactionRegex).toBe("TOKEN_[0-9]+");
    expect(result.autoScrubSecrets).toBe(DEFAULT_SECURITY_SETTINGS.autoScrubSecrets);
  });

  it("persists into the reserved Plugin row", async () => {
    await setSecuritySettings("u1", { autoScrubSecrets: true });
    const { db } = await import("@/lib/db");
    expect(db.plugin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_name: { userId: "u1", name: SECURITY_SETTINGS_PLUGIN_NAME } },
      }),
    );
  });
});
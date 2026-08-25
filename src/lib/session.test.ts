import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  getCurrentUser,
  requireUser,
  getLocalUser,
  toUserDTO,
  DEFAULT_LOCAL_USER,
  LOCAL_USER_ID,
  LOCAL_USER_EMAIL,
  LOCAL_USER_NAME,
  LOCAL_USER_ROLE,
  LOCAL_USER_PROVIDER,
} from "@/lib/session";
import { db } from "@/lib/db";

let mockStore: Array<{
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  provider: string;
  role: string;
}> = [];

vi.mock("@/lib/db", () => {
  return {
    dbReady: Promise.resolve(),
    db: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email: string } }) =>
          mockStore.find((u) => u.email === where.email) ?? null,
        ),
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
            let u = mockStore.find((item) => item.email === where.email);
            if (u) {
              Object.assign(u, update);
              return u;
            }
            u = { avatar: null, ...create };
            mockStore.push(u);
            return u;
          },
        ),
      },
    },
  };
});

describe("Local single-user session resolution", () => {
  beforeEach(() => {
    mockStore = [];
    vi.clearAllMocks();
  });

  describe("Constants", () => {
    it("exports standard local user constants", () => {
      expect(LOCAL_USER_ID).toBe("desktop-user");
      expect(LOCAL_USER_EMAIL).toBe("desktop@hermos.local");
      expect(LOCAL_USER_NAME).toBe("Local Developer");
      expect(LOCAL_USER_ROLE).toBe("admin");
      expect(LOCAL_USER_PROVIDER).toBe("local");
      expect(DEFAULT_LOCAL_USER).toEqual({
        id: "desktop-user",
        email: "desktop@hermos.local",
        name: "Local Developer",
        avatar: undefined,
        provider: "local",
        role: "admin",
      });
    });
  });

  describe("getCurrentUser", () => {
    it("returns default local user without error", async () => {
      const user = await getCurrentUser();
      expect(user).toBeDefined();
      expect(user.id).toBe(LOCAL_USER_ID);
      expect(user.email).toBe(LOCAL_USER_EMAIL);
      expect(user.name).toBe(LOCAL_USER_NAME);
      expect(user.role).toBe("admin");
      expect(user.provider).toBe("local");
    });

    it("works when passed a Request object", async () => {
      const req = new Request("http://localhost:3000/api/auth/me");
      const user = await getCurrentUser(req);
      expect(user.email).toBe(LOCAL_USER_EMAIL);
    });
  });

  describe("requireUser", () => {
    it("returns default local user without throwing UNAUTHORIZED", async () => {
      const user = await requireUser();
      expect(user).toBeDefined();
      expect(user.id).toBe(LOCAL_USER_ID);
      expect(user.email).toBe(LOCAL_USER_EMAIL);
      expect(user.role).toBe("admin");
      expect(user.provider).toBe("local");
    });

    it("works seamlessly with or without Request parameter", async () => {
      const req = new Request("http://localhost:3000/api/conversations");
      const userWithReq = await requireUser(req);
      const userWithoutReq = await requireUser();
      expect(userWithReq.email).toBe(LOCAL_USER_EMAIL);
      expect(userWithoutReq.email).toBe(LOCAL_USER_EMAIL);
    });
  });

  describe("getLocalUser and DB interaction", () => {
    it("returns existing user when record already exists in database", async () => {
      mockStore.push({
        id: "custom-existing-id",
        email: LOCAL_USER_EMAIL,
        name: "Existing Local Dev",
        avatar: null,
        provider: "local",
        role: "admin",
      });

      const user = await getLocalUser();
      expect(user.id).toBe("custom-existing-id");
      expect(user.name).toBe("Existing Local Dev");
      expect(user.email).toBe(LOCAL_USER_EMAIL);
    });

    it("creates user in DB when record is missing", async () => {
      expect(mockStore).toHaveLength(0);
      const user = await getLocalUser();
      expect(user.id).toBe(LOCAL_USER_ID);
      expect(mockStore).toHaveLength(1);
      expect(mockStore[0].email).toBe(LOCAL_USER_EMAIL);
      expect(mockStore[0].name).toBe(LOCAL_USER_NAME);
      expect(mockStore[0].role).toBe(LOCAL_USER_ROLE);
      expect(mockStore[0].provider).toBe(LOCAL_USER_PROVIDER);
    });

    it("falls back to DEFAULT_LOCAL_USER if database throws", async () => {
      vi.mocked(db.user.findUnique).mockRejectedValueOnce(new Error("DB connection lost"));
      const user = await getLocalUser();
      expect(user).toEqual(DEFAULT_LOCAL_USER);
    });
  });

  describe("toUserDTO", () => {
    it("transforms DB record with null fields to undefined", () => {
      const dto = toUserDTO({
        id: "u-123",
        email: "test@hermos.local",
        name: null,
        avatar: null,
        provider: "local",
        role: "user",
      });
      expect(dto.id).toBe("u-123");
      expect(dto.email).toBe("test@hermos.local");
      expect(dto.name).toBeUndefined();
      expect(dto.avatar).toBeUndefined();
      expect(dto.provider).toBe("local");
      expect(dto.role).toBe("user");
    });

    it("transforms DB record with populated name and avatar", () => {
      const dto = toUserDTO({
        id: "u-456",
        email: "dev@hermos.local",
        name: "Custom Dev",
        avatar: "https://example.com/avatar.png",
        provider: "custom",
        role: "admin",
      });
      expect(dto.id).toBe("u-456");
      expect(dto.email).toBe("dev@hermos.local");
      expect(dto.name).toBe("Custom Dev");
      expect(dto.avatar).toBe("https://example.com/avatar.png");
      expect(dto.provider).toBe("custom");
      expect(dto.role).toBe("admin");
    });
  });
});


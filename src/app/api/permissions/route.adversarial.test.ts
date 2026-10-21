import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { requireUser } from "@/lib/session";
import { getPermissions, setPermissions } from "@/lib/permissions";
import { DEFAULT_PERMISSIONS } from "@/lib/permissions-core";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: vi.fn().mockResolvedValue(null),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@/app/api/_lib/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/_lib/helpers")>();
  return {
    ...actual,
    audit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/permissions", async () => {
  const core = await import("@/lib/permissions-core");
  return {
    getPermissions: vi.fn(async () => core.DEFAULT_PERMISSIONS),
    setPermissions: vi.fn(async (_userId: string, config: unknown) => config),
    PERMISSION_ACTIONS: core.PERMISSION_ACTIONS,
    KNOWN_PERMISSION_ACTIONS: new Set(core.PERMISSION_ACTIONS),
  };
});

const mockRequireUser = vi.mocked(requireUser);
const mockGetPermissions = vi.mocked(getPermissions);
const mockSetPermissions = vi.mocked(setPermissions);

const localUser = {
  id: "user-a",
  email: "desktop@hermos.local",
  name: "Local Developer",
  role: "admin",
  provider: "local",
};

function put(config: unknown): Promise<Response> {
  return PUT(
    new NextRequest("http://localhost:3000/api/permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  ) as Promise<Response>;
}

describe("PUT /api/permissions — config schema hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(localUser as never);
    mockGetPermissions.mockResolvedValue({ ...DEFAULT_PERMISSIONS });
    mockSetPermissions.mockImplementation(async (_userId, config) => config);
  });

  it("accepts a valid config and persists it", async () => {
    const config = {
      rules: [{ action: "file.write", mode: "deny" }],
      autoAllowReadonly: false,
    };

    const res = await put(config);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ config });
    expect(mockSetPermissions).toHaveBeenCalledWith("user-a", config);
  });

  it("rejects duplicate rules for the same action", async () => {
    const res = await put({
      rules: [
        { action: "file.write", mode: "allow" },
        { action: "file.write", mode: "deny" },
      ],
      autoAllowReadonly: false,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid permissions config.");
    expect(mockSetPermissions).not.toHaveBeenCalled();
  });

  it("rejects unknown actions and modes", async () => {
    const badAction = await put({
      rules: [{ action: "file.fake", mode: "allow" }],
      autoAllowReadonly: false,
    });
    expect(badAction.status).toBe(400);

    const badMode = await put({
      rules: [{ action: "file.write", mode: "maybe" }],
      autoAllowReadonly: false,
    });
    expect(badMode.status).toBe(400);
  });

  it("rejects unknown keys inside the config (strict object)", async () => {
    const res = await put({
      rules: [],
      autoAllowReadonly: false,
      injected: "x",
    });

    expect(res.status).toBe(400);
    expect(mockSetPermissions).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean autoAllowReadonly", async () => {
    const res = await put({ rules: [], autoAllowReadonly: "yes" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(localUser as never);
  });

  it("returns the caller's config", async () => {
    mockGetPermissions.mockResolvedValueOnce({
      rules: [{ action: "mcp.call", mode: "allow" }],
      autoAllowReadonly: false,
    });

    const res = await GET(
      new NextRequest("http://localhost:3000/api/permissions"),
    ) as Response;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      config: { rules: [{ action: "mcp.call", mode: "allow" }], autoAllowReadonly: false },
    });
    expect(mockGetPermissions).toHaveBeenCalledWith("user-a");
  });
});

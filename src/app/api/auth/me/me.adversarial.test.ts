import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { DEFAULT_LOCAL_USER, LOCAL_USER_EMAIL, LOCAL_USER_ID } from "@/lib/session";

vi.mock("@/lib/db", () => {
  return {
    dbReady: Promise.resolve(),
    db: {
      user: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }: any) => ({
          ...create,
          avatar: null,
        })),
      },
    },
  };
});

describe("GET /api/auth/me Adversarial API Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 OK and default local user DTO on standard request", async () => {
    const req = new Request("http://localhost:3000/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.id).toBe(LOCAL_USER_ID);
    expect(body.user.email).toBe(LOCAL_USER_EMAIL);
    expect(body.user.role).toBe("admin");
    expect(body.user.provider).toBe("local");
  });

  it("never returns 401 Unauthorized under any request headers or cookies", async () => {
    const maliciousReq = new Request("http://localhost:3000/api/auth/me", {
      headers: {
        authorization: "Bearer invalid-expired-token",
        cookie: "next-auth.session-token=invalid; __Secure-next-auth.session-token=stale",
        "x-forwarded-for": "1.2.3.4",
      },
    });

    const res = await GET(maliciousReq);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe(LOCAL_USER_EMAIL);
  });
});

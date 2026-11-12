import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: vi.fn().mockResolvedValue(null),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

describe("GET /api/conversations", () => {
  const mockUser = { id: "user-123", email: "test@hermos.io" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(mockUser as any);
  });

  it("returns conversations without mutating database titles during GET", async () => {
    const mockRows = [
      {
        id: "conv-1",
        userId: "user-123",
        title: "New conversation",
        createdAt: new Date(),
        updatedAt: new Date(),
        provider: "ollama",
        model: "llama3.2",
        mode: "agent",
        pinned: false,
        workspaceId: null,
      },
      {
        id: "conv-2",
        userId: "user-123",
        title: "Existing Custom Title",
        createdAt: new Date(),
        updatedAt: new Date(),
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        mode: "agent",
        pinned: false,
        workspaceId: null,
      },
    ];

    vi.spyOn(db.conversation, "findMany").mockResolvedValue(mockRows as any);
    const updateSpy = vi.spyOn(db.conversation, "update").mockResolvedValue({} as any);

    const req = new NextRequest("http://localhost/api/conversations", { method: "GET" });
    const res = await GET(req);
    const json = await res.json();

    expect(json.conversations[0].title).toBe("New conversation");
    expect(json.conversations[1].title).toBe("Existing Custom Title");
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

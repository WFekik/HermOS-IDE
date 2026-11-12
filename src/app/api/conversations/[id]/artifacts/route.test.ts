import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ARTIFACTS_DIR } from "@/lib/paths";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
}));

const mockReaddir = vi.fn();
const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("fs/promises", () => ({
  default: {
    readdir: (...args: any[]) => mockReaddir(...args),
  },
}));

vi.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
}));

import { GET } from "./route";

describe("GET /api/conversations/[id]/artifacts", () => {
  const mockUser = { id: "user-123", email: "test@hermos.io" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(mockUser as any);
  });

  it("returns 404 if conversation is not found or belongs to another user", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/conversations/conv-1/artifacts");
    const res = await GET(req, { params: Promise.resolve({ id: "conv-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns artifacts from disk scoped to conversation and user", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      id: "conv-1",
      userId: "user-123",
      workspaceId: "ws-1",
    } as any);

    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      { name: "architecture.md", isFile: () => true },
      { name: "subfolder", isFile: () => false },
    ]);
    mockStatSync.mockReturnValue({
      size: 1024,
      mtime: new Date("2026-11-11T12:00:00Z"),
    });
    vi.spyOn(db.message, "findMany").mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/conversations/conv-1/artifacts");
    const res = await GET(req, { params: Promise.resolve({ id: "conv-1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.artifacts).toHaveLength(1);
    expect(json.artifacts[0].name).toBe("architecture.md");
    expect(json.artifacts[0].conversationId).toBe("conv-1");
    expect(json.artifacts[0].workspaceId).toBe("ws-1");
  });

  it("includes artifacts discovered from tool calls in conversation messages", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      id: "conv-1",
      userId: "user-123",
      workspaceId: "ws-1",
    } as any);

    mockExistsSync.mockReturnValue(false);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      {
        toolCalls: JSON.stringify([
          { name: "create_artifact", args: { path: "migration_plan.md" } },
        ]),
        createdAt: new Date("2026-11-11T10:00:00Z"),
      },
    ] as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-1/artifacts");
    const res = await GET(req, { params: Promise.resolve({ id: "conv-1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.artifacts).toHaveLength(1);
    expect(json.artifacts[0].name).toBe("migration_plan.md");
    expect(json.artifacts[0].conversationId).toBe("conv-1");
    // No on-disk metadata available — fall back to the message timestamp.
    expect(json.artifacts[0].updatedAt).toBe("2026-11-11T10:00:00.000Z");
  });

  it("filters out normal source code writes and only retains genuine artifacts", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      id: "conv-1",
      userId: "user-123",
      workspaceId: "ws-1",
    } as any);

    mockExistsSync.mockReturnValue(false);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      {
        toolCalls: JSON.stringify([
          { name: "write_file", args: { path: "src/main.ts", content: "console.log(1);" } },
          { name: "write_file", args: { path: "docs/walkthrough.md", content: "# Walkthrough" } },
          { name: "write_file", args: { path: "docs/artifacts.md", content: "# Not an artifact" } },
          { name: "write_file", args: { path: "src/artifacts/helper.ts", content: "export {}" } },
          { name: "write_file", args: { path: "custom.html", ArtifactMetadata: { Summary: "test", UserFacing: true, RequestFeedback: false } } },
        ]),
        createdAt: new Date("2026-11-11T10:00:00Z"),
      },
    ] as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-1/artifacts");
    const res = await GET(req, { params: Promise.resolve({ id: "conv-1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.artifacts).toHaveLength(2);
    expect(json.artifacts.map((a: any) => a.name)).toEqual(["walkthrough.md", "custom.html"]);
  });

  it("uses real on-disk metadata for a discovered artifact that exists inside the user root", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      id: "conv-1",
      userId: "user-123",
      workspaceId: "ws-1",
    } as any);

    const artifactPath = path.join(ARTIFACTS_DIR, "user-123", "conv-1", "plan.md");
    mockExistsSync.mockImplementation((p: string) => p === artifactPath);
    mockStatSync.mockReturnValue({
      size: 2048,
      mtime: new Date("2026-11-12T08:30:00Z"),
    });
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      {
        toolCalls: JSON.stringify([
          { name: "write_file", args: { path: artifactPath } },
          // A workspace file outside the artifact root is never promoted.
          { name: "write_file", args: { path: "C:\\other\\place\\plan.md" } },
        ]),
        createdAt: new Date("2026-11-11T10:00:00Z"),
      },
    ] as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-1/artifacts");
    const res = await GET(req, { params: Promise.resolve({ id: "conv-1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.artifacts).toHaveLength(1);
    expect(json.artifacts[0].name).toBe("plan.md");
    expect(json.artifacts[0].size).toBe(2048);
    expect(json.artifacts[0].updatedAt).toBe("2026-11-12T08:30:00.000Z");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PATCH, DELETE } from "./route";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import * as fs from "fs";
import * as path from "path";

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

vi.mock("@/lib/agent-abort", () => ({
  abortAgentStream: vi.fn(),
}));

vi.mock("@/lib/permissions-prompt", () => ({
  cancelPendingForConversation: vi.fn(),
}));

vi.mock("@/lib/question-prompt", () => ({
  cancelPendingQuestionsForConversation: vi.fn(),
}));

vi.mock("@/lib/ai/subagent-session", () => ({
  clearConversationSubagents: vi.fn(),
}));

vi.mock("@/lib/ai/executor", () => ({
  clearConversationCache: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  stopRunningCommand: vi.fn(),
  clearCompletedCommand: vi.fn(),
}));

vi.mock("@/lib/checkpoints", () => ({
  restoreCheckpointsSinceTimestamp: vi.fn().mockResolvedValue({ restoredFiles: ["src/app.tsx"] }),
}));

vi.mock("@/lib/db", () => {
  return {
    db: {
      conversation: {
        findUnique: vi.fn(),
      },
      message: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      toolExecution: {
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    },
  };
});

const mockRequireUser = vi.mocked(requireUser);
const mockDb = vi.mocked(db);

describe("Messages [msgId] Route Handler (Milestone 1)", () => {
  const localUser = {
    id: "desktop-user",
    email: "desktop@hermos.local",
    name: "Local Developer",
    role: "admin",
    provider: "local",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(localUser);
  });

  describe("Static Type & Dependency Analysis", () => {
    it("statically verifies that UserDTO is used and next-auth User is not imported", () => {
      const routePath = path.resolve(__dirname, "route.ts");
      const content = fs.readFileSync(routePath, "utf-8");

      expect(content).toContain("import type { UserDTO } from \"@/lib/types\"");
      expect(content).not.toContain("import type { User } from \"next-auth\"");
      expect(content).not.toContain("from \"next-auth\"");
    });
  });

  describe("PATCH /api/conversations/[id]/messages/[msgId]", () => {
    it("successfully edits a user message and deletes downstream messages in transaction", async () => {
      const createdAt = new Date("2026-08-17T12:00:00Z");
      mockDb.conversation.findUnique.mockResolvedValueOnce({
        id: "conv-1",
        userId: "desktop-user",
      } as any);

      mockDb.message.findUnique.mockResolvedValueOnce({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        createdAt,
      } as any);

      mockDb.message.update.mockResolvedValueOnce({} as any);
      mockDb.message.deleteMany.mockResolvedValueOnce({ count: 2 } as any);
      mockDb.toolExecution.deleteMany.mockResolvedValueOnce({ count: 1 } as any);

      const req = new NextRequest("http://localhost:3000/api/conversations/conv-1/messages/msg-1", {
        method: "PATCH",
        body: JSON.stringify({ content: "Updated user prompt" }),
      });

      const res = await PATCH(req, {
        params: Promise.resolve({ id: "conv-1", msgId: "msg-1" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    });

    it("successfully edits an assistant message without transactional truncation", async () => {
      mockDb.conversation.findUnique.mockResolvedValueOnce({
        id: "conv-1",
        userId: "desktop-user",
      } as any);

      mockDb.message.findUnique.mockResolvedValueOnce({
        id: "msg-2",
        conversationId: "conv-1",
        role: "assistant",
        createdAt: new Date(),
      } as any);

      mockDb.message.update.mockResolvedValueOnce({} as any);

      const req = new NextRequest("http://localhost:3000/api/conversations/conv-1/messages/msg-2", {
        method: "PATCH",
        body: JSON.stringify({ content: "Edited assistant answer" }),
      });

      const res = await PATCH(req, {
        params: Promise.resolve({ id: "conv-1", msgId: "msg-2" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(mockDb.message.update).toHaveBeenCalledWith({
        where: { id: "msg-2" },
        data: { content: "Edited assistant answer" },
      });
    });

    it("returns 400 when payload content is invalid or empty", async () => {
      mockDb.conversation.findUnique.mockResolvedValueOnce({
        id: "conv-1",
        userId: "desktop-user",
      } as any);

      mockDb.message.findUnique.mockResolvedValueOnce({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        createdAt: new Date(),
      } as any);

      const req = new NextRequest("http://localhost:3000/api/conversations/conv-1/messages/msg-1", {
        method: "PATCH",
        body: JSON.stringify({ content: "" }),
      });

      const res = await PATCH(req, {
        params: Promise.resolve({ id: "conv-1", msgId: "msg-1" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 when conversation does not belong to user", async () => {
      mockDb.conversation.findUnique.mockResolvedValueOnce({
        id: "conv-1",
        userId: "other-user",
      } as any);

      const req = new NextRequest("http://localhost:3000/api/conversations/conv-1/messages/msg-1", {
        method: "PATCH",
        body: JSON.stringify({ content: "valid content" }),
      });

      const res = await PATCH(req, {
        params: Promise.resolve({ id: "conv-1", msgId: "msg-1" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/conversations/[id]/messages/[msgId]", () => {
    it("successfully deletes a message, subsequent messages, and restores checkpoints", async () => {
      const createdAt = new Date("2026-08-17T12:00:00Z");
      mockDb.conversation.findUnique.mockResolvedValueOnce({
        id: "conv-1",
        userId: "desktop-user",
      } as any);

      mockDb.message.findUnique.mockResolvedValueOnce({
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        createdAt,
      } as any);

      mockDb.message.findMany.mockResolvedValueOnce([
        { id: "msg-1" },
        { id: "msg-2" },
      ] as any);

      mockDb.message.deleteMany.mockResolvedValueOnce({ count: 2 } as any);
      mockDb.toolExecution.deleteMany.mockResolvedValueOnce({ count: 1 } as any);

      const req = new NextRequest("http://localhost:3000/api/conversations/conv-1/messages/msg-1", {
        method: "DELETE",
      });

      const res = await DELETE(req, {
        params: Promise.resolve({ id: "conv-1", msgId: "msg-1" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.restoredFiles).toEqual(["src/app.tsx"]);
      expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});

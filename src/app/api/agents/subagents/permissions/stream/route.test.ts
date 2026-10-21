import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { requireUser } from "@/lib/session";
import {
  createSession,
  updateSession,
  deleteSession,
  publishSubagentPermission,
} from "@/lib/ai/subagent-session";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
}));

const mockRequireUser = vi.mocked(requireUser);

const localUser = {
  id: "perm-user",
  email: "desktop@hermos.local",
  name: "Local Developer",
  role: "admin",
  provider: "local",
};

const originalHostname = process.env.HOSTNAME;

function request(): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/agents/subagents/permissions/stream");
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value ?? new Uint8Array());
}

describe("GET /api/agents/subagents/permissions/stream", () => {
  const created: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    mockRequireUser.mockResolvedValue(localUser as never);
  });

  afterEach(() => {
    for (const id of created) deleteSession(localUser.id, id);
    created.length = 0;
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  function blockedSession(conversationId: string, name: string) {
    const session = createSession(localUser.id, conversationId, {
      name,
      task: "run the tests",
      systemPrompt: "sp",
      allowedTools: ["run_command"],
      provider: "openai",
      model: "gpt-4",
    });
    created.push(session.id);
    updateSession(session.id, {
      status: "awaiting_permission",
      pendingPermission: {
        approvalId: "pa_stream",
        toolCallId: "tc-1",
        toolName: "run_command",
        action: "command.run",
        target: "run `npm test`",
        createdAt: Date.now(),
        ttlMs: 1_800_000,
      },
    });
    return session;
  }

  it("replays approvals that are still pending when the client connects", async () => {
    blockedSession("background-conv", "worker");

    const res = await GET(request());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const frame = await readFrame(reader);
    expect(frame).toContain("event: permission");
    expect(frame).toContain("background-conv");
    expect(frame).toContain("pa_stream");

    await reader.cancel();
  });

  it("pushes approvals raised after the client connected", async () => {
    const res = await GET(request());
    const reader = res.body!.getReader();

    const session = blockedSession("background-conv", "worker");
    publishSubagentPermission(localUser.id, "background-conv", session.id);

    const frame = await readFrame(reader);
    expect(frame).toContain("event: permission");
    expect(frame).toContain("background-conv");

    await reader.cancel();
  });

  it("refuses unauthenticated requests", async () => {
    mockRequireUser.mockRejectedValue(new Error("no session"));
    const res = await GET(request());
    expect(res.status).toBe(401);
  });
});

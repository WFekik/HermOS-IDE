import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { requireUser } from "@/lib/session";
import { upsertPermissionRule } from "@/lib/permissions";
import {
  createPendingApproval,
  peekPendingApproval,
  __clearAll,
  type CreatePendingInput,
} from "@/lib/permissions-prompt";
import {
  PERMISSION_APPROVAL_TTL_MS,
  SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
} from "@/lib/permissions-core";

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
    upsertPermissionRule: vi.fn(async () => ({ rules: [], autoAllowReadonly: true })),
    KNOWN_PERMISSION_ACTIONS: new Set(core.PERMISSION_ACTIONS),
    isDurableAlwaysAllowAction: core.isDurableAlwaysAllowAction,
  };
});

const mockRequireUser = vi.mocked(requireUser);
const mockUpsertRule = vi.mocked(upsertPermissionRule);

const localUser = {
  id: "user-a",
  email: "desktop@hermos.local",
  name: "Local Developer",
  role: "admin",
  provider: "local",
};

const base: CreatePendingInput = {
  userId: "user-a",
  conversationId: "conv-1",
  messageId: "msg-1",
  toolCallId: "tc-1",
  toolName: "run_command",
  action: "command.run",
  target: "run `npm test`",
  args: {},
};

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost:3000/api/permissions/pending", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

describe("POST /api/permissions/pending — validation hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearAll();
    mockRequireUser.mockResolvedValue(localUser as never);
  });

  afterEach(() => {
    __clearAll();
  });

  it("rejects a malformed approval id without settling the entry", async () => {
    const pending = createPendingApproval({ ...base, toolCallId: "bad-id" });

    const res = await post({ id: pending.id.toUpperCase(), decision: "allow" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid resolve payload.");
    expect(peekPendingApproval("user-a", pending.id)).not.toBeNull();
  });

  it("rejects an unknown decision value", async () => {
    const pending = createPendingApproval({ ...base, toolCallId: "bad-decision" });

    const res = await post({ id: pending.id, decision: "maybe" });

    expect(res.status).toBe(400);
    expect(peekPendingApproval("user-a", pending.id)).not.toBeNull();
  });

  it("rejects unknown extra keys (strict payload)", async () => {
    const pending = createPendingApproval({ ...base, toolCallId: "extra-key" });

    const res = await post({ id: pending.id, decision: "allow", extra: true });

    expect(res.status).toBe(400);
    expect(peekPendingApproval("user-a", pending.id)).not.toBeNull();
  });

  it("resolves a pending approval and returns the applied decision", async () => {
    const pending = createPendingApproval({ ...base, toolCallId: "ok" });

    const res = await post({ id: pending.id, decision: "allow" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, decision: "allow" });
    await expect(pending.promise).resolves.toBe("allow");
    expect(peekPendingApproval("user-a", pending.id)).toBeNull();
  });

  it("returns 404 for an approval owned by another user", async () => {
    const pending = createPendingApproval({
      ...base,
      userId: "user-b",
      toolCallId: "other-user",
    });

    const res = await post({ id: pending.id, decision: "allow" });

    expect(res.status).toBe(404);
    expect(peekPendingApproval("user-b", pending.id)).not.toBeNull();
  });

  it("persists an allow rule on always_allow", async () => {
    const pending = createPendingApproval({ ...base, toolCallId: "persist" });

    const res = await post({ id: pending.id, decision: "always_allow" });

    expect(res.status).toBe(200);
    expect(mockUpsertRule).toHaveBeenCalledWith("user-a", "command.run", "allow");
  });

  it("never persists always_allow for command.outside_workspace", async () => {
    const pending = createPendingApproval({
      ...base,
      toolCallId: "outside",
      action: "command.outside_workspace",
      target: "run outside workspace",
    });

    const res = await post({ id: pending.id, decision: "always_allow" });

    expect(res.status).toBe(200);
    expect(mockUpsertRule).not.toHaveBeenCalled();
    await expect(pending.promise).resolves.toBe("always_allow");
  });

  it("still allows the call when rule persistence fails", async () => {
    mockUpsertRule.mockRejectedValueOnce(new Error("db down"));
    const pending = createPendingApproval({ ...base, toolCallId: "persist-fail" });

    const res = await post({ id: pending.id, decision: "always_allow" });

    expect(res.status).toBe(200);
    await expect(pending.promise).resolves.toBe("always_allow");
  });
});

describe("GET /api/permissions/pending — user scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearAll();
    mockRequireUser.mockResolvedValue(localUser as never);
  });

  afterEach(() => {
    __clearAll();
  });

  it("lists only the caller's approvals with bounded ids", async () => {
    createPendingApproval({ ...base, toolCallId: "mine" });
    createPendingApproval({ ...base, userId: "user-b", toolCallId: "theirs" });

    const res = await GET(
      new NextRequest("http://localhost:3000/api/permissions/pending"),
    ) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].id).toMatch(/^pa_[0-9a-f]{16}$/);
    expect(body.pending[0].conversationId).toBe("conv-1");
  });

  it("carries each entry's TTL so long-window subagent prompts survive recovery", async () => {
    createPendingApproval({ ...base, toolCallId: "default-ttl" });
    createPendingApproval({
      ...base,
      conversationId: "conv-2",
      toolCallId: "long-ttl",
      ttlMs: SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
    });

    const res = await GET(
      new NextRequest("http://localhost:3000/api/permissions/pending"),
    ) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    const byConv = new Map(
      (body.pending as Array<{ conversationId: string; ttlMs: number }>).map((p) => [
        p.conversationId,
        p.ttlMs,
      ]),
    );
    expect(byConv.get("conv-1")).toBe(PERMISSION_APPROVAL_TTL_MS);
    expect(byConv.get("conv-2")).toBe(SUBAGENT_PERMISSION_APPROVAL_TTL_MS);
  });
});

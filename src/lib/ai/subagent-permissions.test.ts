import { describe, it, expect, afterEach } from "vitest";
import {
  resolveSubagentToolPermission,
  resolveSubagentAllowedTools,
  awaitSubagentApproval,
  reviveSubagent,
} from "./subagent-executor";
import {
  createSession,
  getSession,
  deleteSession,
  subscribeUserSubagentPermissions,
  updateSession,
} from "./subagent-session";
import { spawnSubagentSchema } from "./tools";
import { peekPendingApproval, resolvePendingApproval } from "@/lib/permissions-prompt";
import { SUBAGENT_PERMISSION_APPROVAL_TTL_MS } from "@/lib/permissions-core";

describe("resolveSubagentToolPermission", () => {
  it("applies the user's decision verbatim", () => {
    expect(resolveSubagentToolPermission("deny")).toBe("deny");
    expect(resolveSubagentToolPermission("allow")).toBe("allow");
    expect(resolveSubagentToolPermission("ask")).toBe("ask");
  });

  it("outside-workspace commands follow the user's rule, exactly like the main agent", () => {
    // The outside-workspace decision is taken by the permission engine
    // (command.outside_workspace rule), not by the subagent layer: a
    // subagent must never diverge from what the main agent would do.
    expect(resolveSubagentToolPermission("allow")).toBe("allow");
    expect(resolveSubagentToolPermission("deny")).toBe("deny");
  });

  it("gives the model no say in the subagent's permissions", () => {
    // The spawn schema has no permission knob: the worker is judged by the
    // user's settings, the model only chooses the toolset.
    const parsed = spawnSubagentSchema.safeParse({
      name: "worker",
      task: "run tests",
      permissionMode: "allow",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "permissionMode" in parsed.data).toBe(false);
    expect(
      Object.keys(spawnSubagentSchema.shape),
    ).not.toContain("permissionMode");
  });
});

describe("resolveSubagentAllowedTools", () => {
  it("defaults to all subagent-capable tools, including shell and edits", () => {
    const tools = resolveSubagentAllowedTools({});
    expect(tools).toContain("run_command");
    expect(tools).toContain("write_file");
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("spawn_subagent");
    expect(tools).not.toContain("get_subagent");
    expect(tools).not.toContain("message_subagent");
    expect(tools).not.toContain("ask_question");
  });

  it("narrows an explicit whitelist without widening it", () => {
    expect(resolveSubagentAllowedTools({ allowedTools: ["read_file", "grep"] })).toEqual([
      "read_file",
      "grep",
    ]);
  });

  it("drops orchestration tools from an explicit whitelist", () => {
    const tools = resolveSubagentAllowedTools({
      allowedTools: ["read_file", "spawn_subagent"],
    });
    expect(tools).toEqual(["read_file"]);
  });

  it("architect mode clips requested shell/write tools to read-only", () => {
    const tools = resolveSubagentAllowedTools({
      readOnly: true,
      allowedTools: ["run_command", "write_file", "read_file", "grep"],
    });
    expect(tools).toEqual(["read_file", "grep"]);
  });

  it("architect mode without an explicit list yields the read-only toolset", () => {
    const tools = resolveSubagentAllowedTools({ readOnly: true });
    expect(tools).toContain("read_file");
    expect(tools).toContain("grep");
    expect(tools).not.toContain("run_command");
    expect(tools).not.toContain("write_file");
  });
});

describe("awaitSubagentApproval", () => {
  const userId = "perm-user";
  const conversationId = "perm-conv";
  const created: string[] = [];

  function spawnWorker() {
    const session = createSession(userId, conversationId, {
      name: "worker",
      task: "run tests",
      systemPrompt: "sp",
      allowedTools: ["run_command"],
      provider: "openai",
      model: "gpt-4",
    });
    created.push(session.id);
    return session;
  }

  afterEach(() => {
    for (const id of created) deleteSession(userId, id);
    created.length = 0;
  });

  const tc = { id: "tc-1", name: "run_command", arguments: '{"command":"npm test"}' };

  it("registers a pending approval, flips to awaiting_permission, resolves allow", async () => {
    const session = spawnWorker();
    const promise = awaitSubagentApproval(
      session,
      session.id,
      tc,
      "command.run",
      new AbortController().signal,
    );

    const blocked = getSession(userId, session.id);
    expect(blocked?.status).toBe("awaiting_permission");
    const pending = blocked?.pendingPermission;
    expect(pending?.approvalId).toBeTruthy();
    expect(pending?.target).toContain("npm test");

    const dto = peekPendingApproval(userId, pending!.approvalId);
    expect(dto?.subagent).toEqual({ id: session.id, name: "worker" });

    expect(resolvePendingApproval(userId, pending!.approvalId, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");

    const after = getSession(userId, session.id);
    expect(after?.status).toBe("tool_exec");
    expect(after?.pendingPermission).toBeUndefined();
  });

  it("labels outside-workspace commands in the prompt target", async () => {
    const session = spawnWorker();
    const outsideTc = { id: "tc-2", name: "run_command", arguments: '{"command":"cd .. && ls"}' };
    const promise = awaitSubagentApproval(
      session,
      session.id,
      outsideTc,
      "command.outside_workspace",
      new AbortController().signal,
    );

    expect(getSession(userId, session.id)?.pendingPermission?.target).toBe(
      "run OUTSIDE WORKSPACE `cd .. && ls`",
    );

    resolvePendingApproval(
      userId,
      getSession(userId, session.id)!.pendingPermission!.approvalId,
      "deny",
    );
    await expect(promise).resolves.toBe("deny");
  });

  it("grants subagent approvals the long review window", async () => {
    const session = spawnWorker();
    const promise = awaitSubagentApproval(
      session,
      session.id,
      tc,
      "command.run",
      new AbortController().signal,
    );

    const pending = getSession(userId, session.id)?.pendingPermission;
    expect(pending?.ttlMs).toBe(SUBAGENT_PERMISSION_APPROVAL_TTL_MS);
    const dto = peekPendingApproval(userId, pending!.approvalId);
    expect(dto?.ttlMs).toBe(SUBAGENT_PERMISSION_APPROVAL_TTL_MS);

    resolvePendingApproval(userId, pending!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("publishes on the user-scoped permission channel with the blocked subagent id", async () => {
    const session = spawnWorker();
    const seen: Array<{ sessionId: string; conversationId: string }> = [];
    const unsubscribe = subscribeUserSubagentPermissions(userId, (sessionId, conversationId) => {
      seen.push({ sessionId, conversationId });
    });

    try {
      const promise = awaitSubagentApproval(
        session,
        session.id,
        tc,
        "command.run",
        new AbortController().signal,
      );
      expect(seen).toEqual([{ sessionId: session.id, conversationId }]);

      resolvePendingApproval(
        userId,
        getSession(userId, session.id)!.pendingPermission!.approvalId,
        "allow",
      );
      await promise;
    } finally {
      unsubscribe();
    }
  });

  it("resolves deny and clears its markers when aborted while waiting", async () => {
    const session = spawnWorker();
    const controller = new AbortController();
    const promise = awaitSubagentApproval(session, session.id, tc, "command.run", controller.signal);

    const approvalId = getSession(userId, session.id)!.pendingPermission!.approvalId;
    controller.abort();

    await expect(promise).resolves.toBe("deny");
    expect(peekPendingApproval(userId, approvalId)).toBeNull();
    const after = getSession(userId, session.id);
    expect(after?.status).toBe("tool_exec");
    expect(after?.pendingPermission).toBeUndefined();
  });
});

describe("reviveSubagent — the revived worker follows the parent's current mode", () => {
  const userId = "revive-user";
  const conversationId = "revive-conv";
  const created: string[] = [];

  afterEach(() => {
    for (const id of created) deleteSession(userId, id);
    created.length = 0;
  });

  function completedWorker(agentMode: "agent" | "architect") {
    const session = createSession(userId, conversationId, {
      name: "worker",
      task: "run tests",
      systemPrompt: "sp",
      allowedTools: resolveSubagentAllowedTools({ readOnly: agentMode === "architect" }),
      provider: "openai",
      model: "gpt-4",
      agentMode,
    });
    created.push(session.id);
    updateSession(session.id, { status: "completed", completedAt: Date.now() });
    return session;
  }

  it("clips an agent-mode worker to read-only when architect revives it", () => {
    const session = completedWorker("agent");
    expect(session.allowedTools).toContain("run_command");

    const out = reviveSubagent(userId, session.id, "keep going", { agentMode: "architect" });

    expect(out.status).toBe("resumed");
    const revived = getSession(userId, session.id)!;
    expect(revived.agentMode).toBe("architect");
    expect(revived.allowedTools).toContain("read_file");
    expect(revived.allowedTools).not.toContain("run_command");
    expect(revived.allowedTools).not.toContain("write_file");
  });

  it("keeps the parent's explicit delegation when agent mode revives a worker", () => {
    const session = createSession(userId, conversationId, {
      name: "narrow",
      task: "read only",
      systemPrompt: "sp",
      allowedTools: ["read_file"],
      provider: "openai",
      model: "gpt-4",
      agentMode: "agent",
    });
    created.push(session.id);
    updateSession(session.id, { status: "completed", completedAt: Date.now() });

    reviveSubagent(userId, session.id, "continue", { agentMode: "agent" });

    expect(getSession(userId, session.id)!.allowedTools).toEqual(["read_file"]);
  });
});

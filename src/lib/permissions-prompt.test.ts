/**
 * Tests for src/lib/permissions-prompt.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPendingApproval,
  getPendingForUser,
  peekPendingApproval,
  resolvePendingApproval,
  cancelPendingForConversation,
  __clearAll,
} from "./permissions-prompt";
import {
  PERMISSION_APPROVAL_TTL_MS,
  SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
} from "./permissions-core";

const base = {
  userId: "user-a",
  conversationId: "conv-1",
  messageId: "msg-1",
  toolCallId: "tc-1",
  toolName: "write_file",
  action: "file.write" as const,
  target: "write src/foo.ts",
  args: { path: "src/foo.ts" },
};

afterEach(() => {
  __clearAll();
  vi.restoreAllMocks();
});

describe("approval ids", () => {
  it("are pa_-prefixed 16-hex-char ids and unique across calls", () => {
    const a = createPendingApproval({ ...base, toolCallId: "a" });
    const b = createPendingApproval({ ...base, toolCallId: "b" });
    expect(a.id).toMatch(/^pa_[0-9a-f]{16}$/);
    expect(b.id).toMatch(/^pa_[0-9a-f]{16}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe("stale entry cleanup", () => {
  it("purges entries older than the TTL on the next approval request", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const stale = createPendingApproval({ ...base, toolCallId: "stale" });
    expect(getPendingForUser("user-a").length).toBe(1);

    // Advance past the 120s TTL, then insert a fresh entry — the stale one
    // must be purged and its promise denied, not left dangling.
    nowSpy.mockReturnValue(now + 121_000);
    const fresh = createPendingApproval({ ...base, conversationId: "conv-2", toolCallId: "fresh" });

    const remaining = getPendingForUser("user-a");
    expect(remaining.map((p) => p.id)).toEqual([fresh.id]);
    expect(peekPendingApproval("user-a", stale.id)).toBeNull();
    await expect(stale.promise).resolves.toBe("deny");
  });

  it("keeps entries that are still within the TTL", () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const a = createPendingApproval({ ...base, toolCallId: "a" });
    nowSpy.mockReturnValue(now + 119_000);
    const b = createPendingApproval({ ...base, conversationId: "conv-2", toolCallId: "b" });

    const ids = getPendingForUser("user-a").map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(peekPendingApproval("user-a", a.id)).not.toBeNull();
    expect(peekPendingApproval("user-a", b.id)).not.toBeNull();
  });

  it("purges expired entries on read (list and peek) without a new approval", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const stale = createPendingApproval({ ...base, toolCallId: "stale-read" });
    nowSpy.mockReturnValue(now + 121_000);

    expect(getPendingForUser("user-a")).toEqual([]);
    expect(peekPendingApproval("user-a", stale.id)).toBeNull();
    await expect(stale.promise).resolves.toBe("deny");
  });
});

describe("per-entry TTL", () => {
  it("reports the default TTL in the DTO", () => {
    const p = createPendingApproval({ ...base, toolCallId: "ttl-default" });
    expect(peekPendingApproval("user-a", p.id)?.ttlMs).toBe(PERMISSION_APPROVAL_TTL_MS);
  });

  it("keeps a long-TTL (subagent) entry resolvable past the default window", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const long = createPendingApproval({
      ...base,
      toolCallId: "ttl-long",
      ttlMs: SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
    });
    expect(peekPendingApproval("user-a", long.id)?.ttlMs).toBe(
      SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
    );

    nowSpy.mockReturnValue(now + PERMISSION_APPROVAL_TTL_MS + 1_000);
    expect(peekPendingApproval("user-a", long.id)).not.toBeNull();
    expect(resolvePendingApproval("user-a", long.id, "allow")).toBe(true);
    await expect(long.promise).resolves.toBe("allow");
  });

  it("purges a long-TTL entry once its own window closes", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const long = createPendingApproval({
      ...base,
      toolCallId: "ttl-long-expire",
      ttlMs: SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
    });

    nowSpy.mockReturnValue(now + SUBAGENT_PERMISSION_APPROVAL_TTL_MS + 1_000);
    expect(peekPendingApproval("user-a", long.id)).toBeNull();
    await expect(long.promise).resolves.toBe("deny");
  });
});

describe("resolution hardening", () => {
  it("rejects an unknown decision without settling the entry", () => {
    const pending = createPendingApproval({ ...base, toolCallId: "bad-decision" });

    expect(
      resolvePendingApproval("user-a", pending.id, "maybe" as never),
    ).toBe(false);
    expect(peekPendingApproval("user-a", pending.id)).not.toBeNull();
  });

  it("rejects a decision arriving after the TTL and reports the entry as gone", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const pending = createPendingApproval({ ...base, toolCallId: "expired" });

    nowSpy.mockReturnValue(now + 121_000);

    expect(resolvePendingApproval("user-a", pending.id, "allow")).toBe(false);
    expect(peekPendingApproval("user-a", pending.id)).toBeNull();
    await expect(pending.promise).resolves.toBe("deny");
  });

  it("rejects resolution by a different user", () => {
    const pending = createPendingApproval({ ...base, toolCallId: "owned" });
    expect(resolvePendingApproval("user-b", pending.id, "allow")).toBe(false);
  });

  it("preserves subagent approvals when excludeSubagents is true", async () => {
    const mainPrompt = createPendingApproval({
      ...base,
      toolCallId: "main-tc-1",
    });
    const subagentPrompt = createPendingApproval({
      ...base,
      toolCallId: "sub-tc-1",
      subagent: { id: "sa-1", name: "Worker" },
      ttlMs: SUBAGENT_PERMISSION_APPROVAL_TTL_MS,
    });

    cancelPendingForConversation(base.conversationId, { excludeSubagents: true });

    expect(peekPendingApproval("user-a", mainPrompt.id)).toBeNull();
    await expect(mainPrompt.promise).resolves.toBe("deny");

    expect(peekPendingApproval("user-a", subagentPrompt.id)).not.toBeNull();
  });
});

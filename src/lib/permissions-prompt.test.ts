/**
 * Tests for src/lib/permissions-prompt.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPendingApproval,
  getPendingForUser,
  peekPendingApproval,
  __clearAll,
} from "./permissions-prompt";

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
});

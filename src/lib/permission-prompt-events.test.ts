/**
 * Tests for src/lib/permission-prompt-events — runtime validation of
 * untrusted permission payloads (SSE frames and recovery API responses).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_PERMISSION_FIELD_CHARS,
  MAX_PERMISSION_ID_CHARS,
  MAX_PERMISSION_TARGET_CHARS,
  MAX_PERMISSION_TTL_MS,
  parsePendingApproval,
  parsePermissionPromptEvent,
  parseSubagentPermissionEvent,
} from "./permission-prompt-events";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePermissionPromptEvent", () => {
  it("parses a fully-populated SSE frame", () => {
    const parsed = parsePermissionPromptEvent({
      approvalId: "pa_0123456789abcdef",
      action: "command.run",
      target: "run `npm test`",
      toolCallId: "tc-1",
      toolName: "run_command",
      createdAt: 1_700_000_000_000,
    });

    expect(parsed).toEqual({
      approvalId: "pa_0123456789abcdef",
      action: "command.run",
      target: "run `npm test`",
      toolCallId: "tc-1",
      toolName: "run_command",
      createdAt: 1_700_000_000_000,
    });
  });

  it("rejects non-objects, arrays, and payloads without an approvalId", () => {
    expect(parsePermissionPromptEvent(null)).toBeNull();
    expect(parsePermissionPromptEvent("frame")).toBeNull();
    expect(parsePermissionPromptEvent(["pa_1"])).toBeNull();
    expect(parsePermissionPromptEvent({})).toBeNull();
    expect(parsePermissionPromptEvent({ approvalId: "   " })).toBeNull();
    expect(parsePermissionPromptEvent({ approvalId: 42 })).toBeNull();
  });

  it("falls back to toolName (then action) when action/target are missing", () => {
    const byToolName = parsePermissionPromptEvent({
      approvalId: "pa_aaaaaaaaaaaaaaaa",
      toolName: "write_file",
    });
    expect(byToolName?.action).toBe("write_file");
    expect(byToolName?.target).toBe("write_file");

    const noHints = parsePermissionPromptEvent({ approvalId: "pa_bbbbbbbbbbbbbbbb" });
    expect(noHints?.action).toBe("action");
    expect(noHints?.target).toBe("action");
  });

  it("clamps oversized fields to their bounds", () => {
    const parsed = parsePermissionPromptEvent({
      approvalId: "pa_aaaaaaaaaaaaaaaa",
      action: "a".repeat(MAX_PERMISSION_FIELD_CHARS + 50),
      target: "t".repeat(MAX_PERMISSION_TARGET_CHARS + 50),
      toolCallId: "c".repeat(MAX_PERMISSION_FIELD_CHARS + 50),
    });

    expect(parsed?.approvalId).toBe("pa_aaaaaaaaaaaaaaaa");
    expect(parsed?.action).toHaveLength(MAX_PERMISSION_FIELD_CHARS);
    expect(parsed?.target).toHaveLength(MAX_PERMISSION_TARGET_CHARS);
    expect(parsed?.toolCallId).toHaveLength(MAX_PERMISSION_FIELD_CHARS);
  });

  it("rejects an approval id the resolve endpoint would not accept", () => {
    // An id outside the server's shape would render a card that can never be
    // answered — every POST would fail and the card would block the composer.
    expect(parsePermissionPromptEvent({ approvalId: "not-an-approval-id" })).toBeNull();
    expect(parsePermissionPromptEvent({ approvalId: "pa_short" })).toBeNull();
    expect(parsePermissionPromptEvent({ approvalId: "pa_0123456789ABCDEF" })).toBeNull();
  });

  it("carries a valid ttlMs, clamps oversized ones, and drops garbage", () => {
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", ttlMs: 1_800_000 })?.ttlMs,
    ).toBe(1_800_000);
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", ttlMs: MAX_PERMISSION_TTL_MS * 10 })
        ?.ttlMs,
    ).toBe(MAX_PERMISSION_TTL_MS);
    expect(parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa" })?.ttlMs).toBeUndefined();
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", ttlMs: 0 })?.ttlMs,
    ).toBeUndefined();
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", ttlMs: Number.NaN })?.ttlMs,
    ).toBeUndefined();
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", ttlMs: "1800000" })?.ttlMs,
    ).toBeUndefined();
  });

  it("defaults a missing or invalid createdAt to the current time", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_234_567);

    expect(parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa" })?.createdAt).toBe(1_234_567);
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", createdAt: -5 })?.createdAt,
    ).toBe(1_234_567);
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", createdAt: Number.NaN })?.createdAt,
    ).toBe(1_234_567);
    expect(
      parsePermissionPromptEvent({ approvalId: "pa_aaaaaaaaaaaaaaaa", createdAt: "1700" })?.createdAt,
    ).toBe(1_234_567);
  });

  it("clamps future timestamps to absorb small clock skew without unbounded TTLs", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const parsed = parsePermissionPromptEvent({
      approvalId: "pa_aaaaaaaaaaaaaaaa",
      createdAt: now + 50_000,
    });
    expect(parsed?.createdAt).toBe(now + 5000);
  });
});

describe("parseSubagentPermissionEvent", () => {
  const permission = {
    approvalId: "pa_0123456789abcdef",
    action: "file.write",
    target: "write src/a.ts",
    toolCallId: "tc-9",
    toolName: "write_file",
    createdAt: 1_700_000_000_000,
  };

  it("parses a live subagent permission frame", () => {
    const parsed = parseSubagentPermissionEvent({
      sessionId: "sa-1",
      name: "Researcher",
      permission,
    });

    expect(parsed?.sessionId).toBe("sa-1");
    expect(parsed?.name).toBe("Researcher");
    expect(parsed?.permission.approvalId).toBe("pa_0123456789abcdef");
  });

  it("accepts a missing name and rejects malformed frames", () => {
    expect(
      parseSubagentPermissionEvent({ sessionId: "sa-1", permission })?.name,
    ).toBeUndefined();
    expect(parseSubagentPermissionEvent({ permission })).toBeNull();
    expect(parseSubagentPermissionEvent({ sessionId: "sa-1" })).toBeNull();
    expect(
      parseSubagentPermissionEvent({ sessionId: "sa-1", permission: { approvalId: "  " } }),
    ).toBeNull();
  });
});

describe("parsePendingApproval", () => {
  it("parses a recovery API DTO (id field) and extracts the subagent", () => {
    const parsed = parsePendingApproval({
      id: "pa_0123456789abcdef",
      conversationId: "conv-1",
      messageId: "msg-1",
      toolCallId: "tc-1",
      toolName: "run_command",
      action: "command.run",
      target: "git status",
      args: {},
      createdAt: 1_700_000_000_000,
      ttlMs: 1_800_000,
      subagent: { id: "sa-1", name: "Scout" },
    });

    expect(parsed).toEqual({
      approvalId: "pa_0123456789abcdef",
      conversationId: "conv-1",
      action: "command.run",
      target: "git status",
      toolCallId: "tc-1",
      toolName: "run_command",
      createdAt: 1_700_000_000_000,
      ttlMs: 1_800_000,
      subagentId: "sa-1",
      subagentName: "Scout",
    });
  });

  it("requires a conversationId and a parseable id", () => {
    expect(parsePendingApproval({ id: "pa_1" })).toBeNull();
    expect(parsePendingApproval({ conversationId: "conv-1" })).toBeNull();
    expect(parsePendingApproval({ id: "pa_1", conversationId: "  " })).toBeNull();
    expect(parsePendingApproval(null)).toBeNull();
  });

  it("degrades a malformed subagent object to undefined fields", () => {
    const parsed = parsePendingApproval({
      id: "pa_1",
      conversationId: "conv-1",
      subagent: "Scout",
    });

    expect(parsed?.subagentId).toBeUndefined();
    expect(parsed?.subagentName).toBeUndefined();
  });
});

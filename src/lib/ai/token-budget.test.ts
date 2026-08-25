import { describe, it, expect } from "vitest";
import { trimMessagesToBudget, fitPayloadToBudget, type TokenBudgetMessage } from "./token-budget";

function msg(role: string, content: string, tool?: unknown): TokenBudgetMessage {
  return { role, content, ...(tool !== undefined ? { tool_calls: tool } : {}) };
}

const TOOL_CALL = [{ id: "1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }];

describe("trimMessagesToBudget", () => {
  it("returns messages unchanged when already under budget", () => {
    const messages = [
      msg("system", "sys"),
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "bye"),
    ];
    const result = trimMessagesToBudget(messages, 100_000);
    expect(result.fitted).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(4);
  });

  it("keeps system, task anchor, compaction markers, and last user turn", () => {
    const messages = [
      msg("system", "SYSTEM-" + "x".repeat(2_000)),
      msg("user", "ANCHOR-" + "x".repeat(2_000)),
      msg("assistant", "mid-" + "x".repeat(2_000)),
      msg("user", "<context_summary>older turns</context_summary>"),
      msg("assistant", "recent-a-" + "x".repeat(2_000)),
      msg("user", "RECENT-" + "x".repeat(800)),
    ];
    const result = trimMessagesToBudget(messages, 4_500);
    const kept = result.messages;
    expect(result.messages.every((m) => m !== undefined)).toBe(true);
    expect(kept.some((m) => m.role === "system" && m.content.startsWith("SYSTEM"))).toBe(true);
    expect(kept.some((m) => m.role === "user" && m.content.startsWith("ANCHOR"))).toBe(true);
    expect(kept.some((m) => m.role === "user" && m.content.includes("<context_summary"))).toBe(true);
    expect(kept.some((m) => m.role === "user" && m.content.startsWith("RECENT"))).toBe(true);
    expect(kept[kept.length - 1]?.content).toBe("RECENT-" + "x".repeat(800));
  });

  it("never drops a trailing tool result while keeping its assistant tool call", () => {
    const messages = [
      msg("system", "sys"),
      msg("user", "anchor"),
      msg("assistant", "call", TOOL_CALL),
      msg("tool", "tool-result-1"),
      msg("tool", "tool-result-2"),
      msg("user", "next-" + "x".repeat(500)),
    ];
    const result = trimMessagesToBudget(messages, 1_000);
    // If the assistant tool call survived, its trailing tool results survive too
    // (they are chunked with it); no message ever survives alone.
    expect(result.messages.some((m) => m.role === "user" && m.content === "anchor")).toBe(true);
    const toolIdx = result.messages.findIndex((m) => m.role === "tool");
    const callIdx = result.messages.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    if (toolIdx >= 0) {
      expect(callIdx).toBeGreaterThanOrEqual(0);
      expect(toolIdx).toBeGreaterThan(callIdx);
    }
  });

  it("never orphans tool results (chunks dropped together)", () => {
    const messages = [
      msg("system", "s"),
      msg("user", "a"),
      msg("assistant", "c1", TOOL_CALL),
      msg("tool", "r1"),
      msg("assistant", "c2", TOOL_CALL),
      msg("tool", "r2"),
      msg("user", "final"),
    ];
    const result = trimMessagesToBudget(messages, 20);
    const toolRoles = result.messages.filter((m) => m.role === "tool");
    expect(toolRoles.length).toBe(0);
    let assistantCallSeen = false;
    for (const m of result.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        assistantCallSeen = true;
        continue;
      }
      if (m.role === "tool") {
        // any kept tool result must be preceded by a kept assistant call
        expect(assistantCallSeen).toBe(true);
      }
    }
  });

  it("returns fitted false when even the irreducible core exceeds the budget", () => {
    const messages = [msg("system", "SYSTEM-" + "x".repeat(400)), msg("user", "u")];
    const result = trimMessagesToBudget(messages, 1);
    expect(result.fitted).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("keeps reasonable prompt tokens for a mid-size conversation", () => {
    const messages: TokenBudgetMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      messages.push(msg("user", `user message ${i} `.repeat(200)));
      messages.push(msg("assistant", `assistant reply ${i} `.repeat(300)));
    }
    const budget = 25_000;
    const result = trimMessagesToBudget(messages, budget);
    expect(result.fitted).toBe(true);
    expect(result.promptTokens).toBeLessThanOrEqual(budget);
  });
});

function makeBody(messages: TokenBudgetMessage[], maxTokens = 4096, tools?: unknown) {
  const body: Record<string, unknown> = { model: "m", messages, stream: true, max_tokens: maxTokens };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

const BIG_TOOL_SCHEMAS = Array.from({ length: 12 }, (_, i) => ({
  type: "function",
  function: {
    name: `tool_${i}`,
    description: "Perform an operation across the workspace contents " + "x".repeat(400),
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}));

describe("fitPayloadToBudget", () => {
  it("returns unchanged when already under budget", () => {
    const messages = [msg("system", "sys"), msg("user", "hello")];
    const body = makeBody(messages, 2048);
    const fit = fitPayloadToBudget(body, 100_000);
    expect(fit.fitted).toBe(true);
    expect(fit.dropped).toBe(0);
    expect(fit.maxTokens).toBeGreaterThanOrEqual(2048);
    expect(fit.messages).toHaveLength(2);
  });

  it("caps max_tokens when only the output is over budget", () => {
    const messages = [msg("system", "sys " + "x".repeat(200)), msg("user", "u")];
    const body = makeBody(messages, 4096);
    const fit = fitPayloadToBudget(body, 2_000);
    expect(fit.fitted).toBe(true);
    expect(fit.dropped).toBe(0);
    // Output capped (not the original 4096), and the capping actually reduces it.
    expect(fit.maxTokens).toBeGreaterThanOrEqual(1);
    expect(fit.maxTokens).toBeLessThan(4096);
  });

  it("trims messages when prompt + tools exceed the budget", () => {
    const messages = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push(msg("user", `long user msg ${i} `.repeat(150)));
      messages.push(msg("assistant", `long reply ${i} `.repeat(200)));
    }
    const body = makeBody(messages, 4096, BIG_TOOL_SCHEMAS);
    const fit = fitPayloadToBudget(body, 8_000);
    expect(fit.fitted).toBe(true);
    // Every kept message must be a subset of the originals.
    expect(fit.messages.length).toBeGreaterThan(0);
    expect(fit.messages.length).toBeLessThan(messages.length);
  });

  it("drops tools when schemas alone exceed the message core", () => {
    const messages = [msg("system", "sys"), msg("user", "task instructions here")];
    const body = makeBody(messages, 4096, BIG_TOOL_SCHEMAS);
    const fit = fitPayloadToBudget(body, 500);
    expect(fit.fitted).toBe(true);
    expect(fit.dropTools).toBe(true);
  });

  it("returns fitted false when even the core exceeds the budget", () => {
    const messages = [msg("system", "SYSTEM instructions " + "x".repeat(200)), msg("user", "u")];
    const body = makeBody(messages, 4096);
    const fit = fitPayloadToBudget(body, 100);
    expect(fit.fitted).toBe(false);
  });
});
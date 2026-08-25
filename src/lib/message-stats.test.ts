import { describe, expect, it } from "vitest";
import { aggregateMessageStats } from "@/lib/message-stats";
import type { MessageStatsSource, MessageStatsProvider } from "@/lib/message-stats";

const PROVIDERS: MessageStatsProvider[] = [
  {
    id: "openai",
    models: [
      { id: "gpt-4o", pricing: { in: 3, out: 15 } },
      { id: "gpt-4o-mini", pricing: { in: 0.15, out: 0.6 } },
    ],
  },
  { id: "unpriced", models: [{ id: "model-x" }] },
];

function msg(partial: Partial<MessageStatsSource>): MessageStatsSource {
  return { id: `m-${Math.random()}`, ...partial };
}

describe("aggregateMessageStats", () => {
  it("sums token usage across messages, ignoring nulls", () => {
    const stats = aggregateMessageStats(
      [
        msg({ tokensIn: 100, tokensOut: 50, cacheReads: 10, cacheWrites: 5 }),
        msg({ tokensIn: null, tokensOut: 25, cacheReads: 0 }),
        msg({}),
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.tokensIn).toBe(100);
    expect(stats.tokensOut).toBe(75);
    expect(stats.totalTokens).toBe(175);
    expect(stats.cacheReadsTotal).toBe(10);
    expect(stats.cacheWritesTotal).toBe(5);
  });

  it("keeps the most recent positive promptTokens as the context baseline", () => {
    const stats = aggregateMessageStats(
      [msg({ promptTokens: 500 }), msg({ promptTokens: 0 }), msg({})],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.lastPromptTokens).toBe(500);
    expect(stats.lastPromptTokensEstimated).toBe(false);
  });

  it("flags the context baseline as estimated when the last reading was an estimate", () => {
    const stats = aggregateMessageStats(
      [
        msg({ promptTokens: 500 }),
        msg({ promptTokens: 4000, promptTokensEstimated: true }),
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.lastPromptTokens).toBe(4000);
    expect(stats.lastPromptTokensEstimated).toBe(true);
  });

  it("clears the estimated flag when a later measured reading arrives", () => {
    // Mirrors the executor contract: a pre-stream estimate (estimated:
    // true) is emitted per iteration, then the provider's measured usage
    // event overwrites the message with estimated: false — the ring must
    // snap back to "measured" even though an estimate appeared earlier.
    const stats = aggregateMessageStats(
      [
        msg({ promptTokens: 3000, promptTokensEstimated: true }),
        msg({ promptTokens: 4100, promptTokensEstimated: false }),
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.lastPromptTokens).toBe(4100);
    expect(stats.lastPromptTokensEstimated).toBe(false);
  });

  it("ignores an estimated reading when its promptTokens is zero", () => {
    // Persisted-estimate zeroing: `aggregateMessageStats` only adopts
    // positive readings, so a zeroed estimate must not clobber the last
    // measured baseline nor flip the provenance flag.
    const stats = aggregateMessageStats(
      [
        msg({ promptTokens: 4100, promptTokensEstimated: false }),
        msg({ promptTokens: 0, promptTokensEstimated: true }),
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.lastPromptTokens).toBe(4100);
    expect(stats.lastPromptTokensEstimated).toBe(false);
  });

  it("returns zeros and costUnknown=false for an empty list", () => {
    const stats = aggregateMessageStats([], "openai", "gpt-4o", PROVIDERS);
    expect(stats).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      lastPromptTokens: 0,
      lastPromptTokensEstimated: false,
      cacheReadsTotal: 0,
      cacheWritesTotal: 0,
      costValue: 0,
      costUnknown: false,
    });
  });

  it("prices tokens with the per-message provider/model, falling back to the active selection", () => {
    const stats = aggregateMessageStats(
      [
        msg({ tokensIn: 1_000_000, tokensOut: 0 }), // falls back to openai/gpt-4o → $3
        msg({ provider: "openai", model: "gpt-4o-mini", tokensIn: 1_000_000 }), // $0.15
        msg({ provider: "openai", model: "gpt-4o-mini", tokensOut: 1_000_000 }), // $0.60
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.costValue).toBeCloseTo(3.75);
    expect(stats.costUnknown).toBe(false);
  });

  it("reports costUnknown when a measured message has no applicable rate and nothing priced", () => {
    const stats = aggregateMessageStats(
      [msg({ provider: "unpriced", model: "model-x", tokensIn: 100 })],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.costValue).toBe(0);
    expect(stats.costUnknown).toBe(true);
  });

  it("does not report costUnknown when a priced message covers the unknown one", () => {
    const stats = aggregateMessageStats(
      [
        msg({ provider: "unpriced", model: "model-x", tokensIn: 100 }),
        msg({ provider: "openai", model: "gpt-4o", tokensIn: 1_000_000 }),
      ],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.costValue).toBeCloseTo(3);
    expect(stats.costUnknown).toBe(false);
  });

  it("ignores an unknown provider when the message has no measured tokens", () => {
    const stats = aggregateMessageStats(
      [msg({ provider: "unpriced", model: "model-x" })],
      "openai",
      "gpt-4o",
      PROVIDERS,
    );
    expect(stats.costValue).toBe(0);
    expect(stats.costUnknown).toBe(false);
  });
});
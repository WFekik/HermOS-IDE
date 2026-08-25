import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  estimateMessageTokens,
  findCompactionCutIndex,
  truncateHistory,
  pruneForOverflow,
  pruneOldToolOutputs,
  compactConversation,
  buildCompactionPrompt,
} from "@/lib/ai/context";
import { trimMessagesToBudget } from "@/lib/ai/token-budget";
import {
  measure,
  assertFast,
  expectScaling,
  makeReporter,
  warmBpe,
  filler,
} from "./harness";

/**
 * Budget-based harness for the agent core: token accounting, compaction
 * cut selection, truncation, pruning, compactions and request budget
 * trimming. Covers the paths the executor hits on every overflow window.
 *
 * Run: npm run perf
 */

const rows = makeReporter("bench-agent-core");

interface BenchMsg {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: string;
  thinking?: string;
}

function mkHistory(count: number, seed = 0): BenchMsg[] {
  const msgs: BenchMsg[] = [];
  msgs.push({ role: "system", content: `SYSTEM ${seed} ` + filler(4000) });
  msgs.push({ role: "user", content: `ANCHOR ${seed} ` + filler(2000) });
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "assistant", content: `turn ${i} reasoning ${seed} ` + filler(900, i) });
    msgs.push({ role: "user", content: `user ${i} asks about x ${seed} ` + filler(700, i) });
  }
  return msgs;
}

/** turn count -> ~3 messages per turn (assistant w/ toolCalls, tool, user). */
function mkToolHistory(turns: number): BenchMsg[] {
  const msgs: BenchMsg[] = [];
  msgs.push({ role: "system", content: "SYSTEM " + filler(2000) });
  for (let i = 0; i < turns; i++) {
    const args = JSON.stringify({ path: `/repo/src/mod-${i}.ts`, content: filler(400, i), start: i, end: i + 2 });
    msgs.push({
      role: "assistant",
      content: `I'll edit module ${i}. ${filler(200, i)}`,
      thinking: filler(120, i),
      toolCalls: JSON.stringify([{ name: "edit_file", arguments: args, id: `call_${i}` }]),
    });
    msgs.push({ role: "tool", toolCallId: `call_${i}`, content: `edit applied ${filler(300, i)}` });
    msgs.push({ role: "user", content: `continue ${i} ${filler(150, i)}` });
  }
  return msgs;
}

describe("perf: agent core — message token accounting", () => {
  beforeAll(warmBpe);

  it("estimateMessageTokens on 60 realistic assistant messages", () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      role: "assistant",
      content: filler(1200, i),
      thinking: filler(300, i),
      toolCalls: JSON.stringify([{ name: "write_file", arguments: JSON.stringify({ path: `/repo/a-${i}.ts`, content: filler(800, i) }) }]),
      attachments: JSON.stringify([{ name: `shot-${i}.png`, type: "image/png", size: 12345 }]),
    }));
    const sample = measure(() => {
      let acc = 0;
      for (const m of msgs) acc += estimateMessageTokens(m as never);
      if (acc < 1000) throw new Error("estimates collapsed");
    });
    assertFast(sample, 1000, "estimateMessageTokens × 60");
    rows.record("token accounting", "estimateMessageTokens × 60 msgs", sample, 1000);
  });
});

describe("perf: agent core — compaction cuts", () => {
  beforeAll(warmBpe);
  const toolHistory = mkToolHistory(640); // ~1922 messages

  it("findCompactionCutIndex on a ~1900-message tool-heavy history", () => {
    const sample = measure(() => {
      const cut = findCompactionCutIndex(toolHistory, 8_000);
      // Preserving only 8k tokens from a ~400k-token history must cut deep
      // into the middle while still keeping the most recent messages.
      if (!(cut > 100 && cut < toolHistory.length - 1)) throw new Error(`cut out of range: ${cut}`);
    });
    assertFast(sample, 1500, "findCompactionCutIndex");
    rows.record("compaction", "findCompactionCutIndex ~1900 msgs", sample, 1500);
  });
});

describe("perf: agent core — truncation & pruning", () => {
  beforeAll(warmBpe);
  const small = mkHistory(250); // 502 messages
  const huge = mkHistory(1400); // 2802 messages

  const TRUNC_OPTS = { contextWindow: 128_000, maxOutputTokens: 8192, systemTokens: 1000 };

  it("truncateHistory short-circuits when the window fits (no-op path)", () => {
    const fitting = mkHistory(120); // ~242 messages, ~50k tokens
    const sample = measure(() => {
      const out = truncateHistory(fitting, "SYSTEM PROMPT", { ...TRUNC_OPTS, contextWindow: 1_000_000 });
      if (out.messages?.length !== fitting.length) throw new Error("no-op path mutated history");
    });
    assertFast(sample, 30, "truncateHistory no-op path");
    rows.record("truncation", "truncateHistory no-op (fits window)", sample, 30);
  });

  it("truncateHistory scales linearly with history size", () => {
    // Nonced histories keep BPE cold in every timed run so the guard sees
    // the real per-call envelope (structural + token estimation).
    let nonce = 0;
    const sampleFor = (count: number) =>
      measure(() => {
        truncateHistory(mkHistory(count, nonce++), "SYSTEM PROMPT", TRUNC_OPTS);
      }, { warmup: 1, runs: 3 }).min;
    const msMid = sampleFor(500);
    const msLarge = sampleFor(1000);
    expectScaling([{ size: 1002, ms: msMid }, { size: 2002, ms: msLarge }], {
      label: "truncateHistory (cold envelope)",
      maxGrowthPerDouble: 4,
    });
    const result = truncateHistory(mkHistory(1000), "SYSTEM PROMPT", TRUNC_OPTS);
    expect(result.messages.length).toBeGreaterThan(0);
    rows.record("truncation", "truncateHistory scaling cold (~1k vs ~2k msgs)", { min: msLarge, p50: msLarge, max: msLarge, runs: 3 });
  });

  it("pruneForOverflow on a ~2800-message history", () => {
    const sample = measure(() => {
      const out = pruneForOverflow(huge);
      if (!out || out.length === 0) throw new Error("prune returned nothing");
    });
    assertFast(sample, 2500, "pruneForOverflow");
    rows.record("truncation", "pruneForOverflow ~2800 msgs", sample, 2500);
  });

  it("pruneOldToolOutputs scales linearly with history size", () => {
    const toToolish = (msgs: BenchMsg[]): BenchMsg[] =>
      msgs.map((m, i) => (i % 4 === 0 ? { ...m, role: "tool", toolCallId: `call-${i}` } : m));
    let nonce = 0;
    const sampleFor = (count: number) =>
      measure(() => {
        pruneOldToolOutputs(toToolish(mkHistory(count, nonce++)), { contextWindow: 128_000 });
      }, { warmup: 1, runs: 3 }).min;
    const msMid = sampleFor(500);
    const msLarge = sampleFor(1000);
    expectScaling([{ size: 1002, ms: msMid }, { size: 2002, ms: msLarge }], {
      label: "pruneOldToolOutputs (cold envelope)",
      maxGrowthPerDouble: 4,
    });
    rows.record("truncation", "pruneOldToolOutputs scaling cold (~1k vs ~2k msgs)", { min: msLarge, p50: msLarge, max: msLarge, runs: 3 });
  });
});

describe("perf: agent core — compaction fallback & request budget", () => {
  beforeAll(warmBpe);

  it("compactConversation regex fallback on ~800 messages", () => {
    const history = mkHistory(380); // ~762 messages
    const sample = measure(() => {
      const summary = compactConversation(history);
      if (summary.length < 200) throw new Error("fallback produced no summary");
    });
    assertFast(sample, 3000, "compactConversation fallback");
    rows.record("compaction", "compactConversation fallback ~760 msgs", sample, 3000);
  });

  it("buildCompactionPrompt with a 1MB transcript", () => {
    const transcript = Array.from({ length: 120 }, (_, i) => `${filler(8000, i)}\n`).join("");
    const sample = measure(() => {
      const prompt = buildCompactionPrompt({ transcript, previousSummary: filler(2000, 7) });
      if (prompt.length < transcript.length) throw new Error("prompt dropped transcript");
    });
    assertFast(sample, 100, "buildCompactionPrompt 1MB");
    rows.record("compaction", "buildCompactionPrompt 1MB transcript", sample, 100);
  });

  it("trimMessagesToBudget on an over-budget 400-message conversation", () => {
    const msgs = mkHistory(199); // 400 messages, ~450k tokens
    const sample = measure(() => {
      const out = trimMessagesToBudget(msgs, 20_000);
      if (!out.fitted) throw new Error("irreducible core exceeded budget");
      if (out.messages.length >= msgs.length) throw new Error("did not trim");
    });
    assertFast(sample, 1500, "trimMessagesToBudget 400 msgs");
    rows.record("budget", "trimMessagesToBudget 400 msgs @ 20k", sample, 1500);
  });
});

afterAll(() => rows.report());
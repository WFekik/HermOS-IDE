import { describe, it, expect, beforeAll } from "vitest";
import { performance } from "node:perf_hooks";
import {
  estimateTokens,
  selectCompactionTail,
  truncateHistory,
  pruneOldToolOutputs,
  isContextOverflow,
} from "@/lib/ai/context";
import { parseTextToolCalls, cleanContent } from "@/lib/ai/tool-call-parser";
import { sanitizeContent } from "@/lib/sanitize-content";
import { useAppStore, type LiveToolCall, type UIMessage } from "@/stores/app-store";
import {
  mergeSegments,
  groupFlatToolCalls,
  groupSegmentItems,
} from "@/components/ide/message-renderer";

/**
 * Budget-based performance harness.
 *
 * Run with:  npm run perf
 * Budgets are ~5-10x the observed steady-state cost so CI variance (parallel
 * load, cold caches) never flakes, while a real regression (e.g. an
 * accidental O(n²) in the streaming path, a BPE re-encode per delta, a
 * dropped memo) will breach them.
 *
 * The suite runs serially (`--no-file-parallelism`) for stable timings.
 */

const encoder = { warmed: false };

// js-tiktoken BPE is quadratic on homogeneous runs (a 4KB run of one char
// costs ~1.5s), so fixtures use mixed prose to keep measurements linear.
const SNIPPET =
  "The quick brown fox jumps over the lazy dog, refactoring the build pipeline while reviewing pull requests and running the test suite in parallel. ";
function filler(n: number, seed = 0): string {
  const s = SNIPPET.repeat(Math.ceil(n / SNIPPET.length)).slice(0, n);
  return seed ? `${s} ${seed}` : s;
}

function heat(): void {
  // Warm the BPE encoder + caches BEFORE any measurement. The first
  // estimateTokens call pays the dictionary compile; steady-state is what
  // the harness guards.
  if (encoder.warmed) return;
  for (let i = 0; i < 200; i++) {
    estimateTokens(`warmup ${i} "padding":"${filler(512, i)}"`);
  }
  encoder.warmed = true;
}

/** Best-of-N elapsed ms for `fn` (warmup runs first, then timed runs). */
function measureBest(fn: () => void, opts: { warmup?: number; runs?: number } = {}): number {
  const warmup = opts.warmup ?? 2;
  const runs = opts.runs ?? 5;
  for (let i = 0; i < warmup; i++) fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const elapsed = performance.now() - t0;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

function mkHistory(count: number): Array<{ role: string; content: string; toolCallId?: string }> {
  const msgs: Array<{ role: string; content: string; toolCallId?: string }> = [];
  msgs.push({ role: "system", content: "SYSTEM " + filler(4000) });
  msgs.push({ role: "user", content: "ANCHOR " + filler(2000) });
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "assistant", content: `turn ${i} reasoning ${filler(900, i)}` });
    msgs.push({
      role: "user",
      content: `user ${i} asks about x ${filler(700, i)}`,
    });
  }
  return msgs;
}

describe("perf: token estimation", () => {
  beforeAll(heat);

  it("BPE estimate of 400 distinct ~4KB strings stays bounded", () => {
    const strings = Array.from({ length: 400 }, (_, i) => `payload ${i} ${filler(4096, i)}`);
    const ms = measureBest(() => {
      let acc = 0;
      for (const s of strings) acc += estimateTokens(s);
      if (acc < 0) throw new Error("unreachable");
    }, { warmup: 1, runs: 3 });
    // Steady-state cl100k BPE on 400×4KB ≈ 1.6MB total; ~50-250ms observed.
    expect(ms).toBeLessThan(2000);
    expect(ms).toBeGreaterThan(0);
  });

  it("cached (hot) estimates are near-free", () => {
    const hot = ["prompt " + filler(6000), "tool schema " + filler(3000)];
    estimateTokens(hot[0]);
    estimateTokens(hot[1]);
    const ms = measureBest(() => {
      let acc = 0;
      for (let i = 0; i < 200; i++) acc += estimateTokens(hot[i % 2]);
      if (acc < 0) throw new Error("unreachable");
    }, { warmup: 1, runs: 3 });
    expect(ms).toBeLessThan(50);
  });

  it("hot strings survive cache churn (recency refresh)", () => {
    const hotKey = "HOT-" + filler(2000);
    const first = estimateTokens(hotKey);
    expect(first).toBeGreaterThan(0);
    let acc = 0;
    for (let i = 0; i < 5200; i++) {
      // Exceed TOKEN_CACHE_MAX (5000) with novel strings between re-uses.
      acc += estimateTokens(`novel-${i}-${filler(500, i)}`);
      if (i % 50 === 0) acc += estimateTokens(hotKey);
    }
    if (acc < 0) throw new Error("unreachable");
    // Without the recency refresh the hot key is evicted by the novel
    // strings, so every estimateTokens(hotKey) below re-encodes 2000 chars
    // (~ms each) and 100 calls blow well past this budget.
    const ms = measureBest(
      () => {
        for (let i = 0; i < 100; i++) estimateTokens(hotKey);
      },
      { warmup: 0, runs: 3 },
    );
    expect(estimateTokens(hotKey)).toBe(first);
    expect(ms).toBeLessThan(20);
  });

  it("repeated-char BPE pathology stays bounded", () => {
    // js-tiktoken encodes homogeneous runs superlinearly (4096 a's ≈ 1.5s).
    // The budget only guards against the curve turning exponential.
    const ms = measureBest(() => {
      estimateTokens("a".repeat(4096));
    });
    expect(ms).toBeLessThan(5000);
  });

  it("estimateTokens scales linearly on realistic text (1KB vs 4KB)", () => {
    // Nonced keys keep BPE cold in every timed run (honest per-call
    // envelope); steady-state-with-cache is covered by the budget tests.
    const c = (kb: number) => {
      let nonce = 0;
      const measureRun = () => {
        const list = Array.from({ length: 400 }, (_, i) => `scale-payload ${nonce++} ${filler(kb * 1024, i)}`);
        let sum = 0;
        for (const s of list) sum += estimateTokens(s);
        if (sum < 0) throw new Error("unreachable");
      };
      return measureBest(measureRun, { warmup: 1, runs: 3 });
    };
    const msSmall = c(1);
    const msLarge = c(4);
    // 4x the bytes may take up to 3^2 = 9x the time on a linear BPE; a
    // quadratic curve would land near 16x and trip the guard.
    expect(msLarge / Math.max(msSmall, 1e-6)).toBeLessThan(9);
    expect(msLarge).toBeLessThan(2000);
  });
});

describe("perf: context management (compaction/truncation)", () => {
  beforeAll(heat);
  const history = mkHistory(1000); // ~2002 messages

  it("selectCompactionTail on a 2000-message history", () => {
    const ms = measureBest(() => {
      selectCompactionTail(history, 20_000);
    });
    expect(ms).toBeLessThan(200);
  });

  it("truncateHistory on a 2000-message history with a real window", () => {
    const ms = measureBest(() => {
      truncateHistory(history, "SYSTEM PROMPT", { contextWindow: 128_000, maxOutputTokens: 8192, systemTokens: 1000 });
    });
    // ~625ms steady state: each pass re-encodes the rewritten window (new
    // content strings miss the token cache by definition). Budget allows
    // 2x headroom; a differential-encoding pass would be the optimization.
    expect(ms).toBeLessThan(1500);
  });

  it("pruneOldToolOutputs on a 2000-message history", () => {
    const toolish = history.map((m, i) =>
      i % 4 === 0 ? { ...m, role: "tool" as const, toolCallId: `call-${i}` } : m,
    );
    const ms = measureBest(() => {
      pruneOldToolOutputs(toolish, { contextWindow: 128_000 });
    });
    expect(ms).toBeLessThan(500);
  });

  it("isContextOverflow is trivial (no BPE)", () => {
    const ms = measureBest(() => {
      for (let i = 0; i < 10_000; i++) isContextOverflow(i * 7, 128_000, 8192);
    });
    expect(ms).toBeLessThan(100);
  });
});

describe("perf: tool-call parsing", () => {
  it("parseTextToolCalls on a ~1MB mixed payload", () => {
    let body = "Here is my analysis.\n\n";
    for (let i = 0; i < 120; i++) {
      body += `\`\`\`tool_call\n{"tool": "read_file", "args": {"path": "/repo/src/file-${i}.ts", "detail": "${"d".repeat(120)}"}}\n\`\`\`\n`;
      body += `Then I verified step ${i}: ` + "t".repeat(640) + "\n";
    }
    body += `<tool_call>{"tool": "grep", "args": {"query": "perf", "path": "."}}</tool_call>`;
    const ms = measureBest(() => {
      const calls = parseTextToolCalls(body);
      if (!calls || calls.length < 120) throw new Error("parser regressed");
    });
    expect(ms).toBeLessThan(1500);
  });

  it("cleanContent on long prose", () => {
    const prose = Array.from({ length: 50 }, (_, i) => `#### Section ${i}\n` + "lorem ipsum ".repeat(200)).join("\n\n");
    const ms = measureBest(() => {
      cleanContent(prose);
    });
    expect(ms).toBeLessThan(1000);
  });
});

describe("perf: render pipeline (message-renderer)", () => {
  beforeAll(heat);

  function tc(id: string, name: string, status = "done"): LiveToolCall {
    return { id, name, status: status as LiveToolCall["status"], args: "{}" };
  }

  it("groupFlatToolCalls on 500 tool calls", () => {
    const calls: LiveToolCall[] = [];
    for (let i = 0; i < 500; i++) {
      const mod = i % 10;
      if (mod < 5) calls.push(tc(`r${i}`, "read_file"));
      else if (mod < 7) calls.push(tc(`c${i}`, "run_command"));
      else if (mod === 7) calls.push(tc(`w${i}`, "write_file"));
      else if (mod === 8) calls.push(tc(`s${i}`, "spawn_subagent"));
      else calls.push(tc(`g${i}`, "grep"));
    }
    const ms = measureBest(() => {
      const groups = groupFlatToolCalls(calls);
      if (groups.length === 0) throw new Error("grouping regressed");
    });
    expect(ms).toBeLessThan(200);
  });

  it("groupSegmentItems on 600 mixed segments", () => {
    const segs = [];
    const byId = new Map<string, LiveToolCall>();
    for (let i = 0; i < 600; i++) {
      const mod = i % 6;
      if (mod < 2) segs.push({ id: `seg${i}`, kind: "text", content: "some prose " + i });
      else if (mod === 2) segs.push({ id: `seg${i}`, kind: "thinking", content: "hidden reasoning" });
      else {
        const toolId = `tl${i}`;
        segs.push({ id: `seg${i}`, kind: "tool_call", toolCallId: toolId });
        byId.set(toolId, tc(toolId, mod === 4 ? "edit_file" : "run_command"));
      }
    }
    const ms = measureBest(() => {
      const items = groupSegmentItems(segs, byId);
      if (items.length === 0) throw new Error("grouping regressed");
    });
    expect(ms).toBeLessThan(200);
  });

  it("mergeSegments on 400 raw segments with 100 live tool calls", () => {
    const raw = [];
    const byId = new Map<string, LiveToolCall>();
    for (let i = 0; i < 400; i++) {
      if (i % 4 === 0) {
        const toolId = `mt${i}`;
        raw.push({ id: `seg${i}`, kind: "tool_call", toolCallId: toolId });
        byId.set(toolId, tc(toolId, "list_directory"));
      } else {
        raw.push({ id: `seg${i}`, kind: i % 2 ? "thinking" : "text", content: "c".repeat(300) });
      }
    }
    const ms = measureBest(() => {
      const out = mergeSegments(raw, byId);
      expect(out.length).toBeGreaterThan(0);
    });
    expect(ms).toBeLessThan(200);
  });

  it("sanitizeContent on 40 typical assistant markdown payloads", () => {
    const payloads = Array.from({ length: 40 }, (_, i) =>
      `### Step ${i}\n\nThe agent **verified** the change with \`npm run build\`.\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n\n- one\n- two\n\n<a href="javascript:alert(1)">x</a> should be stripped.\n`,
    );
    const ms = measureBest(() => {
      for (const p of payloads) sanitizeContent(p);
    });
    expect(ms).toBeLessThan(1000);
  });
});

describe("perf: store streaming pipeline (appendSegment* flush)", () => {
  beforeAll(heat);
  beforeAll(() => {
    useAppStore.setState({ messagesByConversation: {}, messages: [], activeConversationId: null });
  });

  function makeConversation(size: number, convId: string): string {
    const msgs: UIMessage[] = [];
    for (let i = 0; i < size - 1; i++) {
      msgs.push({
        id: `${convId}-m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: `message ${i} ` + filler(400, i),
        createdAt: new Date().toISOString(),
        segments: [],
      } as UIMessage);
    }
    const streamingId = `${convId}-streaming`;
    msgs.push({
      id: streamingId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      segments: [],
      streaming: true,
    } as UIMessage);
    useAppStore.setState({
      activeConversationId: convId,
      messagesByConversation: { [convId]: msgs },
      messages: msgs,
      streamingStateByConversation: {
        [convId]: { isStreaming: true, streamingMessageId: streamingId },
      },
      streamingMessageId: streamingId,
      isStreaming: true,
    });
    return streamingId;
  }

  it("600 rAF-flush cycles over a 200-message conversation", () => {
    const convId = "perf-conv";
    const streamingId = makeConversation(200, convId);
    const ms = measureBest(() => {
      for (let i = 0; i < 600; i++) {
        useAppStore.getState().appendSegmentText(streamingId, "delta-" + i + " ", convId);
        useAppStore.getState().appendToolCallArgs("perf-tool", JSON.stringify({ i }), convId);
        useAppStore.getState().appendCommandOutput("perf-tool", "line\n", true, convId);
      }
    }, { warmup: 1, runs: 3 });
    // 1800 store updates × 201-message identity-preserving maps.
    // Observed ~100-400ms; a regression into full-array cloning or per-frame
    // BPE would blow well past this.
    expect(ms).toBeLessThan(3000);
    expect(useAppStore.getState().messagesByConversation[convId].length).toBe(200);
  });

  it("store flush scales linearly with conversation size (200 vs 800)", () => {
    const cycle = (size: number, nonce: number) => {
      const convId = `scale-conv-${nonce}`;
      const streamingId = makeConversation(size, convId);
      const t0 = performance.now();
      for (let i = 0; i < 600; i++) {
        useAppStore.getState().appendSegmentText(streamingId, `delta-${nonce}-${i} `, convId);
        useAppStore.getState().appendToolCallArgs(`tool-${nonce}`, JSON.stringify({ i }), convId);
        useAppStore.getState().appendCommandOutput(`tool-${nonce}`, "line\n", true, convId);
      }
      const elapsed = performance.now() - t0;
      if (useAppStore.getState().messagesByConversation[convId].length !== size) {
        throw new Error("conversation size drifted");
      }
      return elapsed;
    };
    const msSmall = cycle(200, 1);
    const msLarge = cycle(800, 2);
    // 4x the messages may take up to 3^2 = 9x on an identity-preserving
    // map pipeline; full-array cloning would land near 4x+ per doubled map
    // and quadratic rebuilds would blow past the guard.
    expect(msLarge / Math.max(msSmall, 1e-6)).toBeLessThan(9);
    expect(msLarge).toBeLessThan(4000);
  });
});
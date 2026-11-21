import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const executorSrc = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "src", "lib", "ai", "executor.ts"),
  "utf-8",
);

describe("Realtime auto-compact trigger integrity", () => {
  it("re-checks the compaction threshold right after measured usage lands", () => {
    // The live usage emit inside the measured-usage block is the anchor —
    // uniquely identified by its estimated-flag field.
    const usageAnchor = executorSrc.indexOf("estimated: lastPromptTokensEstimated,");
    expect(usageAnchor).toBeGreaterThan(0);

    // The post-response trigger must live in the SAME measured-usage block,
    // after the usage emit — not only in the pre-call check at the top of
    // the next iteration (which never runs when the crossing happened on the
    // final response of a run).
    const triggerIdx = executorSrc.indexOf("auto-compact triggered post-response");
    expect(triggerIdx).toBeGreaterThan(usageAnchor);
    const usageBlockEnd = executorSrc.indexOf("Extract <think> content", triggerIdx);
    expect(usageBlockEnd).toBeGreaterThan(triggerIdx);
  });

  it("guards the post-response trigger against aborts, double-runs, and unknown budgets", () => {
    const triggerIdx = executorSrc.indexOf("auto-compact triggered post-response");
    const guardBlock = executorSrc.slice(Math.max(0, triggerIdx - 900), triggerIdx);
    expect(guardBlock).toContain("!signal?.aborted");
    expect(guardBlock).toContain("!autoCompactTriggered");
    expect(guardBlock).toContain("effectiveInputBudget > 0");
    expect(guardBlock).toContain("COMPACTION_TRIGGER_RATIO");
    // Fires on the same grounded signal as the pre-call check.
    expect(guardBlock).toContain("Math.max(preTruncationTokens, lastPromptTokens)");
  });

  it("keeps the working history consistent after a post-response compaction", () => {
    const triggerIdx = executorSrc.indexOf("auto-compact triggered post-response");
    const after = executorSrc.slice(triggerIdx, triggerIdx + 800);
    expect(after).toContain("autoCompactTriggered = true");
    expect(after).toContain("mapHistory(applyCompactionWindow(cachedRows))");
    expect(after).toContain("pruneOldToolOutputs(history, ctxConfig, tokenOf)");
  });
});

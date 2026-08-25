import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@/lib/ai/context";

/**
 * Shared performance-harness toolkit (tests/perf).
 *
 * Every helper is measurement-only; correctness invariants stay in the test
 * bodies. Timings are best-of-N (min) with median (p50) reported, budgets are
 * ~2-5x the observed steady-state so CI variance never flakes while real
 * regressions (new O(n²), re-encode per delta, dropped memo) breach them.
 *
 * `expectScaling` is the crown jewel: it asserts that doubling the input
 * size does not blow past `2^doublings × maxGrowthPerDouble`× the time. A
 * quadratic regression on a 2x size step grows 4x and trips the guard.
 */

const SNIPPET =
  "The quick brown fox jumps over the lazy dog, refactoring the build pipeline while reviewing pull requests and running the test suite in parallel. ";

/** Deterministic mixed-prose filler. Homogeneous runs make js-tiktoken's BPE
 *  superlinear, so fixtures must never use `"x".repeat(n)` for payloads. */
export function filler(n: number, seed = 0): string {
  const s = SNIPPET.repeat(Math.ceil(n / SNIPPET.length)).slice(0, n);
  return seed ? `${s} ${seed}` : s;
}

export interface Sample {
  min: number;
  p50: number;
  max: number;
  runs: number;
}

/** Warmup runs first, then N timed runs. Returns min / median / max ms. */
export function measure(
  fn: () => void,
  opts: { warmup?: number; runs?: number } = {},
): Sample {
  const warmup = opts.warmup ?? 2;
  const runs = opts.runs ?? 5;
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    min: samples[0],
    p50: samples[Math.floor(samples.length / 2)],
    max: samples[samples.length - 1],
    runs,
  };
}

/** Best-of-N ms (backwards-compatible with the original hot-paths helper). */
export function best(fn: () => void, opts?: { warmup?: number; runs?: number }): number {
  return measure(fn, opts).min;
}

/** Assert a measured time is under a budget; throws with full stats on breach. */
export function assertFast(sample: Sample | number, budgetMs: number, label: string): void {
  const ms = typeof sample === "number" ? sample : sample.min;
  if (ms >= budgetMs) {
    const detail = typeof sample === "number" ? `${ms.toFixed(1)}ms` : `min=${sample.min.toFixed(1)} p50=${sample.p50.toFixed(1)} max=${sample.max.toFixed(1)}`;
    throw new Error(`${label}: ${detail} >= ${budgetMs}ms budget`);
  }
}

export interface ScalingPoint {
  size: number;
  ms: number;
}

/**
 * Guard against superlinear growth: for each adjacent size pair, the time
 * ratio must stay under `maxGrowthPerDouble` raised to the number of
 * doublings between the two sizes. Quadratic code on a 2x step grows ~4x
 * and trips the default guard (3x allowed).
 */
export function expectScaling(
  points: ScalingPoint[],
  opts: { maxGrowthPerDouble?: number; label?: string } = {},
): void {
  const maxGrowth = opts.maxGrowthPerDouble ?? 3;
  const label = opts.label ?? "scaling";
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const doublings = Math.log2(b.size / a.size);
    const allowed = Math.pow(maxGrowth, doublings);
    const ratio = b.ms / Math.max(a.ms, 1e-6);
    if (ratio > allowed) {
      throw new Error(
        `${label}: size ${a.size} -> ${b.size} took ${a.ms.toFixed(1)}ms -> ${b.ms.toFixed(1)}ms ` +
          `(${ratio.toFixed(2)}x, > ${allowed.toFixed(2)}x allowed for ${doublings.toFixed(1)} ` +
          `doublings at ${maxGrowth}x/double) — superlinear regression`,
      );
    }
  }
}

export interface ReportRow {
  suite: string;
  test: string;
  sample: Sample;
  budget?: number;
  ok: boolean;
}

/**
 * Per-file reporter: records every bench row, prints a compact table at the
 * end of the file run and writes perf-reports/<name>.md for archiving.
 */
export function makeReporter(name: string) {
  const rows: ReportRow[] = [];
  return {
    record(suite: string, test: string, sample: Sample, budget?: number) {
      rows.push({ suite, test, sample, budget, ok: budget === undefined || sample.min < budget });
    },
    report: (): void => {
      const header = `| suite | test | min (ms) | p50 (ms) | max (ms) | budget (ms) | ok |\n|---|---|---|---|---|---|---|`;
      const body = rows
        .map(
          (r) =>
            `| ${r.suite} | ${r.test} | ${r.sample.min.toFixed(1)} | ${r.sample.p50.toFixed(1)} | ${r.sample.max.toFixed(1)} | ${r.budget ?? "-"} | ${r.ok ? "yes" : "**no**"} |`,
        )
        .join("\n");
      const md = `# HermOS perf report — ${name}\n\n> generated ${new Date().toISOString()}; budgets are ~2-5x steady-state\n\n${header}\n${body}\n`;
      try {
        mkdirSync(join(process.cwd(), "perf-reports"), { recursive: true });
        writeFileSync(join(process.cwd(), "perf-reports", `${name}.md`), md, "utf8");
      } catch {
        // The report is best-effort; a failed write must never fail the run.
      }
    },
  };
}

let bpeWarmed = false;

/** Compile the BPE encoder once per worker so measurements see steady-state. */
export function warmBpe(): void {
  if (bpeWarmed) return;
  for (let i = 0; i < 25; i++) estimateTokens(`warmup ${i} ${filler(2048, i)}`);
  bpeWarmed = true;
}
import { describe, it, beforeAll, afterAll } from "vitest";
import { computeDiff, formatUnifiedDiff, applyPatch } from "@/lib/diff";
import { extractSymbols, languageFromExt } from "@/lib/symbols";
import { applyEditToContent, safePathFromRoot, globToRegex } from "@/lib/workspace";
import { parseMentions } from "@/lib/mentions";
import { encrypt, decrypt, safeEqual } from "@/lib/encryption";
import { measure, assertFast, expectScaling, makeReporter, warmBpe, filler } from "./harness";

/**
 * Budget-based harness for the workspace/editor libs: file edits, symbol
 * extraction, diffing, path safety, glob compilation, mention parsing and
 * provider-key encryption. Pure CPU paths — no fs/network — so timings are
 * stable and budgets honest.
 *
 * Run: npm run perf
 */

const rows = makeReporter("bench-libs");

function tsSource(lines: number, symbols: number): string {
  const syms: string[] = [];
  syms.push("import { useState, useEffect } from 'react';");
  syms.push("import type { FC, ReactNode } from 'react';");
  syms.push("");
  for (let i = 0; i < symbols; i++) {
    syms.push(`export interface Model${i} { id: string; name: string; tokens: number; enabled: boolean; }`);
    syms.push(`const registry${i} = new Map<string, Model${i}>();`);
    syms.push(`export function register${i}(m: Model${i}): boolean { registry${i}.set(m.id, m); return true; }`);
    syms.push(`export const meta${i} = { label: 'mod ${i}', boost: ${i % 5} };`);
    syms.push(`class Walker${i} { private seen = new Set<string>(); walk(id: string): string { this.seen.add(id); return id; } }`);
    syms.push("");
  }
  const body = syms.join("\n");
  const target = lines * 60;
  if (body.length >= target) return body;
  return body + "\n// padding to reach target length\n" + filler(target - body.length);
}

describe("perf: workspace libs — file edits", () => {
  beforeAll(warmBpe);

  it("applyEditToContent: 50 sequential edits on a 1MB file", () => {
    let content = tsSource(1, 400); // ~52KB — extend to ~1MB below
    const blocks: string[] = [];
    for (let i = 0; i < 50; i++) {
      blocks.push(`// ===== BLOCK ${i} =====\n` + filler(16000, i));
    }
    content = tsSource(1, 400) + "\n" + blocks.join("\n");
    const sample = measure(() => {
      let cur = content;
      for (let i = 0; i < 50; i++) {
        const out = applyEditToContent(cur, `BLOCK ${i} =====`, `BLOCK ${i} EDITED =====`);
        if (out.occurrences !== 1) throw new Error(`edit ${i} lost`);
        cur = out.content;
      }
      if (cur.includes("BLOCK 49 =====\n") || !cur.includes("BLOCK 49 EDITED")) throw new Error("edit regressed");
    }, { warmup: 1, runs: 3 });
    assertFast(sample, 3000, "applyEditToContent × 50 @ 1MB");
    rows.record("edits", "applyEditToContent × 50 seq on 1MB", sample, 3000);
  });

  it("applyEditToContent replaceAll: 5000 occurrences on a 1MB file", () => {
    const base = filler(2000);
    const content = Array.from({ length: 5000 }, (_, i) => `${base} TODO: fix ${i} ${base}`).join("\n");
    const sample = measure(() => {
      const out = applyEditToContent(content, "TODO", "DONE", true);
      if (out.occurrences !== 5000) throw new Error(`expected 5000, got ${out.occurrences}`);
      if (out.content.includes("TODO")) throw new Error("replaceAll leaked");
    }, { warmup: 1, runs: 3 });
    assertFast(sample, 3000, "applyEditToContent replaceAll × 5000");
    rows.record("edits", "applyEditToContent replaceAll 5000×", sample, 3000);
  });
});

describe("perf: workspace libs — symbols", () => {
  beforeAll(warmBpe);
  const ts = languageFromExt("app.ts")!;

  it("extractSymbols on a 3000-line TypeScript file", () => {
    const src = tsSource(3000, 400);
    const sample = measure(() => {
      const syms = extractSymbols(src, ts);
      if (syms.length < 200) throw new Error(`expected >= 200 symbols, got ${syms.length}`);
    });
    assertFast(sample, 1200, "extractSymbols 3000 lines");
    rows.record("symbols", "extractSymbols 3000-line TS", sample, 1200);
  });

  it("extractSymbols scales linearly (750 -> 3000 lines)", () => {
    const small = tsSource(750, 100);
    const large = tsSource(3000, 400);
    const points = [
      { size: small.length, ms: measure(() => extractSymbols(small, ts)).min },
      { size: large.length, ms: measure(() => extractSymbols(large, ts)).min },
    ];
    expectScaling(points, { label: "extractSymbols", maxGrowthPerDouble: 4 });
    rows.record("symbols", "extractSymbols scaling 750->3000", points[1] ? { min: points[1].ms, p50: points[1].ms, max: points[1].ms, runs: 5 } : { min: 0, p50: 0, max: 0, runs: 0 });
  });
});

describe("perf: workspace libs — diffing", () => {
  beforeAll(warmBpe);

  function diffFixture(lines: number): { old: string; next: string } {
    const oldLines: string[] = [];
    for (let i = 0; i < lines; i++) {
      oldLines.push(`const value${i % 9} = compute(${i}); // line ${i} state ${i % 3}`);
    }
    const nextLines = oldLines.slice(0);
    for (let i = 0; i < lines; i += 10) nextLines[i] = `const value${i % 9} = recompute(${i}, newFlag); // line ${i} changed`;
    nextLines.splice(Math.floor(lines / 2), 0, "// inserted block start", "const inserted = true;", "// inserted block end");
    nextLines.splice(Math.floor(lines / 3), 40);
    return { old: oldLines.join("\n"), next: nextLines.join("\n") };
  }

  it("computeDiff on two 3000-line files (~40% changed)", () => {
    const { old, next } = diffFixture(3000);
    const sample = measure(() => {
      const diff = computeDiff(old, next);
      if (diff.length < 10) throw new Error("diff collapsed");
    }, { warmup: 1, runs: 3 });
    assertFast(sample, 3000, "computeDiff 3000 lines");
    rows.record("diff", "computeDiff 3000 lines, 40% churn", sample, 3000);
  });

  it("computeDiff fast path: identical 5000-line files", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i}: ${filler(40, i)}`).join("\n");
    const sample = measure(
      () => {
        const diff = computeDiff(a, a);
        // computeDiff emits every line as a `context` entry for identical
        // inputs — the invariant is that nothing is added or deleted.
        if (diff.some((l) => l.type !== "context")) throw new Error("identical inputs produced changes");
        if (diff.length !== 5000) throw new Error("context lines lost");
      },
      { warmup: 1, runs: 2 },
    );
    // Same-text shortcut in computeDiff: no LCS table is built at all.
    // Tight budget — the pre-fix full LCS took ~875ms/call (25M cells).
    assertFast(sample, 100, "computeDiff identical 5000 lines");
    rows.record("diff", "computeDiff identical 5000 lines (same-text shortcut)", sample, 100);
  });

  it("computeDiff with a single 40-line edit in a 5000-line file (prefix/suffix trim)", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `const v${i} = fn(${i});  // ${filler(20, i)}`).join("\n");
    const b = a.split("\n");
    for (let i = 1200; i < 1240; i++) b[i] = `const v${i} = fn2(${i});  // ${filler(20, i)} edited`;
    const next = b.join("\n");
    const sample = measure(() => {
      const diff = computeDiff(a, next);
      // 40 replaced lines emit 40 dels + 40 adds (80 non-context lines).
      if (diff.filter((l) => l.type !== "context").length !== 80) throw new Error("change count drifted");
    }, { warmup: 1, runs: 2 });
    // Common prefix/suffix trim shrinks the DP to the 40-line window; the
    // full 25M-cell LCS over identical regions would take ~875ms/call.
    assertFast(sample, 100, "computeDiff single edit region, 5000 lines");
    rows.record("diff", "computeDiff 5000 lines, 40-line edit (trimmed)", sample, 100);
  });

  it("formatUnifiedDiff + applyPatch roundtrip on a 3000-line diff", () => {
    const { old, next } = diffFixture(3000);
    const diff = computeDiff(old, next);
    const sample = measure(() => {
      const unified = formatUnifiedDiff(old, next, "src/app.ts");
      if (unified.length < 100) throw new Error("format collapsed");
      const patched = applyPatch(old, diff);
      if (patched !== next) throw new Error("patch roundtrip diverged");
    }, { warmup: 1, runs: 3 });
    assertFast(sample, 1500, "format+applyPatch roundtrip");
    rows.record("diff", "formatUnifiedDiff + applyPatch roundtrip", sample, 1500);
  });
});

describe("perf: workspace libs — paths, globs, mentions, crypto", () => {
  beforeAll(warmBpe);

  it("safePathFromRoot on 50k mixed (benign + adversarial) paths", () => {
    const root = "C:\\workspace";
    const paths: string[] = [];
    for (let i = 0; i < 25_000; i++) paths.push(`src\\components\\Module${i}\\index-${i}.tsx`);
    for (let i = 0; i < 25_000; i++) {
      const mod = i % 5;
      if (mod === 0) paths.push(`..\\..\\..\\etc\\passwd ${i}`);
      else if (mod === 1) paths.push(`src\\..\\..\\Windows\\System32\\evil-${i}.exe`);
      else if (mod === 2) paths.push(`C:\\Windows\\sys-${i}.dll`);
      else if (mod === 3) paths.push(`a/b/c/${"../".repeat(8)}outside-${i}.txt`);
      else paths.push(`sub\\dir\\ok-${i}.ts`);
    }
    const sample = measure(
      () => {
        let ok = 0;
        for (const p of paths) {
          if (safePathFromRoot(root, p) !== null) ok++;
        }
        if (ok < 29_500 || ok > 30_500) throw new Error(`sanitization counts off: ${ok}`);
      },
      { warmup: 1, runs: 2 },
    );
    // ~33µs/call: path.resolve + normalize + traversal checks with adversarial
    // `..`/absolute chains on win32. Budget at 2.5x the observed 1.66s to
    // absorb CI drift while still tripping on any added per-call cost.
    assertFast(sample, 2500, "safePathFromRoot × 50k");
    rows.record("paths", "safePathFromRoot × 50k mixed", sample, 2500);
  }, 20_000);

  it("globToRegex on 10k patterns", () => {
    const patterns = Array.from({ length: 10_000 }, (_, i) =>
      `src/${i % 5 === 0 ? "**" : `mod${i % 50}`}/**/*.${i % 2 === 0 ? "ts" : "tsx"}`,
    );
    const sample = measure(() => {
      let total = 0;
      for (const p of patterns) total += globToRegex(p).toString().length;
      if (total < 1000) throw new Error("glob compile regressed");
    });
    assertFast(sample, 400, "globToRegex × 10k");
    rows.record("paths", "globToRegex × 10k", sample, 400);
  });

  it("parseMentions on 50KB of chat with 400 typed mentions + commands", () => {
    const parts: string[] = [];
    for (let i = 0; i < 400; i++) {
      parts.push(`user${i}: embed @file:src/mod-${i}.ts for ticket #${i}, then run /test`);
      parts.push(filler(80, i));
    }
    const text = parts.join("\n");
    const sample = measure(() => {
      const mentions = parseMentions(text);
      if (mentions.length < 400) throw new Error(`expected >= 400 mentions, got ${mentions.length}`);
    });
    assertFast(sample, 400, "parseMentions 50KB");
    rows.record("mentions", "parseMentions 50KB / 400 mentions", sample, 400);
  });

  it("encrypt + decrypt 2000 provider keys (512B each)", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `sk-ant-${i}-` + filler(500, i));
    const sample = measure(() => {
      for (let i = 0; i < keys.length; i++) {
        const cipher = encrypt(keys[i]);
        const plain = decrypt(cipher);
        if (!safeEqual(plain, keys[i])) throw new Error(`roundtrip failed at ${i}`);
      }
    });
    assertFast(sample, 2000, "encrypt/decrypt × 2000");
    rows.record("crypto", "encrypt+decrypt × 2000 keys", sample, 2000);
  });
});

afterAll(() => rows.report());
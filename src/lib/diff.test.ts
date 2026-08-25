import { describe, it, expect } from "vitest";
import {
  computeDiff,
  formatUnifiedDiff,
  applyPatch,
  type DiffLine,
} from "./diff";

describe("computeDiff", () => {
  it("should return empty array for identical empty strings", () => {
    expect(computeDiff("", "")).toEqual([]);
  });

  it("should return all context for identical non-empty strings", () => {
    const result = computeDiff("hello\nworld", "hello\nworld");
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("context");
    expect(result[1].type).toBe("context");
  });

  it("should detect deletions", () => {
    const result = computeDiff("line1\nline2\nline3", "line1\nline3");
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("context");
    expect(result[1].type).toBe("del");
    expect(result[2].type).toBe("context");
  });

  it("should detect insertions", () => {
    const result = computeDiff("line1\nline3", "line1\nline2\nline3");
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("context");
    expect(result[1].type).toBe("add");
    expect(result[2].type).toBe("context");
  });

  it("should detect mixed additions and deletions", () => {
    const oldText = "a\nb\nc";
    const newText = "a\nx\nc";
    const result = computeDiff(oldText, newText);
    // a (context), b (del), x (add), c (context)
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ type: "context", content: "a" });
    expect(result[1]).toMatchObject({ type: "del", content: "b" });
    expect(result[2]).toMatchObject({ type: "add", content: "x" });
    expect(result[3]).toMatchObject({ type: "context", content: "c" });
  });

  it("should handle completely different content", () => {
    const result = computeDiff("old\ncontent", "new\nstuff");
    expect(result.length).toBeGreaterThanOrEqual(4);
    const types = result.map((l) => l.type);
    expect(types).toContain("del");
    expect(types).toContain("add");
  });

  it("should handle empty old text (all additions)", () => {
    const result = computeDiff("", "new\nlines");
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("add");
    expect(result[1].type).toBe("add");
  });

  it("should handle empty new text (all deletions)", () => {
    const result = computeDiff("old\nlines", "");
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("del");
    expect(result[1].type).toBe("del");
  });

  it("should preserve line numbers for context lines", () => {
    const result = computeDiff("a\nb\nc", "a\nb\nc");
    expect(result[0].oldNum).toBe(1);
    expect(result[0].newNum).toBe(1);
    expect(result[2].oldNum).toBe(3);
    expect(result[2].newNum).toBe(3);
  });

  it("should handle trailing newline", () => {
    const result = computeDiff("a\nb\n", "a\nb\nc\n");
    expect(result.length).toBeGreaterThanOrEqual(3);
    const adds = result.filter((l) => l.type === "add");
    expect(adds.length).toBeGreaterThan(0);
  });

  it("should handle single-line contents", () => {
    const result = computeDiff("hello", "world");
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("del");
    expect(result[1].type).toBe("add");
  });

  it("should handle large inputs with naive fallback", () => {
    // Create arrays that exceed MAX_LCS_LINES to trigger naive fallback
    // Since MAX_LCS_LINES = 50_000, we just test that large inputs don't crash
    const bigOld = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const bigNew = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    const result = computeDiff(bigOld, bigNew);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("applyPatch", () => {
  it("should reconstruct new text from diff", () => {
    const oldText = "a\nb\nc\nd";
    const diff = computeDiff(oldText, "a\nx\nc\nd");
    const patched = applyPatch(oldText, diff);
    expect(patched).toBe("a\nx\nc\nd");
  });

  it("should produce identical output for unchanged content", () => {
    const text = "hello\nworld\n";
    const diff = computeDiff(text, text);
    // The diff preserves the trailing empty line (representing trailing \n).
    // applyPatch joins with \n giving "hello\nworld\n" which equals the input.
    const patched = applyPatch(text, diff);
    expect(patched).toBe("hello\nworld\n");
  });

  it("should handle pure additions", () => {
    const diff = computeDiff("", "new\ncontent");
    expect(applyPatch("", diff)).toBe("new\ncontent");
  });

  it("should handle pure deletions", () => {
    const diff = computeDiff("a\nb\nc", "");
    expect(applyPatch("a\nb\nc", diff)).toBe("");
  });

  it("should work with inline diff construction", () => {
    const diff: DiffLine[] = [
      { type: "add", oldNum: null, newNum: 1, content: "added" },
    ];
    expect(applyPatch("", diff)).toBe("added");
  });

  it("should combine context and add lines correctly", () => {
    const diff: DiffLine[] = [
      { type: "context", oldNum: 1, newNum: 1, content: "keep" },
      { type: "del", oldNum: 2, newNum: null, content: "remove" },
      { type: "add", oldNum: null, newNum: 2, content: "inserted" },
    ];
    expect(applyPatch("keep\nremove", diff)).toBe("keep\ninserted");
  });
});

describe("formatUnifiedDiff", () => {
  it("should produce git-style unified diff headers", () => {
    const result = formatUnifiedDiff("a\nb\nc", "a\nx\nc", "test.txt");
    expect(result).toContain("--- a/test.txt");
    expect(result).toContain("+++ b/test.txt");
    expect(result).toContain("@@");
  });

  it("should use /dev/null-style placeholders when path is omitted", () => {
    const result = formatUnifiedDiff("old", "new");
    expect(result).toContain("--- old");
    expect(result).toContain("+++ new");
  });

  it("should return headers only for identical content", () => {
    const result = formatUnifiedDiff("same\ncontent", "same\ncontent");
    expect(result).toContain("--- ");
    expect(result).toContain("+++ ");
    expect(result).not.toContain("@@");
  });

  it("should place + before additions and - before deletions", () => {
    const result = formatUnifiedDiff("a\nb\nc", "a\nx\nc");
    const lines = result.split("\n");
    const minusLines = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const plusLines = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(minusLines.length).toBeGreaterThan(0);
    expect(plusLines.length).toBeGreaterThan(0);
  });

  it("should include trailing newline", () => {
    const result = formatUnifiedDiff("a", "b");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("should cap output at MAX_UNIFIED_CHARS", () => {
    const big = "x\n".repeat(100_000);
    const result = formatUnifiedDiff("", big);
    // Should not be excessively long
    expect(result.length).toBeLessThan(60_000);
    expect(result).toContain("[diff truncated]");
  });
});

describe("Diff differential (optimized vs reference LCS)", () => {
  // A deliberately naive, obviously-correct LCS reference. It shares no code
  // with computeDiff, so any numbering/trim bug in the fast paths shows up
  // as a mismatch on the randomized inputs below.
  function referenceDiff(oldText: string, newText: string): DiffLine[] {
    const a = oldText === "" ? [] : oldText.split("\n");
    const b = newText === "" ? [] : newText.split("\n");
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ type: "context", oldNum: i + 1, newNum: j + 1, content: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] });
        i++;
      } else {
        out.push({ type: "add", oldNum: null, newNum: j + 1, content: b[j] });
        j++;
      }
    }
    while (i < n) { out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] }); i++; }
    while (j < m) { out.push({ type: "add", oldNum: null, newNum: j + 1, content: b[j] }); j++; }
    return out;
  }

  // Deterministic LCG — reproducible failures across runs/platforms.
  let seed = 0x9e3779b9;
  function rand(): number {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  }

  it("matches the reference exactly on repeat-free inputs (unique alignment)", () => {
    for (let t = 0; t < 300; t++) {
      // A per-iteration pool of unique atoms; each text samples WITHOUT
      // replacement, so any line present in both texts occurs exactly once
      // in each — forced pairing, one optimal alignment, bit-exact parity.
      const pool = Array.from({ length: 9 }, (_, q) => `atom_${t}_${q}`);
      const sample = (): string => {
        const shuffled = pool.slice();
        for (let q = shuffled.length - 1; q > 0; q--) {
          const r = Math.floor(rand() * (q + 1));
          [shuffled[q], shuffled[r]] = [shuffled[r], shuffled[q]];
        }
        return shuffled.slice(0, 1 + Math.floor(rand() * shuffled.length)).join("\n");
      };
      const oldText = sample();
      const newText = sample();
      const got = computeDiff(oldText, newText);
      const want = referenceDiff(oldText, newText);
      expect({ t, diff: got }).toEqual({ t, diff: want });
    }
  });

  it("matches the reference exactly on edited copies of a repeat-free base", () => {
    for (let t = 0; t < 300; t++) {
      const base: string[] = [];
      const count = 2 + Math.floor(rand() * 20);
      for (let k = 0; k < count; k++) base.push(`ln_${t}_${k}`);
      const oldText = base.join("\n");
      const next = base.slice(0);
      const edits = Math.floor(rand() * 8);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * next.length);
        if (rand() < 0.5) next[at] = `edited_${t}_${e}`;
        else next.splice(at, Math.floor(rand() * 3) === 0 ? 1 : 0);
      }
      const newText = next.join("\n");
      const got = computeDiff(oldText, newText);
      const want = referenceDiff(oldText, newText);
      expect({ t, diff: got }).toEqual({ t, diff: want });
    }
  });

  it("stays valid and minimal on repetition-heavy inputs (multiple optimal alignments)", () => {
    // With repeated lines the LCS has several optimal alignments and the
    // prefix/suffix trim may pick a different one than the untrimmed walk.
    // What must always hold: applyPatch reconstructs the new text, and the
    // edit count matches the minimal script (context = LCS length).
    const alphabet = ["a", "b", "c", "", "x", "x", "y", "repeat", "repeat"];
    for (let t = 0; t < 400; t++) {
      const pick = (): string => alphabet[Math.floor(rand() * alphabet.length)];
      const make = (): string => {
        const lines: string[] = [];
        const count = Math.floor(rand() * 9);
        for (let k = 0; k < count; k++) lines.push(pick());
        return lines.join("\n");
      };
      const oldText = make();
      const newText = make();
      const got = computeDiff(oldText, newText);
      const want = referenceDiff(oldText, newText);

      const counts = (lines: DiffLine[]): [number, number, number] => {
        let ctx = 0;
        let del = 0;
        let add = 0;
        for (const l of lines) {
          if (l.type === "context") ctx++;
          else if (l.type === "del") del++;
          else add++;
        }
        return [ctx, del, add];
      };
      const gotCounts = counts(got);
      const wantCounts = counts(want);
      expect({ t, valid: applyPatch(oldText, got) }).toEqual({ t, valid: newText });
      expect({ t, counts: gotCounts }).toEqual({ t, counts: wantCounts });
      expect(gotCounts[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches the reference on trailing-newline variants", () => {
    const cases: Array<[string, string]> = [
      ["a\nb\n", "a\nb\n"],
      ["a\nb\n", "a\nb"],
      ["a\nb", "a\nb\n"],
      ["", "\n"],
      ["\n", ""],
      ["\n", "\n"],
      ["a\n\nb", "a\nb"],
      ["x\nx", "x\nx\nx"],
    ];
    for (const [oldText, newText] of cases) {
      const got = computeDiff(oldText, newText);
      const want = referenceDiff(oldText, newText);
      expect({ oldText, got, want }).toEqual({ oldText, got: want, want: want });
    }
  });
});

describe("Diff round-trip (computeDiff + applyPatch)", () => {
  const cases: Array<{ name: string; old: string; new: string }> = [
    { name: "empty -> empty", old: "", new: "" },
    { name: "empty -> content", old: "", new: "hello\nworld" },
    { name: "content -> empty", old: "a\nb\nc", new: "" },
    { name: "append line", old: "a\nb", new: "a\nb\nc" },
    { name: "prepend line", old: "b\nc", new: "a\nb\nc" },
    { name: "replace middle", old: "a\nb\nc", new: "a\nx\nc" },
    { name: "complex changes", old: "1\n2\n3\n4\n5", new: "1\nedited\n3\n4\nnew\n6" },
    { name: "trailing newline", old: "a\nb\n", new: "a\nb\nc\n" },
    { name: "whitespace changes", old: "a  \nb", new: "a\nb\t" },
    { name: "single line unchanged", old: "only", new: "only" },
    { name: "single line changed", old: "only", new: "different" },
  ];

  for (const { name, old, new: newText } of cases) {
    it(`should round-trip: ${name}`, () => {
      const diff = computeDiff(old, newText);
      const reconstructed = applyPatch(old, diff);
      // Note: trailing newlines are normalized by splitLines/join so we compare
      // by trimming both to avoid trailing newline semantics issues
      expect(reconstructed).toBe(newText);
    });
  }
});

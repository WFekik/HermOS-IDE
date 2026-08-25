/**
 * Dependency-free unified line diffing (LCS algorithm) supporting computeDiff,
 * formatUnifiedDiff, and applyPatch, with safety fallback for inputs exceeding MAX_LCS_LINES.
 */

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number in the old text, or null for additions. */
  oldNum: number | null;
  /** 1-based line number in the new text, or null for deletions. */
  newNum: number | null;
  /** The line content WITHOUT the trailing newline. */
  content: string;
}

const MAX_LCS_LINES = 50_000;
const MAX_UNIFIED_CHARS = 50_000;

/** Split text into lines, preserving a trailing empty line if the text ended with \n. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  // Retain trailing empty line on final newline to match git diff semantics.
  const lines = text.split("\n");
  return lines;
}

/** Computes structured line diff between two texts via LCS with pairwise fallback for large files. */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return naiveDiff(a, b);
  }

  // Fast path: emit pure context without allocating the LCS table if identical.
  if (oldText === newText) {
    const out: DiffLine[] = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      out[i] = { type: "context", oldNum: i + 1, newNum: i + 1, content: a[i] };
    }
    return out;
  }
  return lcsDiff(a, b);
}

/** Pairwise diff: lines up old and new by index, no common-subsequence detection. */
function naiveDiff(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const inA = i < a.length;
    const inB = i < b.length;
    if (inA && inB) {
      if (a[i] === b[i]) {
        out.push({ type: "context", oldNum: i + 1, newNum: i + 1, content: a[i] });
      } else {
        out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] });
        out.push({ type: "add", oldNum: null, newNum: i + 1, content: b[i] });
      }
    } else if (inA) {
      out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] });
    } else if (inB) {
      out.push({ type: "add", oldNum: null, newNum: i + 1, content: b[i] });
    }
  }
  return out;
}

/**
 * LCS-based line diff with common prefix/suffix trimming to minimize the DP table.
 * Emits DiffLine entries with 1-based line numbers.
 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line, i) => ({ type: "add" as const, oldNum: null, newNum: i + 1, content: line }));
  if (m === 0) return a.map((line, i) => ({ type: "del" as const, oldNum: i + 1, newNum: null, content: line }));

  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) lo++;
  let s = 0;
  const minLen = Math.min(n, m);
  while (s < minLen - lo && a[n - 1 - s] === b[m - 1 - s]) s++;
  const hiA = n - s;
  const hiB = m - s;

  const out: DiffLine[] = [];
  for (let k = 0; k < lo; k++) {
    out.push({ type: "context", oldNum: k + 1, newNum: k + 1, content: a[k] });
  }

  // dp[i'][j'] = LCS length of a[lo+i'..hiA) and b[lo+j'..hiB).
  // Use a flat Uint32Array of size (rows)*(cols) for speed.
  const rows = hiA - lo + 1;
  const cols = hiB - lo + 1;
  const dp = new Uint32Array(rows * cols);
  // Base case dp[hiA][*] = 0 and dp[*][hiB] = 0 — already zero-initialised.
  for (let i = hiA - 1; i >= lo; i--) {
    const ai = a[i];
    const rowI = (i - lo) * cols;
    const rowI1 = (i + 1 - lo) * cols;
    for (let j = hiB - 1; j >= lo; j--) {
      if (ai === b[j]) {
        dp[rowI + (j - lo)] = dp[rowI1 + (j + 1 - lo)] + 1;
      } else {
        const down = dp[rowI1 + (j - lo)];
        const right = dp[rowI + (j + 1 - lo)];
        dp[rowI + (j - lo)] = down > right ? down : right;
      }
    }
  }

  let i = lo;
  let j = lo;
  while (i < hiA && j < hiB) {
    if (a[i] === b[j]) {
      out.push({ type: "context", oldNum: i + 1, newNum: j + 1, content: a[i] });
      i++;
      j++;
    } else {
      const down = dp[(i + 1 - lo) * cols + (j - lo)];
      const right = dp[(i - lo) * cols + (j + 1 - lo)];
      if (down >= right) {
        out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] });
        i++;
      } else {
        out.push({ type: "add", oldNum: null, newNum: j + 1, content: b[j] });
        j++;
      }
    }
  }
  while (i < hiA) {
    out.push({ type: "del", oldNum: i + 1, newNum: null, content: a[i] });
    i++;
  }
  while (j < hiB) {
    out.push({ type: "add", oldNum: null, newNum: j + 1, content: b[j] });
    j++;
  }
  for (let k = 0; k < s; k++) {
    out.push({ type: "context", oldNum: hiA + k + 1, newNum: hiB + k + 1, content: a[hiA + k] });
  }
  return out;
}

interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: DiffLine[];
}

/** Default context lines around each change, matching `git diff`'s default of 3. */
const CONTEXT_LINES = 3;

/** Group DiffLines into hunks with context, merging clusters whose context windows overlap. */
function groupHunks(diff: DiffLine[]): Hunk[] {
  const total = diff.length;
  if (total === 0) return [];

  const changeIdx: number[] = [];
  for (let k = 0; k < total; k++) {
    if (diff[k].type !== "context") changeIdx.push(k);
  }
  if (changeIdx.length === 0) return [];

  // Cluster changes with <= 2*CONTEXT_LINES gap between them.
  const clusters: Array<[number, number]> = []; // [firstChangeIdx, lastChangeIdx]
  let clusterStart = changeIdx[0];
  let clusterEnd = changeIdx[0];
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    // Gap of context lines between clusterEnd and idx = idx - clusterEnd - 1.
    if (idx - clusterEnd - 1 <= 2 * CONTEXT_LINES) {
      clusterEnd = idx;
    } else {
      clusters.push([clusterStart, clusterEnd]);
      clusterStart = idx;
      clusterEnd = idx;
    }
  }
  clusters.push([clusterStart, clusterEnd]);

  const hunks: Hunk[] = [];
  for (const [firstIdx, lastIdx] of clusters) {
    const start = Math.max(0, firstIdx - CONTEXT_LINES);
    const end = Math.min(total, lastIdx + CONTEXT_LINES + 1);
    const hunkLines = diff.slice(start, end);

    // Compute 1-based old/new starts and hunk lengths.
    let oldStart = 0;
    let newStart = 0;
    let oldLen = 0;
    let newLen = 0;
    for (const l of hunkLines) {
      if (l.oldNum !== null) {
        if (oldStart === 0) oldStart = l.oldNum;
        oldLen++;
      }
      if (l.newNum !== null) {
        if (newStart === 0) newStart = l.newNum;
        newLen++;
      }
    }
    // Pure insertion/deletion hunk: derive start line from the skipped counter.
    if (oldStart === 0) {
      oldStart = Math.max(0, (newStart || 1) - 1);
    }
    if (newStart === 0) {
      newStart = Math.max(0, (oldStart || 1) - 1);
    }
    hunks.push({ oldStart, oldLen, newStart, newLen, lines: hunkLines });
  }
  return hunks;
}

/** Render a structured diff as a git-style unified diff string, capped at {@link MAX_UNIFIED_CHARS}. */
export function formatUnifiedDiff(oldText: string, newText: string, path?: string): string {
  const diff = computeDiff(oldText, newText);
  const aPath = path ? `a/${path}` : "old";
  const bPath = path ? `b/${path}` : "new";

  const header: string[] = [`--- ${aPath}`, `+++ ${bPath}`];
  if (diff.length === 0) {
    return header.join("\n") + "\n";
  }

  const hunks = groupHunks(diff);
  const out: string[] = [...header];
  for (const h of hunks) {
    // Format `@@ -l,s +l,s @@` hunk header, omitting count when length is 1.
    const oldPart =
      h.oldLen === 0
        ? `${Math.max(0, h.oldStart - 1)},0`
        : h.oldLen === 1
          ? `${h.oldStart}`
          : `${h.oldStart},${h.oldLen}`;
    const newPart =
      h.newLen === 0
        ? `${Math.max(0, h.newStart - 1)},0`
        : h.newLen === 1
          ? `${h.newStart}`
          : `${h.newStart},${h.newLen}`;
    out.push(`@@ -${oldPart} +${newPart} @@`);
    for (const l of h.lines) {
      const prefix = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      out.push(prefix + l.content);
    }
  }

  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  if (result.length > MAX_UNIFIED_CHARS) {
    result = result.slice(0, MAX_UNIFIED_CHARS) + "\n...[diff truncated]\n";
  }
  return result;
}

/** Reconstruct the new text from a DiffLine[] produced by {@link computeDiff}. */
export function applyPatch(oldText: string, diff: DiffLine[]): string {
  void oldText; // accepted for API symmetry; the diff carries everything we need
  const lines: string[] = [];
  for (const l of diff) {
    if (l.type === "context" || l.type === "add") {
      lines.push(l.content);
    }
  }
  return lines.join("\n");
}

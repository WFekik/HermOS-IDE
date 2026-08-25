/**
 * Lightweight regex-based symbol extractor for IDE Outline/Go-to-symbol UI (cap: 500 symbols/file, 1MB input).
 * Extracts functions, classes, interfaces, types, consts, and exports without AST overhead.
 */

export type SymbolLanguage =
  | "typescript"
  | "javascript"
  | "tsx"
  | "jsx";

export interface SymbolInfo {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "const"
    | "export"
    | "import";
  /** 1-based line number where the symbol is declared. */
  line: number;
  /** For named exports: the exported name (or "default" for `export default`). */
  exportName?: string;
  /** For functions/arrow consts: the raw parameter list as a string. */
  params?: string;
}

const MAX_CONTENT_BYTES = 1_000_000;
const MAX_SYMBOLS = 500;

// Identifier pattern: matches JS/TS identifiers (including $ and _).
const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Builds an O(log n) line-number resolver using binary search over indexed line starts. */
function makeLineCounter(content: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Best-effort check whether the line containing `index` is a comment line. */
function isCommentLineAt(content: string, index: number): boolean {
  let lineStart = index;
  while (lineStart > 0 && content.charCodeAt(lineStart - 1) !== 10) {
    lineStart--;
  }
  let i = lineStart;
  while (i < content.length) {
    const ch = content[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    break;
  }
  const rest = content.slice(i, i + 2);
  if (rest === "//") return true;
  if (rest === "/*") return true;
  if (content[i] === "*") return true; // block-comment continuation line
  return false;
}

interface ClaimRange {
  start: number;
  end: number;
}

/** Tracks character ranges claimed by earlier patterns to prevent duplicate reports. */
function makeClaimSet() {
  const ranges: ClaimRange[] = [];
  return {
    overlaps(start: number, end: number): boolean {
      for (const r of ranges) {
        if (start < r.end && end > r.start) return true;
      }
      return false;
    },
    claim(start: number, end: number) {
      ranges.push({ start, end });
    },
  };
}

interface RawMatch {
  /** Index of the match in `content`. */
  index: number;
  /** Full match text. */
  full: string;
  /** Captured groups. */
  groups: string[];
}

/** Iterate all matches of a global regex. */
function* matchAll(pattern: RegExp, content: string): Generator<RawMatch> {
  if (!pattern.global) {
    throw new Error("matchAll requires a global regex");
  }
  let m: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(content)) !== null) {
    yield {
      index: m.index,
      full: m[0],
      groups: m.slice(1),
    };
    // Guard against zero-width matches.
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
}

/** Extracts JS/TS symbols from source content up to 500 entries. */
export function extractSymbols(
  content: string,
  language: SymbolLanguage,
): SymbolInfo[] {
  if (typeof content !== "string") return [];
  if (content.length === 0) return [];
  if (content.length > MAX_CONTENT_BYTES) return [];

  const isTS = language === "typescript" || language === "tsx";
  const symbols: SymbolInfo[] = [];
  const claims = makeClaimSet();
  const lineAt = makeLineCounter(content);

  const push = (s: SymbolInfo): boolean => {
    if (symbols.length >= MAX_SYMBOLS) return false;
    symbols.push(s);
    return true;
  };

  // Pattern 1: `export default function NAME(PARAMS)` (also `async`).
  // Emits: kind="function", exportName="default", name=NAME (or "default").
  const exportDefaultFn = new RegExp(
    String.raw`export\s+default\s+(?:async\s+)?function\s*\*?\s*(?:(${IDENT}))?\s*\(([^)]*)\)`,
    "g",
  );
  for (const m of matchAll(exportDefaultFn, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0] || "default";
    const params = (m.groups[1] || "").trim();
    if (!push({
      name,
      kind: "function",
      line: lineAt(m.index),
      exportName: "default",
      params,
    })) return symbols;
  }

  // Pattern 2: `export default class NAME`.
  // Emits: kind="class", exportName="default".
  const exportDefaultClass = new RegExp(
    String.raw`export\s+default\s+class\s+(${IDENT})`,
    "g",
  );
  for (const m of matchAll(exportDefaultClass, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    if (!push({
      name,
      kind: "class",
      line: lineAt(m.index),
      exportName: "default",
    })) return symbols;
  }

  // Pattern 3: `export function NAME(PARAMS)` (also `async`, generators).
  // Emits: kind="function", exportName=NAME.
  const exportFn = new RegExp(
    String.raw`\bexport\s+(?:async\s+)?function\s*\*?\s*(${IDENT})\s*\(([^)]*)\)`,
    "g",
  );
  for (const m of matchAll(exportFn, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    const params = (m.groups[1] || "").trim();
    if (!push({
      name,
      kind: "function",
      line: lineAt(m.index),
      exportName: name,
      params,
    })) return symbols;
  }

  // Pattern 4: `export class NAME` (optionally `extends X`).
  // Emits: kind="class", exportName=NAME.
  const exportClass = new RegExp(
    String.raw`\bexport\s+(?:default\s+)?(?:abstract\s+)?class\s+(${IDENT})`,
    "g",
  );
  for (const m of matchAll(exportClass, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    if (!push({
      name,
      kind: "class",
      line: lineAt(m.index),
      exportName: name,
    })) return symbols;
  }

  // Pattern 5: `export const NAME = (PARAMS) =>` (arrow function).
  // Emits: kind="const", exportName=NAME, params=PARAMS.
  const exportConstArrow = new RegExp(
    String.raw`\bexport\s+const\s+(${IDENT})\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>`,
    "g",
  );
  for (const m of matchAll(exportConstArrow, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    const params = (m.groups[1] || "").trim();
    if (!push({
      name,
      kind: "const",
      line: lineAt(m.index),
      exportName: name,
      params,
    })) return symbols;
  }

  // Pattern 6: `export const NAME = ...` (value/expression). Emits: kind="const", exportName=NAME.
  const exportConstOther = new RegExp(
    String.raw`\bexport\s+const\s+(${IDENT})\s*=`,
    "g",
  );
  for (const m of matchAll(exportConstOther, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    if (!push({
      name,
      kind: "const",
      line: lineAt(m.index),
      exportName: name,
    })) return symbols;
  }

  // Pattern 7: `function NAME(PARAMS)` (non-export, also `async`, generators).
  // Emits: kind="function".
  const fn = new RegExp(
    String.raw`\b(?:async\s+)?function\s*\*?\s*(${IDENT})\s*\(([^)]*)\)`,
    "g",
  );
  for (const m of matchAll(fn, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    const params = (m.groups[1] || "").trim();
    if (!push({
      name,
      kind: "function",
      line: lineAt(m.index),
      params,
    })) return symbols;
  }

  // Pattern 8: `class NAME` (non-export, optionally `extends X`).
  // Emits: kind="class".
  const cls = new RegExp(
    String.raw`\b(?:abstract\s+)?class\s+(${IDENT})`,
    "g",
  );
  for (const m of matchAll(cls, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    if (!push({
      name,
      kind: "class",
      line: lineAt(m.index),
    })) return symbols;
  }

  // Pattern 9: `const NAME = (PARAMS) =>` (non-export arrow).
  // Emits: kind="const", params=PARAMS.
  const constArrow = new RegExp(
    String.raw`\bconst\s+(${IDENT})\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>`,
    "g",
  );
  for (const m of matchAll(constArrow, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    const params = (m.groups[1] || "").trim();
    if (!push({
      name,
      kind: "const",
      line: lineAt(m.index),
      params,
    })) return symbols;
  }

  // Pattern 10: `const NAME = ...` (non-export, non-arrow).
  // Emits: kind="const".
  const constOther = new RegExp(
    String.raw`\bconst\s+(${IDENT})\s*=`,
    "g",
  );
  for (const m of matchAll(constOther, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const name = m.groups[0];
    if (!push({
      name,
      kind: "const",
      line: lineAt(m.index),
    })) return symbols;
  }

  // Pattern 11: `interface NAME {` (TS/TSX only).
  // Emits: kind="interface".
  if (isTS) {
    const iface = new RegExp(
      String.raw`\b(?:export\s+)?interface\s+(${IDENT})\s*(?:<[^>]*>)?\s*\{`,
      "g",
    );
    for (const m of matchAll(iface, content)) {
      if (isCommentLineAt(content, m.index)) continue;
      if (claims.overlaps(m.index, m.index + m.full.length)) continue;
      claims.claim(m.index, m.index + m.full.length);
      const name = m.groups[0];
      if (!push({
        name,
        kind: "interface",
        line: lineAt(m.index),
      })) return symbols;
    }

    // Pattern 12: `type NAME =` (TS/TSX only, also exported).
    // Emits: kind="type".
    const typeAlias = new RegExp(
      String.raw`\b(?:export\s+)?type\s+(${IDENT})\s*(?:<[^>]*>)?\s*=`,
      "g",
    );
    for (const m of matchAll(typeAlias, content)) {
      if (isCommentLineAt(content, m.index)) continue;
      if (claims.overlaps(m.index, m.index + m.full.length)) continue;
      claims.claim(m.index, m.index + m.full.length);
      const name = m.groups[0];
      if (!push({
        name,
        kind: "type",
        line: lineAt(m.index),
      })) return symbols;
    }
  }

  // Pattern 13: `export { NAME1, NAME2 as ALIAS, ... }`.
  // Emits one "export" symbol per exported name (using the local NAME).
  const exportList = new RegExp(
    String.raw`\bexport\s*\{([^}]*)\}`,
    "g",
  );
  for (const m of matchAll(exportList, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const body = m.groups[0] || "";
    const items = body.split(",");
    for (const item of items) {
      // Each item is `NAME` or `NAME as ALIAS` (possibly with `type` prefix).
      const cleaned = item
        .replace(/\/\/.*$/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      if (!cleaned) continue;
      // Strip a leading `type` modifier (TS `export { type Foo }`).
      const noType = cleaned.replace(/^type\s+/, "");
      const parts = noType.split(/\s+as\s+/);
      const local = parts[0].trim();
      if (!local) continue;
      if (!new RegExp(`^${IDENT}$`).test(local)) continue;
      if (!push({
        name: local,
        kind: "export",
        line: lineAt(m.index),
        exportName: local,
      })) return symbols;
    }
  }

  // Pattern 14: `import { NAME1, NAME2 as ALIAS, ... } from "..."`.
  // Emits one "import" symbol per imported name (using the local NAME).
  const importList = new RegExp(
    String.raw`\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]`,
    "g",
  );
  for (const m of matchAll(importList, content)) {
    if (isCommentLineAt(content, m.index)) continue;
    if (claims.overlaps(m.index, m.index + m.full.length)) continue;
    claims.claim(m.index, m.index + m.full.length);
    const body = m.groups[0] || "";
    const items = body.split(",");
    for (const item of items) {
      const cleaned = item
        .replace(/\/\/.*$/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      if (!cleaned) continue;
      const noType = cleaned.replace(/^type\s+/, "");
      const parts = noType.split(/\s+as\s+/);
      const local = parts[parts.length - 1].trim(); // alias if present, else original
      if (!local) continue;
      if (!new RegExp(`^${IDENT}$`).test(local)) continue;
      if (!push({
        name: local,
        kind: "import",
        line: lineAt(m.index),
      })) return symbols;
    }
  }

  // Stable sort by line number and declaration order.
  const indexed = symbols.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    if (a.s.line !== b.s.line) return a.s.line - b.s.line;
    return a.i - b.i;
  });
  return indexed.map((x) => x.s);
}

/** Resolves {@link SymbolLanguage} from file extension, returning null if unsupported. */
export function languageFromExt(filename: string): SymbolLanguage | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".cjs")) return "javascript";
  return null;
}

/**
 * Lightweight regex-based JS/TS linter (caps: 100 diagnostics/file, 1MB input).
 * Catches common pitfalls (`console.log`, `debugger`, `var`, loose equality, empty blocks) with low false-positive rate.
 */

import type { SymbolLanguage } from "@/lib/symbols";

export interface Diagnostic {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  severity: "error" | "warning";
  message: string;
  /** Rule identifier (e.g. "no-console"). */
  rule: string;
}

const MAX_CONTENT_BYTES = 1_000_000;
const MAX_DIAGNOSTICS = 100;

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Compute 1-based line + column of a character index in `content`. */
function lineColOf(content: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

interface Range {
  start: number;
  end: number;
}

/** Computes comment ranges (single-line and block outside string literals) to suppress lint matches inside comments. */
function computeCommentRanges(content: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  let inBlockComment = false;
  let blockStart = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        i += 2;
        ranges.push({ start: blockStart, end: i });
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }

    if (inSingle) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (inTemplate) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      // Template interpolation expressions are unparsed; produces rare false negatives at worst.
      i++;
      continue;
    }

    // Not in any string or comment.
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      blockStart = i;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      let end = i;
      while (end < content.length && content.charCodeAt(end) !== 10) end++;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i++;
      continue;
    }
    i++;
  }

  if (inBlockComment) {
    ranges.push({ start: blockStart, end: content.length });
  }

  return ranges;
}

/** Check whether `index` falls inside any of the comment ranges. */
function isInComment(index: number, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (index >= r.start && index < r.end) return true;
  }
  return false;
}

/** Quick check whether a line (string) starts with a comment marker. */
function isLineCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  );
}

/** Counts unescaped backticks to detect multi-line template literals. */
function unescapedBacktickCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i++; // skip escaped char
      continue;
    }
    if (text[i] === "`") count++;
  }
  return count;
}

interface MatchInfo {
  index: number;
  full: string;
  groups: string[];
}

function* matchAll(pattern: RegExp, content: string): Generator<MatchInfo> {
  if (!pattern.global) throw new Error("matchAll requires a global regex");
  let m: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(content)) !== null) {
    yield { index: m.index, full: m[0], groups: m.slice(1) };
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
}

/** Finds index of inline `//` comment start outside strings and regex literals; returns -1 if none. */
function findInlineLineCommentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  // Set of preceding chars that make a `//` "look like" a comment start.
  const okPrev = new Set([
    " ", "\t", "(", ")", "{", "}", "[", "]", ";", ",", "=", "<", ">",
    "!", "&", "|", "?", ":", "+", "-", "*", "/", "%", "~", "^",
  ]);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      i++; // skip escaped char
      continue;
    }
    if (!inTemplate && ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (!inTemplate && ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inTemplate = !inTemplate;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && ch === "/" && line[i + 1] === "/") {
      const prev = i > 0 ? line[i - 1] : "";
      if (i === 0 || okPrev.has(prev)) {
        return i;
      }
      // Otherwise likely inside a regex literal — keep scanning.
    }
  }
  return -1;
}

/** Lints JS/TS source code with lightweight rules, returning diagnostics capped at 100 entries. */
export function lintContent(
  content: string,
  _language: SymbolLanguage,
): Diagnostic[] {
  if (typeof content !== "string") return [];
  if (content.length === 0) return [];
  if (content.length > MAX_CONTENT_BYTES) return [];

  const diags: Diagnostic[] = [];
  const push = (d: Diagnostic): boolean => {
    if (diags.length >= MAX_DIAGNOSTICS) return false;
    diags.push(d);
    return true;
  };

  const commentRanges = computeCommentRanges(content);
  const lines = content.split("\n");

  // Rule: no-console — `console.X(` calls (warning).
  // Column points at the start of `console`.
  const consoleRe = new RegExp(
    String.raw`\bconsole\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(`,
    "g",
  );
  for (const m of matchAll(consoleRe, content)) {
    if (isInComment(m.index, commentRanges)) continue;
    const { line, column } = lineColOf(content, m.index);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    const method = m.groups[0] || "log";
    if (!push({
      line,
      column,
      severity: "warning",
      message: `Unexpected console statement: console.${method}(`,
      rule: "no-console",
    })) return sortAndReturn(diags);
  }

  // Rule: no-debugger — `debugger` statements (error).
  // Column points at the start of `debugger`.
  const debuggerRe = /\bdebugger\b/g;
  for (const m of matchAll(debuggerRe, content)) {
    if (isInComment(m.index, commentRanges)) continue;
    const { line, column } = lineColOf(content, m.index);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "error",
      message: "Unexpected 'debugger' statement.",
      rule: "no-debugger",
    })) return sortAndReturn(diags);
  }

  // Rule: no-unused-var — flags all `var` declarations in favor of let/const.
  const varRe = /\bvar\s+(?=[A-Za-z_$])/g;
  for (const m of matchAll(varRe, content)) {
    if (isInComment(m.index, commentRanges)) continue;
    const { line, column } = lineColOf(content, m.index);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "warning",
      message: "Avoid 'var' — prefer 'let' or 'const'.",
      rule: "no-unused-var",
    })) return sortAndReturn(diags);
  }

  // Rule: eqeqeq — loose equality `==` / `!=` (warning).
  // Excludes `===`, `!==`, `<=`, `>=`, `=>` via lookbehind/lookahead.
  // Column points at the operator.
  const looseEqRe = /(?<![=!<>])==(?!=)/g;
  for (const m of matchAll(looseEqRe, content)) {
    if (isInComment(m.index, commentRanges)) continue;
    const { line, column } = lineColOf(content, m.index);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "warning",
      message: "Use '===' instead of '==' for strict equality.",
      rule: "eqeqeq",
    })) return sortAndReturn(diags);
  }
  const looseNeqRe = /(?<!!)!=(?!=)/g;
  for (const m of matchAll(looseNeqRe, content)) {
    if (isInComment(m.index, commentRanges)) continue;
    const { line, column } = lineColOf(content, m.index);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "warning",
      message: "Use '!==' instead of '!=' for strict inequality.",
      rule: "eqeqeq",
    })) return sortAndReturn(diags);
  }

  // Rule: no-empty-block — flags empty blocks following control-flow keywords or closing parens.
  const emptyBlockRe = new RegExp(
    String.raw`(?:\)|\belse\b|\bdo\b|\btry\b|\bfinally\b)\s*(\{\s*\})`,
    "g",
  );
  for (const m of matchAll(emptyBlockRe, content)) {
    const braceOffset = m.full.indexOf(m.groups[0]);
    const absIndex = m.index + braceOffset;
    if (isInComment(absIndex, commentRanges)) continue;
    const { line, column } = lineColOf(content, absIndex);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "warning",
      message: "Empty block — missing implementation?",
      rule: "no-empty-block",
    })) return sortAndReturn(diags);
  }

  // Also catch `class Foo {}` / `class Foo extends Bar {}` empty bodies.
  const emptyClassRe = new RegExp(
    String.raw`\bclass\s+(${IDENT})(?:\s+extends\s+${IDENT})?\s*(\{\s*\})`,
    "g",
  );
  for (const m of matchAll(emptyClassRe, content)) {
    const braceOffset = m.full.indexOf(m.groups[1]);
    const absIndex = m.index + braceOffset;
    if (isInComment(absIndex, commentRanges)) continue;
    const { line, column } = lineColOf(content, absIndex);
    const lineText = lines[line - 1] ?? "";
    if (isLineCommentLine(lineText)) continue;
    if (!push({
      line,
      column,
      severity: "warning",
      message: `Empty class body for '${m.groups[0]}'.`,
      rule: "no-empty-block",
    })) return sortAndReturn(diags);
  }

  // Rule: semi — checks for missing semicolon at end of non-continuation statements.
  const safeLastChar = new Set([
    ";", "}", ",", ":", "(", "[", "{", "=", ".",
    "+", "-", "*", "/", "&", "|", "<", ">", "?",
    "!", "~", "^", "%", ")", "]",
    "'", '"', "`", "\\",
  ]);
  const continuationStartChars = new Set([
    ".", "+", "-", "*", "/", "&", "|", "<", ">", "?",
    "!", "~", "^", "%", "=", ":", "}", ")", "]",
  ]);
  // Chars indicating the next line is an expression continuation.
  const prevLineContinuationEndChars = new Set([
    "+", "-", "*", "/", "&", "|", "<", ">", "?",
    "!", "~", "^", "%", "=", ":", ".",
    "(", "[", "{", ",",
  ]);

  let prevLineLastChar: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let line = lines[i];

    // Skip line if first non-whitespace char falls within a comment range.
    const firstNonWsIdx = leadingWhitespaceLength(line);
    if (firstNonWsIdx < line.length) {
      let absOffset = 0;
      for (let k = 0; k < i; k++) absOffset += lines[k].length + 1; // +1 for \n
      absOffset += firstNonWsIdx;
      if (isInComment(absOffset, commentRanges)) {
        prevLineLastChar = null;
        continue;
      }
    }

    const slashSlashIdx = findInlineLineCommentStart(line);
    if (slashSlashIdx !== -1) {
      line = line.slice(0, slashSlashIdx);
    }
    // Trim trailing whitespace (including \r for CRLF).
    let end = line.length;
    while (
      end > 0 &&
      (line[end - 1] === " " ||
        line[end - 1] === "\t" ||
        line[end - 1] === "\r")
    ) {
      end--;
    }
    if (end === 0) {
      // Empty line reset for continuation tracking.
      prevLineLastChar = null;
      continue;
    }

    const trimmed = line.slice(0, end);
    const firstNonWs = trimmed.trimStart();
    if (firstNonWs.startsWith("//")) {
      prevLineLastChar = null;
      continue;
    }
    if (firstNonWs.startsWith("/*")) {
      prevLineLastChar = null;
      continue;
    }
    if (firstNonWs.startsWith("*")) {
      prevLineLastChar = null;
      continue;
    }

    const lastChar = trimmed[end - 1];

    // Check if current line continues previous line's expression.
    const thisLineContinues =
      prevLineLastChar !== null &&
      prevLineContinuationEndChars.has(prevLineLastChar);

    if (safeLastChar.has(lastChar)) {
      prevLineLastChar = lastChar;
      continue;
    }

    // Skip lines inside template literals.
    if (unescapedBacktickCount(trimmed) % 2 !== 0) {
      prevLineLastChar = lastChar;
      continue;
    }

    // Skip lines starting with continuation operators.
    const firstChar = firstNonWs[0];
    if (continuationStartChars.has(firstChar)) {
      prevLineLastChar = lastChar;
      continue;
    }

    // Skip lines that end with `=>` (arrow function continuation).
    if (trimmed.endsWith("=>")) {
      prevLineLastChar = lastChar;
      continue;
    }

    // Skip lines that are a continuation of the previous line's expression.
    if (thisLineContinues) {
      prevLineLastChar = lastChar;
      continue;
    }

    // Point column past last non-whitespace char for semicolon insertion.
    const column = end + 1;
    if (!push({
      line: lineNum,
      column,
      severity: "warning",
      message: "Missing semicolon at end of line.",
      rule: "semi",
    })) return sortAndReturn(diags);
    prevLineLastChar = lastChar;
  }

  return sortAndReturn(diags);
}

/** Count leading whitespace (spaces + tabs) of a line. */
function leadingWhitespaceLength(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
  return n;
}

function sortAndReturn(diags: Diagnostic[]): Diagnostic[] {
  diags.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
  return diags;
}

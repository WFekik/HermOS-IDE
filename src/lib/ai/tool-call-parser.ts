/**
 * Shared tool-call parsing and content-cleaning utilities used by both
 * executor.ts and subagent-executor.ts.
 *
 * Consolidates duplicated logic for:
 *  - Text-fallback tool call parsing (DSML, JSON fences, XML, bare JSON)
 *  - Content cleaning (strip <think> tags, tool-call blocks)
 *  - Non-SSE JSON response parsing (cold-start / non-streaming fallback)
 */

export const THINK_TAGS_RE = /<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*?<\/(?:think|thinking|thought|reasoning|cot|details)>/gi;
export const THINK_UNCLOSED_RE = /<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*$/gi;
export const THINK_MALFORMED_OPEN_RE = /^\s*<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?\s*/gim;
export const THINK_STANDALONE_CLOSE_RE = /<\/(?:think|thinking|thought|reasoning|cot|details)>/gi;
export const TOOL_CALL_FENCE_RE = /```tool_call\s*([\s\S]*?)```/gi;
export const TOOL_CALL_JSON_RE = /\{"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\}/g;
export const XML_TOOL_CALL_RE = /<(?:tool_call|tool_code)>\s*([\s\S]*?)<\/(?:tool_call|tool_code)>/gi;
export const DSML_JOIN = "(?:\\s*[｜|]\\s*)";
export const DSML_TOOL_CALL_RE = new RegExp(`<\\s*${DSML_JOIN}?DSML${DSML_JOIN}tool_calls\\s*>([\\s\\S]*?)<\\/\\s*${DSML_JOIN}?DSML${DSML_JOIN}tool_calls\\s*>`, "gi");
export const DSML_INVOKE_RE = new RegExp(`<\\s*${DSML_JOIN}?DSML${DSML_JOIN}invoke\\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\\s*>([\\s\\S]*?)<\\/\\s*${DSML_JOIN}?DSML${DSML_JOIN}invoke\\s*>`, "gi");
export const DSML_PARAM_RE = new RegExp(`<\\s*${DSML_JOIN}?DSML${DSML_JOIN}parameter\\s+name="([^"]+)"(?:\\s+(string|number|boolean)="true")?\\s*>([\\s\\S]*?)<\\/\\s*${DSML_JOIN}?DSML${DSML_JOIN}parameter\\s*>`, "gi");

/** Match a tool-call start in streaming content (used by BufferedToolCallStream). */
export const STREAM_TOOL_START_RE =
  /```tool_call|<tool_call>|<tool_code>|\{"tool"\s*:\s*"|<[a-zA-Z_][a-zA-Z0-9_]*(\s|>)|<\s*[｜|]?\s*DSML\s*[｜|]\s*(tool_calls|invoke)/i;

/** Match a complete tool-call block in streaming content. */
export const STREAM_TOOL_COMPLETE_RE =
  /```tool_call\s*[\s\S]*?```|<tool_call>\s*[\s\S]*?<\/tool_call>|<tool_code>\s*[\s\S]*?<\/tool_code>|\{"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}|<[a-zA-Z_][a-zA-Z0-9_]*\s+[^>]*?\/>|<\s*[｜|]?\s*DSML\s*[｜|]\s*tool_calls\s*>[\s\S]*?<\/\s*[｜|]?\s*DSML\s*[｜|]\s*tool_calls\s*>|<\s*[｜|]?\s*DSML\s*[｜|]\s*invoke[^>]*>[\s\S]*?<\/\s*[｜|]?\s*DSML\s*[｜|]\s*invoke\s*>/gi;

export interface TextToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Generate a unique but stable-ish ID for a text-parsed tool call.
 */
function makeId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Lenient JSON parser that attempts to recover from common LLM JSON syntax errors
 * such as trailing commas, single quotes, unescaped newlines/tabs in string literals,
 * and unquoted property keys.
 */
export function tryParseLenientJson(str: string): any {
  const trimmed = str.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    /* proceed to lenient recovery */
  }

  // Single string-aware pass that simultaneously:
  //   1. Escapes bare newlines/tabs inside string literals
  //   2. Drops trailing commas before } or ] (only outside strings)
  // A regex for either step is unsafe: string values like "some, } text"
  // contain ,} / ,] sequences that a naive replace would corrupt, even when
  // the regex runs after a separate newline-escape pass.
  let fixed = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) { esc = false; fixed += ch; continue; }
      if (ch === "\\") { esc = true; fixed += ch; continue; }
      if (ch === '"') { inStr = false; fixed += ch; continue; }
      if (ch === "\n") { fixed += "\\n"; continue; }
      if (ch === "\r") { fixed += "\\r"; continue; }
      if (ch === "\t") { fixed += "\\t"; continue; }
      fixed += ch;
    } else {
      if (ch === '"') { inStr = true; fixed += ch; continue; }
      if (ch === ",") {
        // Look ahead past whitespace: if the next real char is } or ], this
        // is a trailing comma — drop it (and the whitespace) entirely.
        let j = i + 1;
        while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
        if (j < trimmed.length && (trimmed[j] === "}" || trimmed[j] === "]")) {
          i = j - 1; // skip comma + whitespace; the loop ++ will land on }/]
          continue;
        }
      }
      fixed += ch;
    }
  }

  try {
    return JSON.parse(fixed);
  } catch {
    /* try next recovery strategy */
  }

  // 3. Try converting single-quoted keys/strings to double quotes
  try {
    const doubleQuoted = fixed.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
    return JSON.parse(doubleQuoted);
  } catch {
    /* try unquoted key recovery */
  }

  // 4. Try wrapping unquoted keys in quotes: {tool: "x"} -> {"tool": "x"}
  try {
    const keyQuoted = fixed.replace(/([{,]\s*)([a-zA-Z0-9_-]+)\s*:/g, '$1"$2":');
    return JSON.parse(keyQuoted);
  } catch {
    return null;
  }
}

/**
 * Helper to extract fenced tool call blocks (including those containing nested code blocks with backticks)
 * using string-aware brace matching.
 */
function extractFencedToolCallBlocks(content: string): Array<{ fullMatch: string; jsonText: string }> {
  const blocks: Array<{ fullMatch: string; jsonText: string }> = [];
  const FENCE_START = /```(?:tool_call|tool_code|json\s+tool_call)\s*/gi;
  let m: RegExpExecArray | null;
  FENCE_START.lastIndex = 0;
  while ((m = FENCE_START.exec(content)) !== null) {
    const startIdx = m.index;
    const contentStart = startIdx + m[0].length;
    const braceStart = content.indexOf("{", contentStart);
    if (braceStart === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let closeBraceIdx = -1;

    for (let i = braceStart; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { closeBraceIdx = i; break; }
      }
    }

    if (closeBraceIdx === -1) {
      const closeFence = content.indexOf("```", contentStart);
      if (closeFence !== -1) {
        const jsonText = content.slice(contentStart, closeFence);
        const fullMatch = content.slice(startIdx, closeFence + 3);
        blocks.push({ fullMatch, jsonText });
      }
      continue;
    }

    const afterBrace = content.slice(closeBraceIdx + 1);
    const closeFenceOffset = afterBrace.indexOf("```");
    if (closeFenceOffset !== -1) {
      const endFenceIdx = closeBraceIdx + 1 + closeFenceOffset + 3;
      const fullMatch = content.slice(startIdx, endFenceIdx);
      const jsonText = content.slice(contentStart, closeBraceIdx + 1 + closeFenceOffset);
      blocks.push({ fullMatch, jsonText });
    } else {
      const jsonText = content.slice(contentStart, closeBraceIdx + 1);
      const fullMatch = content.slice(startIdx, closeBraceIdx + 1);
      blocks.push({ fullMatch, jsonText });
    }
  }
  return blocks;
}

/**
 * Strip all think/reasoning tags and tool-call blocks from content.
 * Collapses excessive blank lines.
 */
export function cleanContent(content: string): string {
  let out = content
    .replace(THINK_TAGS_RE, "")
    .replace(THINK_UNCLOSED_RE, "")
    .replace(THINK_MALFORMED_OPEN_RE, "")
    .replace(THINK_STANDALONE_CLOSE_RE, "");

  // Strip fenced tool call blocks (including nested backticks)
  const fencedBlocks = extractFencedToolCallBlocks(out);
  for (const block of fencedBlocks) {
    out = out.replace(block.fullMatch, "");
  }

  out = out
    .replace(TOOL_CALL_FENCE_RE, "")
    .replace(XML_TOOL_CALL_RE, "")
    .replace(DSML_TOOL_CALL_RE, "");

  // Strip bare JSON tool call blocks using balanced-brace matching
  // Use [^"]+ to match any tool name (including dots and colons like
  // "mcp_server.tool_name"), consistent with parseTextToolCalls.
  const BARER_JSON_START = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*/g;
  let m: RegExpExecArray | null;
  BARER_JSON_START.lastIndex = 0;
  while ((m = BARER_JSON_START.exec(out)) !== null) {
    const startIdx = m.index;
    const argsStartIdx = m.index + m[0].length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closeIdx = -1;
    for (let i = argsStartIdx; i < out.length; i++) {
      const ch = out[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx !== -1) {
      let endIdx = closeIdx + 1;
      if (endIdx < out.length && out[endIdx] === "}") {
        endIdx++;
      }
      out = out.slice(0, startIdx) + out.slice(endIdx);
      BARER_JSON_START.lastIndex = 0;
    }
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Parse text-formatted tool calls (DSML, fences, JSON, XML) from model output. */
export function parseTextToolCalls(content: string): TextToolCall[] {
  const results: TextToolCall[] = [];
  // Strip already-consumed blocks from remainingContent so no format double-parses
  // the same bytes as a different format (e.g. JSON inside a fence or XML block).
  let remainingContent = content;

  // 1. DSML format: <｜DSML｜tool_calls><｜DSML｜invoke name="tool">...<｜DSML｜parameter>...</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>
  let m: RegExpExecArray | null;
  DSML_TOOL_CALL_RE.lastIndex = 0;
  while ((m = DSML_TOOL_CALL_RE.exec(content)) !== null) {
    const block = m[0];
    DSML_INVOKE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = DSML_INVOKE_RE.exec(block)) !== null) {
      const name = im[1];
      const paramsBlock = im[2] ?? "";
      const args: Record<string, unknown> = {};
      DSML_PARAM_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = DSML_PARAM_RE.exec(paramsBlock)) !== null) {
        args[pm[1]] = pm[3] ?? "";
      }
      if (Object.keys(args).length === 0) {
        const parsed = tryParseLenientJson(paramsBlock.trim());
        if (parsed && typeof parsed === "object") {
          Object.assign(args, parsed);
        }
      }
      results.push({ id: makeId(name), name, arguments: JSON.stringify(args) });
    }
    remainingContent = remainingContent.replace(block, "");
  }

  // Handle unclosed DSML invoke tags if tool_calls container tag is not present
  const HAS_DSML_TOOL_CALLS = /<\s*[｜|]?\s*DSML\s*[｜|]\s*tool_calls\s*>/i.test(content);
  const HAS_DSML_INVOKE = /<\s*[｜|]?\s*DSML\s*[｜|]\s*invoke/i.test(content);
  if (!HAS_DSML_TOOL_CALLS && HAS_DSML_INVOKE) {
    const UNCLOSED_INVOKE = new RegExp(`<\\s*${DSML_JOIN}?DSML${DSML_JOIN}invoke\\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\\s*>([\\s\\S]*?)(?:<\\/\\s*${DSML_JOIN}?DSML${DSML_JOIN}invoke\\s*>|$)`, "gi");
    let uim: RegExpExecArray | null;
    while ((uim = UNCLOSED_INVOKE.exec(remainingContent)) !== null) {
      const name = uim[1];
      const paramsBlock = uim[2] ?? "";
      const args: Record<string, unknown> = {};
      DSML_PARAM_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = DSML_PARAM_RE.exec(paramsBlock)) !== null) {
        args[pm[1]] = pm[3] ?? "";
      }
      if (Object.keys(args).length === 0) {
        const parsed = tryParseLenientJson(paramsBlock.trim());
        if (parsed && typeof parsed === "object") {
          Object.assign(args, parsed);
        }
      }
      if (Object.keys(args).length > 0) {
        results.push({ id: makeId(name), name, arguments: JSON.stringify(args) });
        remainingContent = remainingContent.replace(uim[0], "");
      }
    }
  }

  // 2. XML <tool_call> / <tool_code> blocks — parse and strip before bare JSON
  //    so the JSON inside them doesn't get parsed a second time.
  XML_TOOL_CALL_RE.lastIndex = 0;
  while ((m = XML_TOOL_CALL_RE.exec(remainingContent)) !== null) {
    const fullMatch = m[0];
    const parsed = tryParseLenientJson(m[1].trim());
    if (parsed && typeof parsed.tool === "string") {
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
      results.push({ id: makeId(parsed.tool), name: parsed.tool, arguments: JSON.stringify(args) });
    }
    remainingContent = remainingContent.replace(fullMatch, "");
  }

  // Also check for unclosed XML <tool_call> / <tool_code> tags
  const UNCLOSED_XML_RE = /<(?:tool_call|tool_code)>\s*(\{[\s\S]*)/gi;
  while ((m = UNCLOSED_XML_RE.exec(remainingContent)) !== null) {
    const fullMatch = m[0];
    const parsed = tryParseLenientJson(m[1].trim());
    if (parsed && typeof parsed.tool === "string") {
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
      results.push({ id: makeId(parsed.tool), name: parsed.tool, arguments: JSON.stringify(args) });
      remainingContent = remainingContent.replace(fullMatch, "");
    }
  }

  // 3. Fenced ```tool_call blocks (including nested backticks) — parse and strip before bare JSON
  const fencedBlocks = extractFencedToolCallBlocks(remainingContent);
  for (const block of fencedBlocks) {
    const parsed = tryParseLenientJson(block.jsonText.trim());
    if (parsed && typeof parsed.tool === "string") {
      const name = parsed.tool;
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
      results.push({ id: makeId(name), name, arguments: JSON.stringify(args) });
    }
    remainingContent = remainingContent.replace(block.fullMatch, "");
  }

  // Fallback regex for standard fences if any missed
  TOOL_CALL_FENCE_RE.lastIndex = 0;
  while ((m = TOOL_CALL_FENCE_RE.exec(remainingContent)) !== null) {
    const fullMatch = m[0];
    const parsed = tryParseLenientJson(m[1].trim());
    if (parsed && typeof parsed.tool === "string") {
      const name = parsed.tool;
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
      results.push({ id: makeId(name), name, arguments: JSON.stringify(args) });
    }
    remainingContent = remainingContent.replace(fullMatch, "");
  }

  // 4. Bare JSON {"tool":"...","args":{...}} — run only on remaining content
  //    that hasn't already been consumed by DSML / XML / fence parsers above.
  const BARER_JSON_START = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*/gi;
  BARER_JSON_START.lastIndex = 0;
  while ((m = BARER_JSON_START.exec(remainingContent)) !== null) {
    const name = m[1];
    const startIdx = m.index;
    const argsStartIdx = m.index + m[0].length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closeIdx = -1;
    for (let i = argsStartIdx; i < remainingContent.length; i++) {
      const ch = remainingContent[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx === -1) continue;
    const argsRaw = remainingContent.slice(argsStartIdx, closeIdx + 1);
    if (closeIdx + 1 < remainingContent.length && remainingContent[closeIdx + 1] === "}") {
      const fullCall = remainingContent.slice(startIdx, closeIdx + 2);
      const parsed = tryParseLenientJson(fullCall);
      if (parsed && typeof parsed.tool === "string" && parsed.args && typeof parsed.args === "object") {
        results.push({ id: makeId(name), name, arguments: JSON.stringify(parsed.args) });
      }
    } else {
      const parsed = tryParseLenientJson(`{"tool":"${name}","args":${argsRaw}}`);
      if (parsed && typeof parsed.tool === "string" && parsed.args && typeof parsed.args === "object") {
        results.push({ id: makeId(name), name, arguments: JSON.stringify(parsed.args) });
      }
    }
  }

  // Also check for single-quoted or lenient bare JSON: {'tool': '...', 'args': {...}} or {tool: "...", args: {...}}
  const LENIENT_BARE_JSON_START = /\{\s*(?:'tool'|tool)\s*:\s*['"]([^'"]+)['"]\s*,\s*(?:'args'|args)\s*:\s*/gi;
  LENIENT_BARE_JSON_START.lastIndex = 0;
  while ((m = LENIENT_BARE_JSON_START.exec(remainingContent)) !== null) {
    const name = m[1];
    const startIdx = m.index;
    const argsStartIdx = m.index + m[0].length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closeIdx = -1;
    for (let i = argsStartIdx; i < remainingContent.length; i++) {
      const ch = remainingContent[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"' || ch === "'") inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx !== -1) {
      const fullCall = remainingContent.slice(startIdx, closeIdx + 2);
      const parsed = tryParseLenientJson(fullCall);
      if (parsed && typeof parsed.tool === "string" && parsed.args && typeof parsed.args === "object") {
        results.push({ id: makeId(parsed.tool), name: parsed.tool, arguments: JSON.stringify(parsed.args) });
      }
    }
  }

  return results;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Extract a human-readable message from an upstream API error object
 * (SSE `data: {"error": ...}` frames or non-streaming JSON error bodies).
 * Falls back to JSON-stringifying when the shape is unexpected.
 */
export function extractUpstreamError(err: unknown): string {
  if (typeof err === "string") return err.slice(0, 500);
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; error?: unknown; type?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message.trim()) return e.message.slice(0, 500);
    if (typeof e.error === "string" && e.error.trim()) return e.error.slice(0, 500);
  }
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return "Unknown provider error";
  }
}

/**
 * Parse a non-SSE JSON response body (cold-start / non-streaming fallback).
 * Returns null if the body is not valid JSON or has no usable content/tool_calls.
 * Throws when the body carries an `error` field so the real upstream reason
 * surfaces instead of a silent empty response.
 */
export function parseNonStreamingResponse(body: string): { content?: string; thinking?: string; toolCalls?: ParsedToolCall[] } | null {
  // Parse first, then check `error` OUTSIDE the swallow-catch below so the
  // upstream reason propagates instead of being reduced to a silent null.
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (json?.error) {
    const err = new Error(`Provider error: ${extractUpstreamError(json.error)}`) as Error & {
      status?: number;
      statuslessUpstream?: boolean;
    };
    if (typeof json.error?.status === "number") err.status = json.error.status;
    // Statusless upstream error bodies (some gateways return HTTP 200 with
    // `{"error": "Internal server error"}` for request-shape rejections —
    // unsupported `reasoning_effort`, `max_tokens` over the documented cap,
    // missing mandatory `reasoning_content` echo). Flagged so the executor's
    // retry ladder can probe a stripped request.
    if (err.status === undefined) err.statuslessUpstream = true;
    throw err;
  }
  try {
    const choice = json?.choices?.[0];
    if (!choice?.message) return null;
    const result: { content?: string; thinking?: string; toolCalls?: ParsedToolCall[] } = {};

    const message = choice.message;
    const reasoning = (message.reasoning_content ?? message.reasoning ?? message.thinking ?? message.reasoning_text) as string | undefined;
    if (reasoning) {
      result.thinking = reasoning.trim();
    }

    if (message.content) {
      const clean = cleanContent(message.content);
      if (clean) {
        if (!reasoning || clean.trim() !== reasoning.trim()) {
          result.content = clean;
        }
      }
    }

    if (choice.message.tool_calls?.length) {
      const calls = choice.message.tool_calls
        .filter((tc: any) => tc?.function?.name?.trim())
        .map((tc: any) => ({
          id: tc.id ?? "",
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
        }));
      if (calls.length > 0) result.toolCalls = calls;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}


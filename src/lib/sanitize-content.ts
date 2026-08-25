/**
 * Sanitizes assistant responses by stripping leaked tool artifacts, XML tags, think blocks, and bare JSON.
 * Provides `sanitizeContent` (full pipeline) and `sanitizeStreamingDelta` (streaming-safe subset).
 */

export const KNOWN_TOOL_NAMES = new Set<string>([
  // File system
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "multi_edit",
  "glob",
  // Shell
  "run_command",
  // Search / explore
  "grep",
  // Web
  "web_search",
  "http_fetch",
  // Browser
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_extract",
  // Misc
  "mcp_call",
  // Office / docs
  "generate_ppt",
  "generate_doc",
  "generate_pdf",
  "read_doc",
  // Sub-agents
  "spawn_subagent",
  "get_subagent",
  // Todo
  "todo_write",
  "todo_read",
  "todo_clear",
]);

const EMOJI_TEST_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\uFFFD]/u;

/** Safe emoji stripper — removes decorative emojis and stray Unicode replacement chars while preserving markdown syntax & clean spacing. */
export function stripEmojis(text: string): string {
  if (!text) return "";
  if (
    !EMOJI_TEST_REGEX.test(text) &&
    !/[ \t]{2,}/.test(text) &&
    !text.includes("**") &&
    !text.includes("__")
  ) {
    return text;
  }
  let cleaned = text.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\uFFFD]+/gu,
    "",
  );
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  return cleaned.replace(/\*\*\s*\*\*/g, "").replace(/__\s*__/g, "");
}

/** Clean up empty bold/italic syntax markers (e.g. ** ** or ****) left by text processing. */
function cleanupEmptyMarkdownMarkers(text: string): string {
  if (!text.includes("**") && !text.includes("__")) return text;
  return text.replace(/\*\*\s*\*\*/g, "").replace(/__\s*__/g, "");
}

/** Fast sanitizer for pure thinking segments — strips think tags and trims. */
export function sanitizeThinkingContent(content: string): string {
  if (!content) return "";
  if (!content.includes("<")) return content.trim();
  let out = content.replace(/<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*?<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");
  out = out.replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");
  // Unclosed tags are only stripped to end-of-string when they open a
  // genuine thinking block (line start, not inside a code fence) — a bare
  // <thinking> literal mid-sentence is model text, never erased.
  out = out.replace(
    /<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?[\s\S]*$/gi,
    (match, offset: number) => {
      const lineStart = out.lastIndexOf("\n", offset - 1) + 1;
      if (!/^[ \t]*$/.test(out.slice(lineStart, offset))) return match;
      if (isInsideCodeFence(out, offset)) return match;
      return "";
    },
  );
  out = out.replace(
    /^\s*<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?\s*/gim,
    (match, offset: number) => (isInsideCodeFence(out, offset) ? match : ""),
  );
  return out.trim();
}

/**
 * Extract thinking blocks (explicit think tags and leading un-tagged CoT self-talk)
 * from assistant content, returning separated thinking and response content.
 */
export function extractThinkingAndContent(
  content: string,
  existingThinking?: string,
): { thinking: string; content: string } {
  if (!content) return { thinking: existingThinking ?? "", content: "" };

  let thinking = existingThinking ?? "";
  let cleanContent = content;

  // 1. Extract explicit think tags (<think>, <thinking>, <thought>, <reasoning>, <cot>, <details>)
  const thinkTagRegex = /<(?:think|thinking|thought|reasoning|cot|details)>([\s\S]*?)<\/(?:think|thinking|thought|reasoning|cot|details)>/gi;
  let match: RegExpExecArray | null;
  while ((match = thinkTagRegex.exec(cleanContent)) !== null) {
    if (match[1] && match[1].trim()) {
      thinking = thinking ? `${thinking}\n\n${match[1].trim()}` : match[1].trim();
    }
  }
  cleanContent = cleanContent.replace(thinkTagRegex, "");

  cleanContent = cleanContent.replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");

  return {
    thinking: thinking.trim(),
    content: cleanContent.trim(),
  };
}

/** True when `offset` in `content` lies inside an unclosed ``` code fence. */
function isInsideCodeFence(content: string, offset: number): boolean {
  return content.slice(0, offset).split("```").length % 2 === 0;
}

const LEAK_CHECK_REGEX = /[<`{\[\r\n]|Tool\s+|tool_/i;

export function sanitizeContent(content: string): string {
  if (!content) return "";
  if (!LEAK_CHECK_REGEX.test(content) && !content.includes("**") && !content.includes("__")) {
    return stripEmojis(content).trim();
  }

  let out = content;

  // 1. ```tool_call fenced blocks (closed or unclosed-to-end-of-string).
  //    Non-greedy [\s\S]*? finds a closing ```; if none exists the
  //    alternation falls through to $ (end of string), stripping the leak.
  out = out.replace(/```tool_call[^\n]*\n[\s\S]*?(?:```|$)/g, "");

  // 2. ```xml fenced blocks that wrap <tool_call> or <tool_result>.
  //    The model sometimes wraps tool syntax in an xml fence instead of
  //    a tool_call fence. Strip the entire fence (closed or unclosed).
  out = out.replace(/```xml\s*<tool_call[\s\S]*?(?:```|$)/gi, "");
  out = out.replace(/```xml\s*<tool_result[\s\S]*?(?:```|$)/gi, "");
  out = out.replace(/```xml\s*<tool_code[\s\S]*?(?:```|$)/gi, "");

  // 3. <tool_call>…</tool_call> and <tool_code>…</tool_code> XML
  //    (closed and unclosed-to-end-of-string).
  out = out.replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  out = out.replace(/<tool_code[^>]*>[\s\S]*?<\/tool_code>/gi, "");
  out = out.replace(/<tool_call[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<tool_code[^>]*>[\s\S]*$/gi, "");

  // 4. DSML format: <DSML|tool_calls>...<DSML|invoke name="...">...</DSML|invoke>...</DSML|tool_calls>
  //    Also handle the alternative <DSML｜tool_calls> with full-width pipe and spaces like < | DSML | tool_calls >.
  const D = "(?:\\s*[｜|]\\s*)";
  out = out.replace(new RegExp(`<\\s*${D}?DSML${D}tool_calls\\s*>[\\s\\S]*?<\\/\\s*${D}?DSML${D}tool_calls\\s*>`, "gi"), "");
  out = out.replace(new RegExp(`<\\s*${D}?DSML${D}invoke[^>]*>[\\s\\S]*?<\\/\\s*${D}?DSML${D}invoke\\s*>`, "gi"), "");
  out = out.replace(new RegExp(`<\\s*${D}?DSML${D}invoke[^>]*>[\\s\\S]*$`, "gi"), "");

  // 6. Think tags (think, thinking, thought, reasoning, cot, details - closed and unclosed-to-end-of-string).
  out = out.replace(/<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*?<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");

  // Unclosed think tags are only stripped to end-of-string when they open
  // a genuine thinking block: the tag must be at message start or stand
  // alone on its own line, and it must not sit inside a code fence.
  // A bare <think> literal embedded mid-sentence is user text — never
  // erase legitimate content past it.
  out = out.replace(
    /<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?[\s\S]*$/gi,
    (match, offset: number) => {
      const lineStart = out.lastIndexOf("\n", offset - 1) + 1;
      if (!/^[ \t]*$/.test(out.slice(lineStart, offset))) return match;
      if (isInsideCodeFence(out, offset)) return match;
      return "";
    },
  );
  out = out.replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");
  out = out.replace(
    /^\s*<(?:think|thinking|thought|reasoning|cot|details)[a-zA-Z0-9_-]*>?\s*/gim,
    (match, offset: number) => (isInsideCodeFence(out, offset) ? match : ""),
  );

  // 6. "Tool "X" result (ok=…): …" / "Tool "X" succeeded: …" /
  //    "Tool "X" failed: …" lines — all variants. The model sometimes
  //    narrates tool results as prose; strip the whole line.
  out = out.replace(
    /^\s*Tool\s+"[^"]+"\s+(?:result(?:\s*\([^)]*\))?\s*:|succeeded\s*:|failed\s*:).*$/gmi,
    "",
  );

  // 7. Bare `tool_result:` prefix lines.
  out = out.replace(/^\s*tool_result\s*:.*$/gmi, "");

  // 8. Bare-tool-name line followed by narration: e.g.
  //      explore
  //      I'll explore the workspace…
  //    Strip the bare tool-name line if it's a known tool. The narration
  //    line is preserved (we only consume the tool-name line + its
  //    trailing newline).
  out = out.replace(
    /^([a-z_]+)\r?\n(I'll|I will|Let me|Let's|Now|First|I'm going to)\b/gm,
    (_match, name: string, _narr: string) => {
      if (KNOWN_TOOL_NAMES.has(name)) {
        return _narr;
      }
      return _match;
    },
  );

  // 9. Model self-instruction lines: [Response interrupted …] /
  //    [Only one tool …]. Not anchored to start-of-line so they're
  //    stripped even if embedded in a sentence.
  out = out.replace(
    /\[(?:Response\s+interrupted[^\]]*|Only\s+one\s+tool[^\]]*)\]/gi,
    "",
  );

  // 10. Bare JSON tool calls: {"tool":"<name>","args":{…}}.
  //     Uses balanced-brace matching so multiline/long JSON payloads (like 200-line write_file)
  //     or payloads containing braces are cleanly stripped instead of leaking into text prose.
  //     Removal ranges are collected over the original string in one linear pass,
  //     then removed in a single rebuild (no full-string rescans after each removal).
  const BARER_JSON_START = /\{\s*"tool"\s*:\s*"([a-zA-Z0-9_-]+)"\s*,\s*"args"\s*:\s*/g;
  let jsonMatch: RegExpExecArray | null;
  BARER_JSON_START.lastIndex = 0;
  const jsonRemovals: Array<[number, number]> = [];
  let lastRemovalEnd = 0;
  while ((jsonMatch = BARER_JSON_START.exec(out)) !== null) {
    const toolName = jsonMatch[1];
    const matchStart = jsonMatch.index;
    if (matchStart < lastRemovalEnd) continue;
    const startIdx = matchStart + jsonMatch[0].length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closeIdx = -1;
    for (let i = startIdx; i < out.length; i++) {
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
      if (KNOWN_TOOL_NAMES.has(toolName)) {
        jsonRemovals.push([matchStart, endIdx]);
        lastRemovalEnd = endIdx;
      }
    }
  }
  if (jsonRemovals.length > 0) {
    let rebuilt = "";
    let cursor = 0;
    for (const [start, end] of jsonRemovals) {
      rebuilt += out.slice(cursor, start);
      cursor = end;
    }
    rebuilt += out.slice(cursor);
    out = rebuilt;
  }

  // 12. Collapse 3+ consecutive newlines (introduced by the strippage
  //     above) down to a single blank line.
  out = out.replace(/\n{3,}/g, "\n\n");

  // 13. Strip empty markdown markers (** **) and decorative emojis safely.
  out = stripEmojis(out);
  out = cleanupEmptyMarkdownMarkers(out);

  // 14. Trim leading/trailing whitespace.
  out = out.trim();

  return out;
}

/** Streaming-safe delta chunk sanitizer stripping self-contained patterns without breaking cross-chunk tokens. */
export function sanitizeStreamingDelta(delta: string): string {
  if (!delta) return "";

  let out = delta;

  // Closed ```tool_call fenced blocks only (unclosed would eat the
  // rest of the chunk and the close might arrive in the next delta).
  out = out.replace(/```tool_call[^\n]*\n[\s\S]*?```/g, "");

  // Closed ```xml fences that wrap tool syntax.
  out = out.replace(/```xml\s*<tool_call[\s\S]*?```/gi, "");
  out = out.replace(/```xml\s*<tool_result[\s\S]*?```/gi, "");
  out = out.replace(/```xml\s*<tool_code[\s\S]*?```/gi, "");

  // Closed <tool_call> / <tool_code> / <tool_result> / <think> XML.
  out = out.replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/gi, "");
  out = out.replace(/<tool_code[^>]*>[\s\S]*?<\/tool_code>/gi, "");
  out = out.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi, "");
  out = out.replace(/<(?:think|thinking|thought|reasoning|cot|details)>[\s\S]*?<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");
  out = out.replace(/<\/(?:think|thinking|thought|reasoning|cot|details)>/gi, "");

  // Closed DSML blocks (both | and ｜ variants, with flexible spaces).
  out = out.replace(/<\s*[｜|]?\s*DSML\s*[｜|]\s*tool_calls\s*>[\s\S]*?<\/\s*[｜|]?\s*DSML\s*[｜|]\s*tool_calls\s*>/gi, "");
  out = out.replace(/<\s*[｜|]?\s*DSML\s*[｜|]\s*invoke[^>]*>[\s\S]*?<\/\s*[｜|]?\s*DSML\s*[｜|]\s*invoke\s*>/gi, "");

  // Single-line tool-result echo variants (safe — they're line-anchored).
  out = out.replace(
    /^\s*Tool\s+"[^"]+"\s+(?:result(?:\s*\([^)]*\))?\s*:|succeeded\s*:|failed\s*:).*$/gmi,
    "",
  );

  // Bare `tool_result:` prefix lines.
  out = out.replace(/^\s*tool_result\s*:.*$/gmi, "");

  // Model self-instruction snippets.
  out = out.replace(
    /\[(?:Response\s+interrupted[^\]]*|Only\s+one\s+tool[^\]]*)\]/gi,
    "",
  );

  // Closed bare JSON tool calls (only if both braces are in this delta).
  out = out.replace(
    /\{\s*"tool"\s*:\s*"([a-z_]+)"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g,
    (match, toolName: string) =>
      KNOWN_TOOL_NAMES.has(toolName) ? "" : match,
  );

  // Bare-tool-name + narration pattern. Safe because the regex requires
  // both lines in the same string; if the narration is in the next
  // chunk, this simply doesn't match (the full sanitizer catches it
  // later on the accumulated content).
  out = out.replace(
    /^([a-z_]+)\r?\n(I'll|I will|Let me|Let's|Now|First|I'm going to)\b/gm,
    (_match, name: string, _narr: string) =>
      KNOWN_TOOL_NAMES.has(name) ? _narr : _match,
  );

  // Strip empty markdown markers (** **) and decorative emojis safely.
  out = stripEmojis(out);
  out = cleanupEmptyMarkdownMarkers(out);

  return out;
}

/**
 * Automatically scrubs sensitive secrets (API keys, private keys, database URIs, JWTs, AWS credentials)
 * from prompt text before sending to remote LLM APIs.
 */
export function scrubSensitiveSecrets(text: string, customRegex?: string): string {
  if (!text) return text;
  let clean = text;

  // 1. Common API Keys (OpenAI, Anthropic, GitHub, Slack, Google)
  clean = clean.replace(/\b(sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|xoxb-[A-Za-z0-9_-]{10,}|AIzaSy[A-Za-z0-9_-]{33})\b/g, "[REDACTED_API_KEY]");

  // 2. Private Keys (RSA, EC, OPENSSH)
  clean = clean.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");

  // 3. Database Connection Strings
  clean = clean.replace(/\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi, "$1://[REDACTED_DB_CREDENTIALS]@host/db");

  // 4. AWS Secret Access Keys & JWTs
  clean = clean.replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]");
  clean = clean.replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED_JWT_TOKEN]");

  // 5. Custom user regex pattern
  if (customRegex && customRegex.trim()) {
    try {
      const rx = new RegExp(customRegex.trim(), "g");
      clean = clean.replace(rx, "[REDACTED_CUSTOM_SECRET]");
    } catch {
      /* ignore invalid custom regex */
    }
  }

  return clean;
}

/**
 * Parser for inline @mentions (@file, @skill, @mcp, @agent, bare paths) and
 * leading slash commands (/clear, /compact, /agent, /model, /help) in composer inputs.
 */


export type MentionType = "file" | "folder" | "skill" | "mcp" | "agent" | "terminal" | "git" | "rule";

export interface ParsedMention {
  type: MentionType;
  /** e.g. "src/math.ts" for file, "web-search" for skill */
  id: string;
  /** The full matched text, e.g. "@file:src/math.ts". */
  raw: string;
  startIndex: number;
  endIndex: number;
}

export interface ParsedCommand {
  /** Lowercased command name without the leading slash, e.g. "clear". */
  command: string;
  /** Everything after the command on the first line, trimmed. */
  args: string;
  /** The full matched text, e.g. "/clear" or "/agent coder". */
  raw: string;
}

// Characters that should never appear inside a mention id. This is the
// negative space — anything that's NOT one of these is allowed.
const ID_STOP = /[\s@<>[\]{}`|\\()'",;:!]/;

// Matches typed mentions (@type:id) supporting bare tokens and open/closed quotes.
// Capture order (2..6): closed-double | closed-single | open-double | open-single | bare.
const TYPED_MENTION_RE =
  /@(file|folder|skill|mcp|agent|terminal|git|rule):(?:"([^"]+)"|'([^']+)'|"([^"]*)|'([^']*)|([^\s@<>[\]{}`|\\()'",;:!]+))/g;

// Matches bare file mentions requiring relative/absolute prefix or dot-extension.
const BARE_FILE_MENTION_RE =
  /@(?:\.{1,2}\/[^\s@<>[\]{}`|\\()'",;:!]+|[a-zA-Z0-9._\-/\\]+\.[a-zA-Z][a-zA-Z0-9]*)/g;

const KNOWN_COMMANDS = new Set(["clear", "compact", "agent", "model", "help"]);

/** Parse all @mentions in document order with typed mentions taking precedence over bare paths. */
export function parseMentions(text: string): ParsedMention[] {
  if (!text || typeof text !== "string") return [];
  const out: ParsedMention[] = [];
  // Track claimed character ranges so the bare matcher doesn't double-count a
  // span already matched by the typed matcher.
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) =>
    taken.some(([a, b]) => s < b && e > a);

  // 1. Typed mentions.
  TYPED_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPED_MENTION_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const type = m[1] as MentionType;
    // Groups 2-6: closed-double, closed-single, open-double, open-single, bare.
    const id = m[2] || m[3] || m[4] || m[5] || m[6] || "";
    if (!id) continue;
    if (overlaps(start, end)) continue;
    out.push({ type, id, raw: m[0], startIndex: start, endIndex: end });
    taken.push([start, end]);
  }

  // 2. Bare file-path mentions.
  BARE_FILE_MENTION_RE.lastIndex = 0;
  while ((m = BARE_FILE_MENTION_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    // The captured group is everything after `@`.
    const id = m[0].slice(1);
    if (!id) continue;
    // Defensive: a trailing punctuation char like `.` at end of sentence
    // (e.g. "see @file.txt.") should be stripped. The regex already stops at
    // most punctuation, but a trailing `.` on a bare path can sneak through
    // when the extension capture is greedy. Trim a single trailing `.`.
    const trimmedId = id.endsWith(".") && id.length > 1 ? id.slice(0, -1) : id;
    const raw = trimmedId === id ? m[0] : m[0].slice(0, -1);
    const rawEnd = start + raw.length;
    out.push({
      type: "file",
      id: trimmedId,
      raw,
      startIndex: start,
      endIndex: rawEnd,
    });
    taken.push([start, rawEnd]);
  }

  out.sort((a, b) => a.startIndex - b.startIndex);
  return out;
}

/** Parse leading slash command and args from first line. Case-insensitive; returns null if unknown. */
export function parseCommands(text: string): ParsedCommand | null {
  if (!text || typeof text !== "string") return null;
  // Allow leading whitespace, then `/`, then a word, then optionally `args`
  // until the end of the first line.
  const m = /^\s*\/([a-zA-Z][a-zA-Z0-9_-]*)[ \t]*([^\r\n]*)?/.exec(text);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!KNOWN_COMMANDS.has(command)) return null;
  const args = (m[2] || "").trim();
  const raw = m[0].trim();
  return { command, args, raw };
}

/** Strip leading slash command line from text, returning remaining content. */
export function stripCommand(text: string): string {
  if (!text) return "";
  // Remove the first line if it's a command. Keep everything after the first
  // newline (the rest of the message after the command).
  const nl = text.indexOf("\n");
  if (nl === -1) return "";
  return text.slice(nl + 1).trim();
}

// Silence the unused-import lint for ID_STOP (kept for documentation / future use).
void ID_STOP;

/**
 * The agent's system prompt: the IDE baseline, the user's own instructions and
 * the run-specific context blocks.
 *
 * Kept in one module so the assembly is testable and the two prompt variants
 * (native function calling vs. the text fallback) can never drift.
 */

/**
 * The IDE's baseline rules. Deliberately short: every line is paid for on
 * every request. Framework-agnostic on purpose — the agent must follow the
 * project's own conventions, not a hardcoded stack.
 */
export const BASE_SYSTEM_RULES = `- GROUND TRUTH: base claims only on tool output. Find files with grep/glob first; read targeted ranges. Never re-read identical ranges.
- SURGICAL EDITS: sequential, character-exact diffs. Match the surrounding style, types and architecture. Never write placeholders, stubs or TODOs.
- PROVE IT: verify before finishing (build, typecheck, lint, tests). On failure: read the output, fix the root cause, retry — a failure is never "done".
- SECRETS: never print or commit real keys, tokens or secrets.
- TASK TRACKING: for multi-step work, keep a todo list (todo_write) so progress stays visible.
- QUESTIONS: ask only when the requirement is genuinely ambiguous (ask_question); never ask what the code answers.
- CONCISE: use workspace-relative paths. Put the detailed report in an artifact (create_artifact) and keep a short résumé in the chat.
- SUBAGENTS: spawn_subagent runs in the background. Prefer ending your turn while the workers run — only keep iterating when a small step is genuinely needed; their reports are delivered automatically, so never poll or loop-wait.`;

export interface SystemPromptParts {
  /** The baseline (or the text-fallback variant of it). */
  base: string;
  /** The user's own instructions: IDE settings, agent preset or the saved conversation prompt. */
  userInstructions?: string;
  /** Workspace rules (AGENTS.md and friends). */
  workspaceRules?: string;
  /** The active mode section (Chat / Architect / Agent). */
  toolSection?: string;
  /** Runtime capabilities detected client-side. */
  capabilities?: string;
  /** The build environment (platform, cwd, ports). */
  environment?: string;
  /** The integrations discovery block. */
  discovery?: string;
  /** The original request, re-stated as the mission. */
  mission?: string;
  /** Mechanical response rules (language, tree format) — always last. */
  responseRules?: string;
}

/**
 * Assemble the system prompt.
 *
 * The baseline always applies; the user's instructions are layered on top of
 * it instead of replacing it (a custom prompt must not silently drop every
 * baseline rule) and sit after the context blocks so they carry the most
 * weight. The enforced limits — mode walls, permission rules — live in code,
 * not in the prompt, so no instruction can widen them.
 */
export function composeSystemPrompt(parts: SystemPromptParts, minimal = false): string {
  if (minimal) return parts.base + (parts.toolSection ?? "");
  const userInstructions = parts.userInstructions?.trim()
    ? `\n\n## User instructions (from the IDE settings — they override the defaults above where they conflict)\n${parts.userInstructions.slice(0, 8000)}`
    : "";
  return (
    parts.base +
    (parts.workspaceRules ?? "") +
    (parts.toolSection ?? "") +
    (parts.capabilities ?? "") +
    (parts.environment ?? "") +
    (parts.discovery ?? "") +
    (parts.mission ?? "") +
    userInstructions +
    (parts.responseRules ?? "")
  );
}

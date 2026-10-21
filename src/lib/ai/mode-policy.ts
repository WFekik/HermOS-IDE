import { isReadOnlyTool } from "@/lib/permissions";
import type { AgentMode } from "@/lib/types";
import { PUBLIC_BUILTIN_TOOLS } from "./tools";

/** Subagent orchestration tools allowed in Architect mode (delegated to read-only toolsets). */
const ARCHITECT_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "spawn_subagent",
  "get_subagent",
  "message_subagent",
]);

let readOnlyCache: ReadonlySet<string> | null = null;
let allowedCache: ReadonlySet<string> | null = null;

/**
 * Read-only tools allowed in Architect mode. Computed lazily because this
 * module is imported by subagent-executor, which sits inside the tools.ts
 * import cycle — touching PUBLIC_BUILTIN_TOOLS at module scope would read an
 * uninitialized binding.
 */
export function architectReadOnlyTools(): ReadonlySet<string> {
  if (!readOnlyCache) {
    readOnlyCache = new Set(
      PUBLIC_BUILTIN_TOOLS.filter((t) => isReadOnlyTool(t.name)).map((t) => t.name),
    );
  }
  return readOnlyCache;
}

/** Everything architect mode may invoke: read-only tools + orchestration + artifacts. */
export function architectAllowedTools(): ReadonlySet<string> {
  if (!allowedCache) {
    allowedCache = new Set([
      ...architectReadOnlyTools(),
      ...ARCHITECT_SUBAGENT_TOOLS,
      "create_artifact",
    ]);
  }
  return allowedCache;
}

/**
 * Mode-level tool gate shared by the main agent and subagent workers: chat
 * blocks all tool execution, architect is read-only, agent is fully enabled
 * (still subject to the user's permission settings). Returns the deny reason,
 * or null when the mode permits the tool.
 */
export function modeToolDenyReason(mode: AgentMode, toolName: string): string | null {
  if (mode === "chat") {
    return "Tool execution is disabled in Chat mode. Switch to Agent or Architect mode to use tools.";
  }
  if (mode === "architect" && !architectAllowedTools().has(toolName)) {
    return `Tool '${toolName}' is blocked in Architect mode (Architect mode is read-only for planning & architecture). Switch to Agent mode to modify files or execute commands.`;
  }
  return null;
}

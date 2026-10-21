/**
 * Pure permission classification core — dependency-free and safe for client bundles.
 * `@/lib/permissions` re-exports everything from here and adds the DB persistence layer.
 */

export type PermissionAction =
  | "file.read"
  | "file.write"
  | "command.run"
  | "command.outside_workspace"
  | "browser.open"
  | "browser.click"
  | "browser.type"
  | "web.fetch"
  | "web.search"
  | "mcp.call"
  | "subagent.spawn"
  | "subagent.get"
  | "subagent.message"
  | "question.ask";

export type PermissionMode = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: PermissionAction;
  mode: PermissionMode;
}

export interface PermissionsConfig {
  rules: PermissionRule[];
  /** Auto-allows the read-only actions (file.read, web.search, question.ask) that carry no explicit rule. */
  autoAllowReadonly: boolean;
}

/** Canonical action catalog — the single ordering source for UI and API schemas. */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  "file.read",
  "file.write",
  "command.run",
  "command.outside_workspace",
  "browser.open",
  "browser.click",
  "browser.type",
  "web.fetch",
  "web.search",
  "mcp.call",
  "subagent.spawn",
  "subagent.get",
  "subagent.message",
  "question.ask",
];

/** How long a tool-approval prompt stays valid before auto-deny. */
export const PERMISSION_APPROVAL_TTL_MS = 120_000;

/**
 * Subagent approvals queue behind each other (parallel workers can each raise
 * one), so the user needs a far longer review window than the two minutes the
 * main agent's prompt allows.
 */
export const SUBAGENT_PERMISSION_APPROVAL_TTL_MS = 30 * 60_000;

/**
 * Default IDE permissions: auto-allows file reads/writes within workspace confinement,
 * while prompting for external and mutating actions. `command.run` defaults to
 * `ask` (not `allow`) to prevent the lethal trifecta where a malicious page
 * fetched via `web.fetch` (allowed by default for browsing) could silently
 * drive arbitrary command execution without user approval. Users may explicitly
 * set `command.run` to `allow` in Settings → Permissions if they accept the risk.
 *
 * The read-only actions (file.read, web.search, question.ask) carry NO rule
 * on purpose: `autoAllowReadonly` governs them, so the switch in Settings is
 * a real control instead of being shadowed by a baked-in rule.
 * Configurable in Settings → Permissions.
 */
export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  rules: [
    { action: "file.write", mode: "allow" },
    { action: "command.run", mode: "ask" },
    { action: "command.outside_workspace", mode: "ask" },
    { action: "browser.open", mode: "ask" },
    { action: "browser.click", mode: "ask" },
    { action: "browser.type", mode: "ask" },
    { action: "web.fetch", mode: "ask" },
    { action: "mcp.call", mode: "ask" },
    { action: "subagent.spawn", mode: "allow" },
    { action: "subagent.get", mode: "allow" },
    { action: "subagent.message", mode: "allow" },
  ],
  autoAllowReadonly: true,
};

const READONLY_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  "file.read",
  "web.search",
  "question.ask",
]);

/** Subagent orchestration actions; default to "allow" unless an explicit rule is configured. */
const SUBAGENT_ACTIONS: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "subagent.spawn",
  "subagent.get",
  "subagent.message",
]);

/**
 * Actions architect mode hard-denies regardless of the user's configuration.
 *
 * `subagent.message` is deliberately NOT listed: architect mode is allowed to
 * message a subagent. The read-only wall it must respect is enforced where it
 * actually applies — a terminal subagent is re-clipped to the parent's mode
 * before it runs again, and a running Agent-mode worker refuses the message.
 */
export const ARCHITECT_DENIED_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  "file.write",
  "command.run",
  "command.outside_workspace",
  "browser.open",
  "browser.click",
  "browser.type",
  "mcp.call",
]);

/** Evaluates effective permission mode for an action: explicit rule > autoAllowReadonly > subagent default > "ask". */
export function evaluatePermission(
  config: PermissionsConfig,
  action: PermissionAction,
): PermissionMode {
  const rule = config.rules.find((r) => r.action === action);
  if (rule) return rule.mode;
  if (config.autoAllowReadonly && READONLY_ACTIONS.has(action)) {
    return "allow";
  }
  if (SUBAGENT_ACTIONS.has(action)) {
    return "allow";
  }
  return "ask";
}

/**
 * Effective mode for a command that escapes the workspace root.
 *
 * `command.run: deny` is a global kill switch for every command. Otherwise the
 * more specific `command.outside_workspace` rule decides — and a config that
 * carries no such rule falls back to "ask", never to "allow": escaping the
 * sandbox must always be consented to explicitly.
 */
export function evaluateOutsideWorkspaceCommand(config: PermissionsConfig): PermissionMode {
  if (evaluatePermission(config, "command.run") === "deny") return "deny";
  return evaluatePermission(config, "command.outside_workspace");
}

/**
 * Actions that may back a durable "always allow" rule. Outside-workspace
 * commands are excluded: one confirmation must not permanently disable the
 * sandbox check for every future command.
 */
export function isDurableAlwaysAllowAction(
  action: PermissionAction | null,
): action is PermissionAction {
  return action !== null && action !== "command.outside_workspace";
}

/** Map a tool name (from the agent loop) to a permission action. */
export function actionForTool(toolName: string): PermissionAction | null {
  switch (toolName) {
    case "read_file":
    case "list_directory":
    case "grep":
    case "glob": // file-glob search — read-only, allow by default
    case "todo_read": // in-memory todo list — read-only, allow by default
      return "file.read";
    case "todo_write": // in-memory todo list modification — stateful write
    case "todo_clear": // clears the in-memory todo list — same as a write
    case "write_file":
    case "edit_file":
    case "multi_edit": // multi-edit on a file — same as edit_file (ask by default)
      return "file.write";
    case "run_command":
    case "command_stop": // kills a background command — same class as running one
      return "command.run";
    case "browser_open":
    case "browser_screenshot":
    case "browser_extract":
    case "browser_go_back":
    case "browser_go_forward":
    case "browser_scroll":
    case "browser_press":
    case "browser_close": // closes a page of the session — same class as opening one
      return "browser.open";
    case "browser_click":
      return "browser.click";
    case "browser_type":
      return "browser.type";
    case "http_fetch":
      return "web.fetch";
    case "web_search":
      return "web.search";
    case "mcp_call":
      return "mcp.call";
    case "spawn_subagent":
      return "subagent.spawn";
    case "get_subagent":
      return "subagent.get";
    case "message_subagent":
      // Revives a terminal subagent (re-runs its full toolset) — gate it
      // under its own action so a deny rule can block re-arming write
      // capability. Defaults to allow like the other subagent actions.
      return "subagent.message";
    case "generate_ppt":
    case "init_presentation":
    case "add_presentation_slide":
    case "update_presentation_slide":
    case "generate_doc":
    case "generate_pdf":
    case "create_artifact":
      return "file.write";
    case "read_doc":
      return "file.read";
    case "create_skill":
      // Writes a skill/plugin manifest into the user's plugin store —
      // equivalent to a file write.
      return "file.write";
    case "install_mcp_server":
    case "plugin_call":
      // Both spawn processes and/or execute arbitrary code — gate them
      // under `command.run` so a user's deny rule on commands also covers
      // MCP server installs and plugin tool execution.
      return "command.run";
    case "ask_question":
      // Interactive clarifying question — pauses execution until answered.
      // Non-mutating, so it's classified read-only and allowed in Architect mode.
      return "question.ask";
    default:
      if (toolName.startsWith("mcp_")) {
        // Dynamic MCP tools exposed with prefixed names — gate under mcp.call.
        return "mcp.call";
      }
      if (toolName.startsWith("plugin_")) {
        // Dynamic plugin tools exposed with prefixed names — gate under command.run.
        return "command.run";
      }
      return null;
  }
}

/**
 * Read-only classification — the permission engine decides this via
 * `actionForTool` + `READONLY_ACTIONS`; consumers (architect mode, read-only
 * subagents) must derive from here instead of maintaining their own tool-name
 * lists.
 */
export function isReadOnlyAction(action: PermissionAction): boolean {
  return READONLY_ACTIONS.has(action);
}

export function isReadOnlyTool(toolName: string): boolean {
  const action = actionForTool(toolName);
  return action !== null && READONLY_ACTIONS.has(action);
}

/**
 * World-mutating tools: file writes/renames and command execution.
 * Consumers deciding "can this agent alter the workspace?" derive from here —
 * no shadow lists.
 */
export function isWriteTool(toolName: string): boolean {
  const action = actionForTool(toolName);
  return action === "file.write" || action === "command.run" || toolName === "create_artifact";
}

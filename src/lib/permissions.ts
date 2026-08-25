import { db } from "@/lib/db";
import { audit } from "@/app/api/_lib/helpers";
import {
  DEFAULT_PERMISSIONS,
  evaluatePermission,
  actionForTool,
  type PermissionAction,
  type PermissionMode,
  type PermissionRule,
  type PermissionsConfig,
} from "@/lib/permissions-core";

/**
 * Permissions engine gating agent actions (allow/ask/deny) stored per-user in the `__permissions__` plugin row.
 * Core classification logic is imported and re-exported from `@/lib/permissions-core`.
 */

export * from "@/lib/permissions-core";

export const PERMISSIONS_PLUGIN_NAME = "__permissions__";

function normalize(config: PermissionsConfig): PermissionsConfig {
  // Clamp rules to known actions/modes; dedupe by action (first wins).
  const seen = new Set<PermissionAction>();
  const rules: PermissionRule[] = [];
  for (const r of config.rules ?? []) {
    if (!r || typeof r !== "object") continue;
    const action = r.action as PermissionAction;
    const mode = r.mode as PermissionMode;
    if (!KNOWN_PERMISSION_ACTIONS.has(action)) continue;
    if (!KNOWN_PERMISSION_MODES.has(mode)) continue;
    if (seen.has(action)) continue;
    seen.add(action);
    rules.push({ action, mode });
  }
  return {
    rules,
    autoAllowReadonly: Boolean(config.autoAllowReadonly),
  };
}

export const KNOWN_PERMISSION_ACTIONS: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "file.read",
  "file.write",
  "command.run",
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
]);

export const KNOWN_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "allow",
  "deny",
  "ask",
]);

/**
 * Load user permissions config from DB with fallback to defaults and automatic v2 migration.
 */
export async function getPermissions(userId: string): Promise<PermissionsConfig> {
  try {
    const row = await db.plugin.findFirst({
      where: { userId, name: PERMISSIONS_PLUGIN_NAME },
    });
    if (!row || !row.config) return { ...DEFAULT_PERMISSIONS };
    const parsed = JSON.parse(row.config) as Partial<PermissionsConfig> & { v?: number };

    // Migration: configs without v=2 may have the old restrictive defaults.
    // Preserve custom user rules by placing them before defaults (normalize keeps first occurrence).
    if (parsed.v !== 2) {
      const userRules = parsed.rules ?? [];
      const mergedRules = [...userRules, ...DEFAULT_PERMISSIONS.rules];
      const normalized = normalize({
        rules: mergedRules,
        autoAllowReadonly: parsed.autoAllowReadonly ?? DEFAULT_PERMISSIONS.autoAllowReadonly,
      });
      // Persist the migrated config (fire-and-forget).
      try {
        await db.plugin.update({
          where: { id: row.id },
          data: { config: JSON.stringify({ ...normalized, v: 2 }) },
        });
      } catch {
        /* ignore persist errors */
      }
      return normalized;
    }

    return normalize({
      rules: parsed.rules ?? DEFAULT_PERMISSIONS.rules,
      autoAllowReadonly: parsed.autoAllowReadonly ?? DEFAULT_PERMISSIONS.autoAllowReadonly,
    });
  } catch {
    return { ...DEFAULT_PERMISSIONS };
  }
}

/** Persist a user's permissions config. Never throws — returns normalized config. */
export async function setPermissions(
  userId: string,
  config: PermissionsConfig,
): Promise<PermissionsConfig> {
  const normalized = normalize(config);
  const json = JSON.stringify({ ...normalized, v: 2 });
  await db.plugin.upsert({
    where: { userId_name: { userId, name: PERMISSIONS_PLUGIN_NAME } },
    update: { config: json, type: "plugin" },
    create: {
      userId,
      name: PERMISSIONS_PLUGIN_NAME,
      description: "Permissions config (auto-managed)",
      type: "plugin",
      source: "system",
      enabled: true,
      config: json,
    },
  });
  try {
    await audit(userId, "permissions_update", json.slice(0, 2000));
  } catch {
    /* ignore audit failures */
  }
  return normalized;
}

/**
 * Evaluate tool permission with optional mode override. Hard-denies mutation actions
 * in architect mode and supports pre-loaded configs for batch screening efficiency.
 */
export async function evaluateToolPermission(
  userId: string,
  toolName: string,
  mode?: "agent" | "chat" | "architect",
  config?: PermissionsConfig,
): Promise<PermissionMode> {
  const action = actionForTool(toolName);
  if (!action) {
    if (mode === "architect") return "deny";
    return "ask";
  }

  if (mode === "architect") {
    if (
      action === "file.write" ||
      action === "command.run" ||
      action === "browser.open" ||
      action === "browser.click" ||
      action === "browser.type" ||
      action === "mcp.call" ||
      // `subagent.message` re-arms a terminal subagent with its FULL original
      // toolset — an architect-spawned research subagent is clipped to
      // read-only, but a subagent from a prior agent-mode run may carry write
      // tools, so architect reviving one would bypass the read-only wall.
      action === "subagent.message"
    ) {
      return "deny";
    }
  }

  const resolved = config ?? (await getPermissions(userId));
  return evaluatePermission(resolved, action);
}

/**
 * Refresh batch permission snapshot after "always_allow" decisions to avoid redundant prompts.
 */
export async function refreshPermissionsConfig(
  userId: string,
  decision: "allow" | "deny" | "always_allow",
  config: PermissionsConfig,
): Promise<PermissionsConfig> {
  if (decision !== "always_allow") return config;
  return getPermissions(userId);
}

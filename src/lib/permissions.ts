import { db } from "@/lib/db";
import { audit } from "@/app/api/_lib/helpers";
import {
  DEFAULT_PERMISSIONS,
  PERMISSION_ACTIONS,
  ARCHITECT_DENIED_ACTIONS,
  evaluatePermission,
  evaluateOutsideWorkspaceCommand,
  isDurableAlwaysAllowAction,
  isReadOnlyAction,
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

/** Persisted config version — bump when the rule set semantics change. */
const CONFIG_VERSION = 3;

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

export const KNOWN_PERMISSION_ACTIONS: ReadonlySet<PermissionAction> = new Set(PERMISSION_ACTIONS);

export const KNOWN_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "allow",
  "deny",
  "ask",
]);

/**
 * Load user permissions config from DB with fallback to defaults and automatic v3 migration.
 */
export async function getPermissions(
  userId: string,
  opts?: { skipMigrationPersist?: boolean },
): Promise<PermissionsConfig> {
  try {
    const row = await db.plugin.findFirst({
      where: { userId, name: PERMISSIONS_PLUGIN_NAME },
    });
    if (!row || !row.config) return { ...DEFAULT_PERMISSIONS };
    const parsed = JSON.parse(row.config) as Partial<PermissionsConfig> & { v?: number };

    // Migration: configs older than v3 may carry the old restrictive defaults
    // and — worse — read-only "allow" rules that shadow the auto-allow switch
    // forever. Preserve custom user rules by placing them before the defaults
    // (normalize keeps the first occurrence).
    if (parsed.v !== CONFIG_VERSION) {
      const autoAllowReadonly =
        parsed.autoAllowReadonly ?? DEFAULT_PERMISSIONS.autoAllowReadonly;
      const userRules = (parsed.rules ?? []).map((r) => {
        // The outside-workspace rule was INERT before v3 (it was never
        // consulted), so an "allow" stored back then never had any effect.
        // Honoring it now would silently grant a far stronger privilege than
        // the user ever exercised — downgrade it to "ask" so the choice is
        // made again, consciously.
        if (r.action === "command.outside_workspace" && r.mode === "allow") {
          return { action: r.action, mode: "ask" as PermissionMode };
        }
        return r;
      }).filter((r) => {
        // A read-only "allow" rule is exactly what the auto-allow switch
        // produces — keeping it would make the switch a no-op. Dropping it is
        // lossless while the switch is on.
        if (autoAllowReadonly && r.mode === "allow" && isReadOnlyAction(r.action)) return false;
        return true;
      });
      const mergedRules = [...userRules, ...DEFAULT_PERMISSIONS.rules];
      const normalized = normalize({
        rules: mergedRules,
        autoAllowReadonly,
      });
      // Persist the migrated config through the per-user write queue unless
      // the caller is already inside a write task that will persist the config.
      if (!opts?.skipMigrationPersist) {
        try {
          await enqueueUserWrite(userId, async () => {
            const current = await db.plugin.findFirst({
              where: { userId, name: PERMISSIONS_PLUGIN_NAME },
            });
            if (current?.config) {
              try {
                const cur = JSON.parse(current.config);
                if (cur?.v === CONFIG_VERSION) return;
              } catch {
                /* parse failed, continue */
              }
            }
            await db.plugin.update({
              where: { id: row.id },
              data: { config: JSON.stringify({ ...normalized, v: CONFIG_VERSION }) },
            });
          });
        } catch {
          /* ignore persist errors */
        }
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

/**
 * Serialize read-modify-write permission updates per user. Concurrent
 * always_allow resolutions would otherwise race and drop each other's rules.
 */
const userWriteQueues = new Map<string, Promise<unknown>>();

function enqueueUserWrite<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = userWriteQueues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  userWriteQueues.set(userId, next);
  const cleanup = () => {
    if (userWriteQueues.get(userId) === next) userWriteQueues.delete(userId);
  };
  void next.then(cleanup, cleanup);
  return next;
}

/** Persist a user's permissions config. Never throws — returns normalized config. */
export function setPermissions(
  userId: string,
  config: PermissionsConfig,
): Promise<PermissionsConfig> {
  return enqueueUserWrite(userId, () => persistPermissions(userId, config));
}

async function persistPermissions(
  userId: string,
  config: PermissionsConfig,
): Promise<PermissionsConfig> {
  const normalized = normalize(config);
  const json = JSON.stringify({ ...normalized, v: CONFIG_VERSION });
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

/** Atomically add or replace a single rule (dedupe by action). */
export function upsertPermissionRule(
  userId: string,
  action: PermissionAction,
  mode: PermissionMode,
): Promise<PermissionsConfig> {
  return enqueueUserWrite(userId, async () => {
    const config = await getPermissions(userId, { skipMigrationPersist: true });
    const rules = config.rules.filter((r) => r.action !== action);
    rules.push({ action, mode });
    return persistPermissions(userId, { ...config, rules });
  });
}

/**
 * Evaluate tool permission with optional mode override. Hard-denies mutation actions
 * in architect mode and supports pre-loaded configs for batch screening efficiency.
 *
 * `actionOverride` replaces the action derived from the tool name — used for
 * actions that are not bound to a single tool (e.g. a `run_command` that
 * escapes the workspace is classified as `command.outside_workspace`).
 */
export async function evaluateToolPermission(
  userId: string,
  toolName: string,
  mode?: "agent" | "chat" | "architect",
  config?: PermissionsConfig,
  actionOverride?: PermissionAction | null,
): Promise<PermissionMode> {
  const action = actionOverride ?? actionForTool(toolName);
  if (!action) {
    if (mode === "architect") return "deny";
    return "ask";
  }

  if (mode === "architect") {
    if (toolName === "create_artifact") {
      const resolved = config ?? (await getPermissions(userId));
      return evaluatePermission(resolved, "file.write");
    }
    if (ARCHITECT_DENIED_ACTIONS.has(action)) {
      return "deny";
    }
  }

  const resolved = config ?? (await getPermissions(userId));
  if (action === "command.outside_workspace") {
    return evaluateOutsideWorkspaceCommand(resolved);
  }
  return evaluatePermission(resolved, action);
}

/**
 * Apply an "always allow" decision to an in-memory permission snapshot.
 *
 * The executors use this so a later call of the same action skips the prompt
 * without depending on the database write of the pending-approval endpoint
 * having landed first.
 */
export function applyAlwaysAllowToConfig(
  config: PermissionsConfig,
  action: PermissionAction | null,
): PermissionsConfig {
  if (!isDurableAlwaysAllowAction(action)) return config;
  const rules = config.rules.filter((r) => r.action !== action);
  rules.push({ action, mode: "allow" });
  return { ...config, rules };
}

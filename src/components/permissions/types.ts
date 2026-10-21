"use client";

import { apiGet, ApiRequestError } from "@/lib/api-client";
import {
  DEFAULT_PERMISSIONS,
  PERMISSION_ACTIONS as CORE_PERMISSION_ACTIONS,
  evaluatePermission,
  evaluateOutsideWorkspaceCommand,
  isReadOnlyAction,
  type PermissionAction,
  type PermissionMode,
  type PermissionRule,
  type PermissionsConfig,
} from "@/lib/permissions-core";

export type { PermissionAction, PermissionMode, PermissionRule, PermissionsConfig };

/* ------------------------------------------------------------------ *
 * Permissions — shared types, query keys, and typed API helpers.
 *
 * The backend persists a per-user permissions config
 * at /api/permissions. The frontend renders a settings section that
 * loads the config on mount and saves via PUT.
 * ------------------------------------------------------------------ */

export interface PermissionsResponse {
  config: PermissionsConfig;
}

export const permissionsKeys = {
  all: ["permissions"] as const,
} as const;

/* The canonical action catalog shown in the settings table. */
export interface PermissionActionDef {
  action: PermissionAction;
  label: string;
  description: string;
  readonly?: boolean;
}

const ACTION_META: Record<PermissionAction, { label: string; description: string }> = {
  "file.read": {
    label: "Read files",
    description: "Read file contents from the workspace.",
  },
  "file.write": {
    label: "Create or edit files",
    description: "Write, create, or modify files in the workspace.",
  },
  "command.run": {
    label: "Run shell commands",
    description: "Execute allowlisted shell commands in the workspace.",
  },
  "command.outside_workspace": {
    label: "Run outside workspace commands",
    description:
      "Run commands that target directories outside the workspace root. In Ask mode every such command needs an explicit confirmation.",
  },
  "browser.open": {
    label: "Open URLs in the browser",
    description: "Open a URL in the integrated browser session.",
  },
  "browser.click": {
    label: "Click elements on web pages",
    description: "Click an element identified by its accessibility ref.",
  },
  "browser.type": {
    label: "Type into web forms",
    description: "Type text into form fields on a web page.",
  },
  "web.fetch": {
    label: "Fetch web pages",
    description: "Agent-initiated HTTP fetch of a URL.",
  },
  "web.search": {
    label: "Search the web",
    description: "Agent-initiated web search.",
  },
  "mcp.call": {
    label: "Call MCP server tools",
    description: "Invoke tools exposed by connected MCP servers.",
  },
  "subagent.spawn": {
    label: "Spawn subagents",
    description: "Launch background subagents to work on delegated tasks.",
  },
  "subagent.get": {
    label: "Inspect subagents",
    description: "Query the status and details of running subagents.",
  },
  "subagent.message": {
    label: "Message subagents",
    description: "Revive a terminal subagent with a new task (re-runs its full toolset).",
  },
  "question.ask": {
    label: "Ask clarifying questions",
    description: "Agent-initiated clarifying questions that pause execution for your answer.",
  },
};

export const PERMISSION_ACTIONS: PermissionActionDef[] = CORE_PERMISSION_ACTIONS.map(
  (action) => ({
    action,
    ...ACTION_META[action],
    readonly: isReadOnlyAction(action),
  }),
);

export const DEFAULT_CONFIG: PermissionsConfig = {
  ...DEFAULT_PERMISSIONS,
  rules: DEFAULT_PERMISSIONS.rules.map((rule) => ({ ...rule })),
};

export { evaluatePermission, evaluateOutsideWorkspaceCommand };

export async function fetchPermissions(): Promise<PermissionsResponse> {
  return apiGet<PermissionsResponse>("/api/permissions");
}

/**
 * Save the permissions config via PUT /api/permissions. The shared
 * api-client has no apiPut helper, so we inline a fetch with the same
 * envelope-parsing semantics (throws ApiRequestError on `{ error }`).
 */
export async function savePermissions(
  config: PermissionsConfig,
): Promise<PermissionsResponse> {
  const res = await fetch("/api/permissions", {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ config }),
    credentials: "include",
  });
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new ApiRequestError(
      `Non-JSON response (status ${res.status}) from permissions save.`,
      undefined,
      res.status,
    );
  }
  const env = json as { error?: string; code?: string; details?: unknown };
  if (env && typeof env.error === "string") {
    throw new ApiRequestError(env.error, env.code, res.status, env.details);
  }
  if (env && typeof (env as PermissionsResponse).config === "object") {
    return env as PermissionsResponse;
  }
  throw new ApiRequestError(
    `Unexpected permissions response shape (status ${res.status}).`,
    undefined,
    res.status,
  );
}

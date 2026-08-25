"use client";

import { apiGet, ApiRequestError } from "@/lib/api-client";

/* ------------------------------------------------------------------ *
 * Permissions — shared types, query keys, and typed API helpers.
 *
 * The backend persists a per-user permissions config
 * at /api/permissions. The frontend renders a settings section that
 * loads the config on mount and saves via PUT.
 * ------------------------------------------------------------------ */

export type PermissionMode = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  mode: PermissionMode;
}

export interface PermissionsConfig {
  rules: PermissionRule[];
  autoAllowReadonly: boolean;
}

export interface PermissionsResponse {
  config: PermissionsConfig;
}

export const permissionsKeys = {
  all: ["permissions"] as const,
} as const;

/* The canonical action catalog shown in the settings table. */
export interface PermissionActionDef {
  action: string;
  label: string;
  description: string;
  readonly?: boolean;
}

export const PERMISSION_ACTIONS: PermissionActionDef[] = [
  {
    action: "file.read",
    label: "Read files",
    description: "Read file contents from the workspace.",
    readonly: true,
  },
  {
    action: "file.write",
    label: "Create or edit files",
    description: "Write, create, or modify files in the workspace.",
  },
  {
    action: "command.run",
    label: "Run shell commands",
    description: "Execute allowlisted shell commands in the workspace.",
  },
  {
    action: "browser.open",
    label: "Open URLs in the browser",
    description: "Open a URL in the integrated browser session.",
  },
  {
    action: "browser.click",
    label: "Click elements on web pages",
    description: "Click an element identified by its accessibility ref.",
  },
  {
    action: "browser.type",
    label: "Type into web forms",
    description: "Type text into form fields on a web page.",
  },
  {
    action: "web.fetch",
    label: "Fetch web pages",
    description: "Agent-initiated HTTP fetch of a URL.",
    readonly: true,
  },
  {
    action: "web.search",
    label: "Search the web",
    description: "Agent-initiated web search.",
    readonly: true,
  },
  {
    action: "mcp.call",
    label: "Call MCP server tools",
    description: "Invoke tools exposed by connected MCP servers.",
  },
  {
    action: "subagent.spawn",
    label: "Spawn subagents",
    description: "Launch background subagents to work on delegated tasks.",
  },
  {
    action: "subagent.get",
    label: "Inspect subagents",
    description: "Query the status and details of running subagents.",
  },
  {
    action: "subagent.message",
    label: "Message subagents",
    description: "Revive a terminal subagent with a new task (re-runs its full toolset).",
  },
  {
    action: "question.ask",
    label: "Ask clarifying questions",
    description: "Agent-initiated clarifying questions that pause execution for your answer.",
    readonly: true,
  },
];

export const DEFAULT_CONFIG: PermissionsConfig = {
  rules: [
    { action: "file.read", mode: "allow" },
    { action: "file.write", mode: "allow" },
    { action: "command.run", mode: "allow" },
    { action: "browser.open", mode: "ask" },
    { action: "browser.click", mode: "ask" },
    { action: "browser.type", mode: "ask" },
    { action: "web.fetch", mode: "allow" },
    { action: "web.search", mode: "allow" },
    { action: "mcp.call", mode: "ask" },
    { action: "subagent.spawn", mode: "allow" },
    { action: "question.ask", mode: "allow" },
  ],
  autoAllowReadonly: true,
};

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

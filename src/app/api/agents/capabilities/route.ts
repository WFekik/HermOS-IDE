// TODO(experimental/unwired): Kept intentionally — capabilities catalog endpoint
// (tools/permissions/providers/MCP) is implemented but the settings UI
// currently queries providers separately. Retained for future unified
// capabilities panel.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { PROVIDERS } from "@/lib/ai/providers";
import { PUBLIC_BUILTIN_TOOLS } from "@/lib/ai/tools";
import { getPermissions } from "@/lib/permissions";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  unauthorized,
  ok,
  getSystemUserId,
} from "@/app/api/_lib/helpers";
import type { ProviderId, McpTool } from "@/lib/types";

/**
 * GET /api/agents/capabilities
 *
 * Returns a catalog of what the HermOS agent can do, intended for the UI to
 * surface (e.g. a "Capabilities" panel or settings tab):
 *   - tools: the built-in agent tool registry (name, description, JSON schema).
 *   - permissions: the user's live permissions config (rules + autoAllowReadonly +
 *     autoAllowReadonly).
 *   - providers: every configured AI provider with `configured` (true when no
 *     key required, or when a saved ProviderKey row exists) and `free` flags.
 *   - mcpServers: every MCP server reachable by the user (own + system-seeded)
 *     with status and tool count.
 *
 * Requires auth. Rate limited at 30/min/user.
 */

export const dynamic = "force-dynamic";

interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PermissionsCatalog {
  rules: Array<{ action: string; mode: string }>;
  autoAllowReadonly: boolean;
}

interface ProviderCatalogEntry {
  id: string;
  name: string;
  configured: boolean;
  free: boolean;
}

interface McpServerCatalogEntry {
  id: string;
  name: string;
  status: string;
  toolCount: number;
}

function countToolsInMcpServer(toolsJson: string | null): number {
  if (!toolsJson) return 0;
  try {
    const parsed = JSON.parse(toolsJson) as McpTool[] | unknown;
    if (Array.isArray(parsed)) return parsed.length;
    return 0;
  } catch {
    return 0;
  }
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `caps:${user.id}`, RATE_LIMITS.chat);
  if (limited) return limited;

  // ---- Tools: built-in registry (no per-user filtering — every authenticated
  // user gets the same built-in tools; MCP tools are surfaced separately
  // through the mcpServers entry below). ----
  const tools: ToolCatalogEntry[] = PUBLIC_BUILTIN_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  // Permissions: live per-user config from the permissions engine.
  const permsConfig = await getPermissions(user.id);
  const permissions: PermissionsCatalog = {
    rules: permsConfig.rules.map((r) => ({ action: r.action, mode: r.mode })),
    autoAllowReadonly: permsConfig.autoAllowReadonly,
  };

  // ---- Providers: every provider in the registry, with `configured` true
  // when the provider requires no key OR the user has a saved active key. ----
  const keyRows = await db.providerKey.findMany({
    where: { userId: user.id, isActive: true },
    select: { provider: true },
  });
  const configuredProviders = new Set(keyRows.map((k) => k.provider as ProviderId));
  const providers: ProviderCatalogEntry[] = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    configured: !p.requiresKey ? true : configuredProviders.has(p.id),
    free: Boolean(p.free),
  }));

  // ---- MCP servers: own + system-seeded (matches the GET /api/mcp/servers
  // visibility rules). Tool count derived from the `tools` JSON column. ----
  const systemId = await getSystemUserId();
  const mcpRows = await db.mcpServer.findMany({
    where: { OR: [{ userId: user.id }, { userId: systemId }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, status: true, tools: true },
  });
  const mcpServers: McpServerCatalogEntry[] = mcpRows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    toolCount: countToolsInMcpServer(r.tools),
  }));

  return ok({
    tools,
    permissions,
    providers,
    mcpServers,
  });
});

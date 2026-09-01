import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { connectMcpClient } from "@/lib/mcp/manager";
import { commandsDisabledMessage } from "@/lib/workspace";
import { tryDecryptJson } from "@/lib/encryption";
import {
  withErrorHandler,
  toMcpServerDTO,
  ok,
  notFound,
  apiError,
  getSystemUserId,
} from "@/app/api/_lib/helpers";
import type { McpTool } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `mcp-connect:${user.id}`, { capacity: 20, refillPerSec: 20 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const systemId = await getSystemUserId();
    const row = await db.mcpServer.findUnique({ where: { id } });
    if (!row || (row.userId !== user.id && row.userId !== systemId)) {
      return notFound("MCP server not found");
    }

    // stdio MCP servers spawn an arbitrary command on the host — gate them
    // with the same deployment-level kill switch as the terminal (deny by
    // default on cloud builds unless HERMOS_ENABLE_COMMANDS=true).
    if (row.transport === "stdio") {
      const commandsBlocked = commandsDisabledMessage();
      if (commandsBlocked) {
        return apiError(`stdio MCP servers are disabled: ${commandsBlocked}`, 403);
      }
    }

    let tools: McpTool[] = [];
    let status: "connected" | "error" = "connected";
    let lastError: string | null = null;

    try {
      // Establish real client connection
      tools = await connectMcpClient({
        id: row.id,
        name: row.name,
        transport: row.transport as "stdio" | "sse" | "streamable-http",
        command: row.command || undefined,
        args: row.args ? JSON.parse(row.args as string) : undefined,
        env: tryDecryptJson(row.env),
        url: row.url || undefined,
        headers: tryDecryptJson(row.headers),
      });
    } catch (e: any) {
      status = "error";
      lastError = e?.message || String(e);
      tools = [];
    }

    const updated = await db.mcpServer.update({
      where: { id },
      data: {
        status,
        lastError,
        tools: JSON.stringify(tools),
      },
    });
    return ok({ server: toMcpServerDTO(updated), tools });
  },
);

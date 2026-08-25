// TODO(experimental/unwired): Kept intentionally — per-server tool-listing
// endpoint is implemented but the MCP settings UI currently lists tools inline
// via the servers collection. Retained for future per-server detail view.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { inferToolsForServer } from "@/lib/mcp/manager";
import {
  withErrorHandler,
  ok,
  notFound,
  getSystemUserId,
} from "@/app/api/_lib/helpers";
import type { McpTool } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;
    const systemId = await getSystemUserId();
    const row = await db.mcpServer.findUnique({ where: { id } });
    if (!row || (row.userId !== user.id && row.userId !== systemId)) {
      return notFound("MCP server not found");
    }
    let tools: McpTool[] = [];
    if (row.tools) {
      try {
        tools = JSON.parse(row.tools) as McpTool[];
      } catch {
        tools = [];
      }
    }
    if (!tools.length && row.status === "connected") {
      tools = inferToolsForServer(row.name);
    }
    return ok({ tools });
  },
);

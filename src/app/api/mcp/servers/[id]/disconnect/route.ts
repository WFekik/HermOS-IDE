import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { disconnectMcpClient } from "@/lib/mcp/manager";
import {
  withErrorHandler,
  toMcpServerDTO,
  ok,
  notFound,
  getSystemUserId,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `mcp-disconnect:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const systemId = await getSystemUserId();
    const row = await db.mcpServer.findUnique({ where: { id } });
    if (!row || (row.userId !== user.id && row.userId !== systemId)) {
      return notFound("MCP server not found");
    }

    // Call real client disconnect logic
    await disconnectMcpClient(id);

    const updated = await db.mcpServer.update({
      where: { id },
      data: {
        status: "disconnected",
        tools: JSON.stringify([]),
        lastError: null,
      },
    });

    return ok({ server: toMcpServerDTO(updated) });
  },
);

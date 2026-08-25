import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { withErrorHandler, ok, notFound } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const DELETE = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `mcp-servers:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const row = await db.mcpServer.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) {
      return notFound("MCP server not found");
    }
    await db.mcpServer.delete({ where: { id } });
    return ok({ ok: true });
  },
);

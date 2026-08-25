import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { createMcpServerSchema } from "@/lib/validation";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";
import {
  withErrorHandler,
  parseJson,
  toMcpServerDTO,
  ok,
  apiError,
  getSystemUserId,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  await seedIfNeeded();
  // Surface both the user's MCP servers AND the global sample (system user) ones
  const systemId = await getSystemUserId();
  const rows = await db.mcpServer.findMany({
    where: { OR: [{ userId: user.id }, { userId: systemId }] },
    orderBy: { createdAt: "asc" },
  });
  return ok({ servers: rows.map(toMcpServerDTO) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `mcp-servers:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (limited) return limited;
  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid MCP server payload.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { name, transport, command, args, env, url, headers } = parsed.data;
  // Upsert by (userId, name): re-creating with the same name returns the existing row.
  const upserted = await db.mcpServer.upsert({
    where: { userId_name: { userId: user.id, name } },
    update: {
      transport,
      command: command ?? null,
      args: args ? JSON.stringify(args) : null,
      env: env ? JSON.stringify(env) : null,
      url: url ?? null,
      headers: headers ? JSON.stringify(headers) : null,
    },
    create: {
      userId: user.id,
      name,
      transport,
      command: command ?? null,
      args: args ? JSON.stringify(args) : null,
      env: env ? JSON.stringify(env) : null,
      url: url ?? null,
      headers: headers ? JSON.stringify(headers) : null,
      status: "disconnected",
    },
  });
  return ok({ server: toMcpServerDTO(upserted) });
});

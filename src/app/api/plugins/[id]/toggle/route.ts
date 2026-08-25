import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { togglePluginSchema } from "@/lib/validation";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  parseJson,
  toPluginDTO,
  ok,
  apiError,
  notFound,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `plugins:${user.id}`, { capacity: 60, refillPerSec: 60 / 60 });
    if (limited) return limited;
    const { id } = await params;
    const body = await parseJson<unknown>(req);
    if (!body) return apiError("Invalid JSON body.", 400);
    const parsed = togglePluginSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid toggle payload.", 400, {
        details: parsed.error.flatten(),
      });
    }
    const row = await db.plugin.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) {
      return notFound("Plugin not found");
    }
    const updated = await db.plugin.update({
      where: { id },
      data: { enabled: parsed.data.enabled },
    });
    return ok({ plugin: toPluginDTO(updated) });
  },
);

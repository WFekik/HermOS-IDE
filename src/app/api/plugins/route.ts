import { requireUser } from "@/lib/session";
import { createPluginSchema } from "@/lib/validation";
import { db } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";
import {
  withErrorHandler,
  createGuardedHandler,
  toPluginDTO,
  ok,
  getSystemUserId,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  await seedIfNeeded();
  const systemId = await getSystemUserId();
  // Surface both the user's plugins AND the global builtin (system user) ones,
  // but exclude internal system-managed rows (e.g. __checkpoints__:*, __todos__:*, __permissions__)
  const rows = await db.plugin.findMany({
    where: {
      OR: [{ userId: user.id }, { userId: systemId }],
      NOT: { name: { startsWith: "__" } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ plugins: rows.map(toPluginDTO) });
});

export const POST = createGuardedHandler(
  {
    schema: createPluginSchema,
    rateLimit: { keyPrefix: "plugins", config: { capacity: 30, refillPerSec: 30 / 60 } },
  },
  async ({ user, body }) => {
    const { name, description, type, source, manifest } = body;
    // Upsert by (userId, name): re-installing the same plugin returns the existing row.
    const upserted = await db.plugin.upsert({
      where: { userId_name: { userId: user.id, name } },
      update: {
        description: description ?? null,
        type: type ?? "plugin",
        source: source ?? "local",
        manifest: manifest ? JSON.stringify(manifest) : undefined,
      },
      create: {
        userId: user.id,
        name,
        description: description ?? null,
        type: type ?? "plugin",
        version: "1.0.0",
        source: source ?? "local",
        manifest: manifest ? JSON.stringify(manifest) : null,
        enabled: true,
      },
    });
    return ok({ plugin: toPluginDTO(upserted) });
  },
);

import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";
import {
  withErrorHandler,
  toPluginDTO,
  ok,
  getSystemUserId,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  await seedIfNeeded();
  const systemId = await getSystemUserId();
  const rows = await db.plugin.findMany({
    where: {
      type: "skill",
      OR: [{ userId: user.id }, { userId: systemId }],
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ skills: rows.map(toPluginDTO) });
});

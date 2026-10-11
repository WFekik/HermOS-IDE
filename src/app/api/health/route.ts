import type { NextRequest } from "next/server";
import { ok, apiError, withErrorHandler } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

// NOTE: `req` is unused in the body but load-bearing — withErrorHandler finds
// it via findRequest() for the loopback/Host-Origin gate. Do NOT remove the
// parameter or the gate is silently bypassed (findRequest returns null).
export const GET = withErrorHandler(async (req: NextRequest) => {
  const token = process.env.HERMOS_INSTANCE_TOKEN;
  const tokenHeader: Record<string, string> | undefined = token
    ? { "X-HermOS-Instance-Token": token }
    : undefined;
  // Desktop startup probe must respond in milliseconds — it is polled every
  // 50ms by the Tauri boot thread. NOTE: `@/lib/db` is intentionally NOT
  // imported at module scope: that module constructs a PrismaClient and kicks
  // off SQLite provisioning at import time (~300-800ms + first-boot
  // migrate), which would make every health poll pay the DB cost before Node
  // is even warm. The DB-backed check below lazy-imports only when needed.
  if (process.env.HERMOS_DESKTOP === "true") {
    return ok(
      {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        env: process.env.NODE_ENV ?? "development",
      },
      tokenHeader,
    );
  }
  try {
    const { db, dbReady } = await import("@/lib/db");
    await dbReady;
    await db.user.findFirst({ select: { id: true } });
    return ok(
      {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        env: process.env.NODE_ENV ?? "development",
      },
      tokenHeader,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Health check failed";
    return apiError(msg, 503, { status: "unhealthy" });
  }
});

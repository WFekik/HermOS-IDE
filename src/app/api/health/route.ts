import { NextRequest } from "next/server";
import { db, dbReady } from "@/lib/db";
import { ok, apiError, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  const token = process.env.HERMOS_INSTANCE_TOKEN;
  const tokenHeader: Record<string, string> | undefined = token
    ? { "X-HermOS-Instance-Token": token }
    : undefined;
  // Desktop startup probe must respond in <200ms — don't block on DB provisioning
  // which can take 5-7s on first boot. The full DB check runs below with a short
  // timeout; startup only needs the token header to verify the port identity.
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
}

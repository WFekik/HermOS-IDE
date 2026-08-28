import { NextRequest, NextResponse } from "next/server";
import { enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { getAppVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  return NextResponse.json({
    ok: true,
    service: "hermos",
    version: getAppVersion(),
    time: new Date().toISOString(),
  });
}

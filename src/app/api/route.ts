import { NextRequest, NextResponse } from "next/server";
import { enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  return NextResponse.json({
    ok: true,
    service: "hermos",
    version: "1.0.0",
    time: new Date().toISOString(),
  });
}

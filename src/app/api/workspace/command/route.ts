import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";
import { getActiveWorkspace, ensureDefaultWorkspace, runCommandWs } from "@/lib/workspace";
import { parseJson, apiError, unauthorized, ok, audit, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  command: z.string().trim().min(1).max(1000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-cmd:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const res = await runCommandWs(user.id, ws.name, parsed.data.command);
  await audit(
    user.id,
    "workspace_command",
    JSON.stringify({ command: parsed.data.command.slice(0, 200), ok: res.ok, exitCode: res.exitCode }),
    getClientIp(req),
  );
  return ok({
    ok: res.ok,
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    blocked: res.blocked,
    reason: res.reason,
    cwd: res.cwd,
  });
}

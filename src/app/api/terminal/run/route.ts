import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { terminalSchema } from "@/lib/validation";
import { withRateLimit, RATE_LIMITS, getClientIp } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace, runCommandWs } from "@/lib/workspace";
import {
  withErrorHandler,
  parseJson,
  apiError,
  unauthorized,
  ok,
  audit,
} from "@/app/api/_lib/helpers";
import type { TerminalResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const ip = getClientIp(req);
  const limited = await withRateLimit(req, `terminal:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = terminalSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid terminal payload.", 400, {
      details: parsed.error.flatten(),
    });
  }

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const exec = await runCommandWs(user.id, ws.name, parsed.data.command);
  const result: TerminalResponse = {
    ok: exec.ok,
    stdout: exec.stdout,
    stderr: exec.stderr,
    exitCode: exec.exitCode,
    command: exec.command,
    blocked: exec.blocked,
    reason: exec.reason,
  };

  await audit(
    user.id,
    "terminal_run",
    JSON.stringify({
      command: parsed.data.command.slice(0, 200),
      shell: parsed.data.shell,
      ok: result.ok,
      blocked: result.blocked ?? false,
      exitCode: result.exitCode,
    }),
    ip,
  );

  return ok(result);
});

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  unauthorized,
  audit,
} from "@/app/api/_lib/helpers";
import {
  getPermissions,
  setPermissions,
  type PermissionAction,
  type PermissionMode,
  type PermissionRule,
  type PermissionsConfig,
} from "@/lib/permissions";
import { z } from "zod";

export const dynamic = "force-dynamic";

const PERM_RATE = { capacity: 30, refillPerSec: 30 / 60 };

const ACTIONS: PermissionAction[] = [
  "file.read",
  "file.write",
  "command.run",
  "browser.open",
  "browser.click",
  "browser.type",
  "web.fetch",
  "web.search",
  "mcp.call",
  "subagent.spawn",
  "subagent.get",
  "subagent.message",
];
const MODES: PermissionMode[] = ["allow", "deny", "ask"];

const ruleSchema = z.object({
  action: z.enum(ACTIONS as [PermissionAction, ...PermissionAction[]]),
  mode: z.enum(MODES as [PermissionMode, ...PermissionMode[]]),
});
const configSchema = z.object({
  rules: z.array(ruleSchema).max(50),
  autoAllowReadonly: z.boolean(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `permissions:${user.id}`, PERM_RATE);
  if (limited) return limited;

  const config = await getPermissions(user.id);
  return ok({ config });
});

export const PUT = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `permissions:${user.id}`, PERM_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  // The frontend sends { config: { rules, autoAllowReadonly } }.
  // Extract the inner config object before validation.
  const configBody = (body as { config?: unknown }).config ?? body;
  const parsed = configSchema.safeParse(configBody);
  if (!parsed.success) {
    return apiError("Invalid permissions config.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const config: PermissionsConfig = {
    rules: parsed.data.rules as PermissionRule[],
    autoAllowReadonly: parsed.data.autoAllowReadonly,
  };
  const normalized = await setPermissions(user.id, config);
  await audit(
    user.id,
    "permissions_put",
    JSON.stringify(normalized).slice(0, 2000),
    getClientIp(req),
  );
  return ok({ config: normalized });
});

// DEFAULT_PERMISSIONS is re-exported from @/lib/permissions.

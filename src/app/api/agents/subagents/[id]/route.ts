import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getSubagent, deleteSubagent, getSubagentMessages } from "@/lib/ai/subagents";
import { apiError, unauthorized, notFound, ok, audit, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

/**
 * Single-subagent GET/DELETE.
 *
 *   GET    /api/agents/subagents/[id]  → { subagent }   (for polling status)
 *   DELETE /api/agents/subagents/[id]  → { ok }
 *
 * Both endpoints verify the subagent belongs to the requesting user (via the
 * `userId` field captured at create time). Rate limit: 60/min/user (polling
 * is light) for GET, 10/min/user for DELETE.
 */

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `subagents-get:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const { id } = await params;
  const url = new URL(req.url);
  const includeMessages = url.searchParams.get("messages") === "true";

  const sa = getSubagent(user.id, id);
  if (!sa) return notFound("Subagent not found");

  if (includeMessages) {
    const messages = getSubagentMessages(user.id, id);
    return ok({ subagent: sa, messages });
  }

  return ok({ subagent: sa });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `subagents-del:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  const { id } = await params;
  const sa = getSubagent(user.id, id);
  if (!sa) return notFound("Subagent not found");

  deleteSubagent(user.id, id);
  try {
    await audit(
      user.id,
      "subagent_delete",
      JSON.stringify({ id, conversationId: sa.conversationId }),
    );
  } catch {
    /* ignore audit failures */
  }
  return ok({ ok: true });
}

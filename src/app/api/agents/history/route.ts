// TODO(experimental/unwired): Kept intentionally — paginated conversation history
// endpoint is implemented (used by diagnostics) but the main UI currently
// surfaces history via /api/conversations. Retained for future history panel.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { unauthorized, ok, apiError, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

/**
 * GET /api/agents/history?page=1&limit=20
 *
 * Paginated list of the user's recent agent runs (conversations that
 * drove the agent loop, with tool executions), ordered by updatedAt desc.
 *
 * Each entry includes:
 *   - conversation metadata: id, title, provider, model, mode, updatedAt.
 *   - messageCount: total messages in the conversation (user + assistant
 *     + tool + system).
 *   - toolExecutionCount: number of ToolExecution rows linked to the
 *     conversation (i.e. how many tools the agent actually ran).
 *   - totalTokens: sum of tokensIn + tokensOut across all messages.
 *   - lastUserMessagePreview: first 100 chars of the last user message
 *     (so the UI can show a one-line summary of the most recent prompt).
 *
 * Returns `{ history, total, page, limit }` where `total` is the user's
 * total conversation count (for pagination UI), `page` and `limit` echo
 * the effective (clamped) request params.
 *
 * Security:
 *   - requireUser (401 on no session).
 *   - Only the user's own conversations are surfaced (Prisma `where:
 *     { userId }`).
 *   - Rate limit: 30/min/user.
 *
 * Performance:
 *   - One `count` + one `findMany` for the page of conversations
 *     (selecting only the metadata columns).
 *   - Three `groupBy` aggregations (message count, tool-execution count,
 *     token sum) over the page's conversation IDs — these hit indexed
 *     `conversationId` columns.
 *   - One `findMany` for the newest user message per conversation (via
 *     `distinct` + latest `createdAt`), used to derive the "last user
 *     message preview" per conversation in JS (cheaper than N+1 with
 *     `take: 1` per conversation).
 *   - All four secondary queries run in parallel via `Promise.all`.
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const PREVIEW_CHARS = 100;

interface HistoryEntry {
  id: string;
  title: string;
  provider: string;
  model: string;
  mode: string;
  updatedAt: string;
  messageCount: number;
  toolExecutionCount: number;
  totalTokens: number;
  totalTokensIn: number;
  totalTokensOut: number;
  lastUserMessagePreview: string;
}

function clampInt(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export async function GET(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `agent-history:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const page = clampInt(url.searchParams.get("page"), DEFAULT_PAGE, 1, 1_000_000);
  const limit = clampInt(
    url.searchParams.get("limit"),
    DEFAULT_LIMIT,
    MIN_LIMIT,
    MAX_LIMIT,
  );
  const skip = (page - 1) * limit;

  const total = await db.conversation.count({ where: { userId: user.id } });

  const conversations = await db.conversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    skip,
    take: limit,
    select: {
      id: true,
      title: true,
      provider: true,
      model: true,
      mode: true,
      updatedAt: true,
    },
  });

  if (conversations.length === 0) {
    return ok({ history: [], total, page, limit });
  }

  const ids = conversations.map((c) => c.id);

  let msgCounts, toolCounts, tokenSums, userMessages;
  try {
    [msgCounts, toolCounts, tokenSums, userMessages] = await Promise.all([
      db.message.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: ids } },
        _count: true,
      }),
      db.toolExecution.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: ids } },
        _count: true,
      }),
      db.message.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: ids } },
        _sum: { tokensIn: true, tokensOut: true },
      }),
      db.message.findMany({
        where: { conversationId: { in: ids }, role: "user" },
        // One row per conversation: the newest user message. `distinct`
        // with this orderBy returns the latest createdAt per conversationId.
        distinct: ["conversationId"],
        orderBy: [{ conversationId: "asc" }, { createdAt: "desc" }],
        select: { conversationId: true, content: true },
      }),
    ]);
  } catch (error) {
    console.error("[agents/history] failed to load aggregations:", error);
    return apiError("Failed to load history.", 500);
  }

  const msgCountMap = new Map<string, number>();
  for (const r of msgCounts) {
    if (r.conversationId) msgCountMap.set(r.conversationId, r._count);
  }
  const toolCountMap = new Map<string, number>();
  for (const r of toolCounts) {
    if (r.conversationId) toolCountMap.set(r.conversationId, r._count);
  }
  const tokenSumMap = new Map<string, { tokensIn: number; tokensOut: number }>();
  for (const r of tokenSums) {
    if (r.conversationId) {
      tokenSumMap.set(r.conversationId, {
        tokensIn: r._sum.tokensIn ?? 0,
        tokensOut: r._sum.tokensOut ?? 0,
      });
    }
  }
  // The user-messages query returns at most one (the newest) message per
  // conversation via `distinct`, so the map ends up with the LAST user
  // message preview per conversation.
  const lastUserMsgMap = new Map<string, string>();
  for (const m of userMessages) {
    lastUserMsgMap.set(m.conversationId, m.content);
  }

  const history: HistoryEntry[] = conversations.map((c) => {
    const tokens = tokenSumMap.get(c.id) ?? { tokensIn: 0, tokensOut: 0 };
    const preview = (lastUserMsgMap.get(c.id) ?? "").slice(0, PREVIEW_CHARS);
    return {
      id: c.id,
      title: c.title,
      provider: c.provider,
      model: c.model,
      mode: c.mode,
      updatedAt: c.updatedAt.toISOString(),
      messageCount: msgCountMap.get(c.id) ?? 0,
      toolExecutionCount: toolCountMap.get(c.id) ?? 0,
      totalTokens: tokens.tokensIn + tokens.tokensOut,
      totalTokensIn: tokens.tokensIn,
      totalTokensOut: tokens.tokensOut,
      lastUserMessagePreview: preview,
    };
  });

  return ok({ history, total, page, limit });
}

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  unauthorized, ok } from "@/app/api/_lib/helpers";

/**
 * Aggregate usage stats for the current user.
 *
 *   GET /api/stats/usage
 *
 * Returns:
 *   {
 *     totals: { conversations, messages, tokens, toolExecutions },
 *     byProvider: [{ provider, count }],
 *     byModel:    [{ model, count }]      // top 5 by message count
 *   }
 *
 * - `tokens` is the sum of tokensIn + tokensOut across ALL messages
 *   (user + assistant + tool).
 * - `byProvider` counts messages grouped by their `provider` column
 *   (assistant messages carry provider; user/tool rows have null and are
 *   excluded from the breakdown).
 * - `byModel` is the top 5 models by message count.
 *
 * Requires auth + rate limit (30/min/user).
 */

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `stats-usage:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const userId = user.id;
  const convWhere = { userId };

  const [
    totalConversations,
    totalMessages,
    tokensAgg,
    totalToolExecutions,
    byProviderAgg,
    byModelAgg,
  ] = await Promise.all([
    db.conversation.count({ where: convWhere }),
    db.message.count({ where: { conversation: convWhere } }),
    db.message.aggregate({
      where: { conversation: convWhere },
      _sum: { tokensIn: true, tokensOut: true },
    }),
    db.toolExecution.count({ where: { conversation: convWhere } }),
    db.message.groupBy({
      by: ["provider"],
      where: { conversation: convWhere },
      _count: true,
    }),
    db.message.groupBy({
      by: ["model"],
      where: { conversation: convWhere },
      _count: true,
      // No `take` here — Prisma only honours take on groupBy when orderBy
      // is also set; we sort + slice in JS instead.
    }),
  ]);

  const tokensIn = tokensAgg._sum.tokensIn ?? 0;
  const tokensOut = tokensAgg._sum.tokensOut ?? 0;

  // Sort + cap in JS (avoids Prisma's groupBy orderBy typing quirks).
  const byProvider = byProviderAgg
    .filter((r) => r.provider !== null)
    .map((r) => ({ provider: r.provider as string, count: r._count }))
    .sort((a, b) => b.count - a.count);
  const byModel = byModelAgg
    .filter((r) => r.model !== null)
    .map((r) => ({ model: r.model as string, count: r._count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return ok({
    totals: {
      conversations: totalConversations,
      messages: totalMessages,
      tokens: tokensIn + tokensOut,
      toolExecutions: totalToolExecutions,
    },
    byProvider,
    byModel,
  });
});

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  apiError,
  unauthorized,
  ok,
  toConversationDTO,
} from "@/app/api/_lib/helpers";

/**
 * Search the current user's conversations.
 *
 *   GET /api/conversations/search?q=<query>
 *
 * Behaviour:
 *   1. requireUser.
 *   2. Validate q (string, 1–200 chars after trim). If empty, return
 *      `{ conversations: [] }`.
 *   3. Search the user's conversations where the title contains q
 *      (case-insensitive) OR any message content contains q. Uses Prisma
 *      `contains` — SQLite's LIKE is case-insensitive for ASCII by default,
 *      so we omit `mode: "insensitive"` (which Prisma's SQLite connector
 *      does not accept).
 *   4. Return `{ conversations: ConversationDTO[] }` (without messages —
 *      just metadata) plus a `matchCount` (number of matching messages)
 *      and `matchedIn: "title" | "messages" | "both"` per result.
 *   5. Limit to 20 results, sorted by updatedAt desc.
 *   6. Rate limit (60/min/user).
 */

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `conv-search:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return ok({ conversations: [] });
  if (q.length > 200) {
    return apiError("Query too long (max 200 chars).", 400);
  }

  // Run two searches in parallel: conversations whose title matches, and
  // conversations that have any message whose content matches.
  const [titleMatches, msgMatches] = await Promise.all([
    db.conversation.findMany({
      where: {
        userId: user.id,
        title: { contains: q },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    db.conversation.findMany({
      where: {
        userId: user.id,
        messages: {
          some: { content: { contains: q } },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);

  const titleIds = new Set(titleMatches.map((c) => c.id));
  const msgIds = new Set(msgMatches.map((c) => c.id));
  const merged = new Map<string, (typeof titleMatches)[number]>();
  for (const c of titleMatches) merged.set(c.id, c);
  for (const c of msgMatches) {
    if (!merged.has(c.id)) merged.set(c.id, c);
  }

  const top = Array.from(merged.values())
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 20);

  if (top.length === 0) {
    return ok({ conversations: [] });
  }

  // Batch-count matching messages per conversation (avoids N+1).
  const topIds = top.map((c) => c.id);
  const countRows = await db.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: topIds },
      content: { contains: q },
    },
    _count: true,
  });
  const countMap = new Map<string, number>();
  for (const r of countRows) {
    if (r.conversationId) countMap.set(r.conversationId, r._count);
  }

  const conversations = top.map((c) => {
    const inTitle = titleIds.has(c.id);
    const inMsgs = msgIds.has(c.id);
    const matchedIn: "title" | "messages" | "both" =
      inTitle && inMsgs ? "both" : inTitle ? "title" : "messages";
    return {
      ...toConversationDTO(c),
      matchedIn,
      matchCount: countMap.get(c.id) ?? 0,
    };
  });

  return ok({ conversations });
});

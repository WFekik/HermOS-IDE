import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  unauthorized, ok } from "@/app/api/_lib/helpers";

/**
 * Token usage time series for the current user — last 7 days (including
 * today), grouped by day.
 *
 *   GET /api/stats/tokens
 *
 * Returns:
 *   {
 *     days: [{ date: "YYYY-MM-DD", tokensIn, tokensOut, total }]
 *   }
 *
 * - 7 entries, ordered ascending by date.
 * - Days with no usage still appear (with zeros).
 * - Day boundaries are UTC (Prisma stores DateTime as UTC; we use UTC
 *   getFullYear/getMonth/getDate for grouping so day buckets are stable
 *   regardless of the server's local timezone).
 *
 * Requires auth + rate limit (30/min/user).
 */

export const dynamic = "force-dynamic";

function formatYMD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `stats-tokens:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const userId = user.id;

  // Compute the UTC start of "today" and the UTC start of 6 days ago —
  // together they bound a 7-day window (inclusive of today).
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windowStart = new Date(todayStart);
  windowStart.setUTCDate(windowStart.getUTCDate() - 6);

  // Fetch every message in the window for this user. We pull tokensIn +
  // tokensOut + createdAt and bucket in JS — simpler than 7 separate
  // aggregates and the row count for a 7-day window is small.
  const messages = await db.message.findMany({
    where: {
      conversation: { userId },
      createdAt: { gte: windowStart },
    },
    select: { tokensIn: true, tokensOut: true, createdAt: true },
  });

  // Pre-seed all 7 days with zeros so days with no usage still appear.
  const dayMap = new Map<string, { tokensIn: number; tokensOut: number }>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(windowStart);
    d.setUTCDate(d.getUTCDate() + i);
    dayMap.set(formatYMD(d), { tokensIn: 0, tokensOut: 0 });
  }

  for (const m of messages) {
    const key = formatYMD(m.createdAt);
    const entry = dayMap.get(key);
    if (entry) {
      entry.tokensIn += m.tokensIn;
      entry.tokensOut += m.tokensOut;
    }
  }

  const days = Array.from(dayMap.entries())
    .map(([date, v]) => ({
      date,
      tokensIn: v.tokensIn,
      tokensOut: v.tokensOut,
      total: v.tokensIn + v.tokensOut,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return ok({ days });
});

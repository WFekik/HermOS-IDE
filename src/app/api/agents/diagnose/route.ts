// TODO(experimental/unwired): Kept intentionally — keyless-provider diagnostic
// endpoint is implemented and rate-limited but not yet surfaced in the UI
// (intended for future "Test Connection" / health-check panel). Safe to keep.
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, parseJson, ok, apiError } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const diagnoseSchema = z.object({
  message: z.string().trim().max(1000).optional().default("ping"),
});

/**
 * Diagnostic endpoint — tests whether the keyless provider responds correctly. Requires auth.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `diagnose:${user.id}`, { capacity: 10, refillPerSec: 10 / 60 });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = diagnoseSchema.safeParse(body ?? {});
  const message = parsed.success ? parsed.data.message : "ping";

  const result: Record<string, unknown> = {};
  const t0 = Date.now();

  try {
    const resp = await fetch("https://text.pollinations.ai/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-needed",
      },
      body: JSON.stringify({
        model: "openai-fast",
        messages: [{ role: "user", content: message }],
        stream: false,
        max_tokens: 100,
      }),
    });
    result.status = resp.status;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      result.error = `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    } else {
      const data = await resp.json();
      result.content = (data?.choices?.[0]?.message?.content ?? "").slice(0, 1000);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.latencyMs = Date.now() - t0;
  return ok(result);
});

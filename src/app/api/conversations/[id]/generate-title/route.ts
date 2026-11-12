import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { PROVIDERS, getProvider, isKeylessProvider, DEFAULT_PROVIDER } from "@/lib/ai/providers";
import { decrypt } from "@/lib/encryption";
import type { ProviderId } from "@/lib/types";
import {
  buildProviderHeaders,
  refreshRequestId,
  isResponsesRequired,
  isZenProvider,
  markResponsesRequired,
  clearResponsesRequired,
  buildResponsesRequestBody,
  resolveProviderUrls,
  resolveProviderBaseUrl,
  ZEN_PROTOCOL_FAILOVER_STATUSES,
  TITLE_MAX_OUTPUT_TOKENS,
} from "@/lib/ai/provider-payloads";
import { parseNonStreamingResponse } from "@/lib/ai/tool-call-parser";
import { fetchWithSsrf } from "@/lib/ai/ssrf-fetch";
import { cleanHeuristicTitle } from "@/lib/conversation-title";
import {
  withErrorHandler,
  notFound,
  ok,
  parseJson,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

function cleanTitle(raw: string): string {
  let cleaned = (raw || "").trim();
  cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned.replace(/<think[\s\S]*$/gi, "").trim();
  cleaned = cleaned.replace(/^#+\s*/, "");
  cleaned = cleaned.replace(/^\*+\s*|\s*\*+$/g, "");
  cleaned = cleaned.replace(/^[-*•]\s+/, "");
  cleaned = cleaned.replace(/^(the user wants|the user asks|conversation title|title|topic|subject)[:\s-]*/i, "");
  cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, "").trim();
  cleaned = cleaned.replace(/[.?!]+$/, "").trim();

  if (
    !cleaned ||
    cleaned.toLowerCase().includes("concise title") ||
    cleaned.toLowerCase().includes("user wants") ||
    cleaned.toLowerCase() === "new conversation"
  ) {
    return "";
  }
  return cleaned.length > 60 ? cleaned.slice(0, 60).replace(/\s+\S*$/, "") : cleaned;
}

const TITLE_PROMPT_BUDGET = 250;

async function generateTitle(
  baseUrl: string,
  apiKey: string,
  model: string,
  preview: string,
  providerId?: string,
  sessionId?: string,
): Promise<string> {
  const prompt = `Analyze the conversation excerpt below and generate a short, high-level topic title (3 to 5 words).
Rules:
- Capture the primary task or technical topic (e.g. "Docker Deployment Fix", "Next.js App Routing", "Local Models Auto-Compaction").
- Do NOT copy the user's initial sentence or words verbatim.
- Do NOT wrap in quotes, do NOT add trailing punctuation, and do NOT include any preamble or thought output.
- Output ONLY the 3 to 5 word title.

Conversation excerpt:
${preview}`;

  if (providerId === "anthropic") {
    const url = baseUrl.endsWith("/messages")
      ? baseUrl
      : `${baseUrl.replace(/\/+$/, "")}/messages`;
    const res = await fetchWithSsrf(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: TITLE_PROMPT_BUDGET,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Anthropic title generation failed: ${res.status} ${text.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }> } | null;
    let raw = "";
    if (Array.isArray(data?.content)) {
      for (const block of data.content) {
        if (block.type === "text" && typeof block.text === "string") {
          raw += block.text;
        }
      }
    }
    return cleanTitle(raw);
  }

  const useResponses = isResponsesRequired(providerId, baseUrl, model);
  const { completionsUrl, responsesUrl } = resolveProviderUrls(baseUrl);
  const url = useResponses ? responsesUrl : completionsUrl;

  const messages = [{ role: "user", content: prompt }];

  const headers = buildProviderHeaders({
    providerId,
    baseUrl,
    apiKey,
    sessionId,
    acceptStream: false,
  });
  const freshHeaders = () => refreshRequestId({ ...headers });

  const body = useResponses
    ? buildResponsesRequestBody({
        model,
        messages,
        maxTokens: TITLE_PROMPT_BUDGET,
        temperature: 0.3,
        stream: false,
      })
    : {
        model,
        messages,
        max_tokens: TITLE_PROMPT_BUDGET,
        temperature: 0.3,
      };

  let res = await fetchWithSsrf(url, {
    method: "POST",
    headers: freshHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  const isZen = isZenProvider(providerId, baseUrl);
  if (!useResponses && ZEN_PROTOCOL_FAILOVER_STATUSES.has(res.status) && isZen) {
    markResponsesRequired(baseUrl, model);
    const fallbackUrl = resolveProviderUrls(baseUrl).responsesUrl;
    const fallbackBody = buildResponsesRequestBody({
      model,
      messages,
      maxTokens: TITLE_PROMPT_BUDGET,
      temperature: 0.3,
      stream: false,
    });
    res = await fetchWithSsrf(fallbackUrl, {
      method: "POST",
      headers: freshHeaders(),
      body: JSON.stringify(fallbackBody),
      signal: AbortSignal.timeout(10000),
    });
  } else if (useResponses && ZEN_PROTOCOL_FAILOVER_STATUSES.has(res.status) && isZen) {
    clearResponsesRequired(baseUrl, model);
    const fallbackUrl = resolveProviderUrls(baseUrl).completionsUrl;
    res = await fetchWithSsrf(fallbackUrl, {
      method: "POST",
      headers: freshHeaders(),
      body: JSON.stringify({ model, messages, max_tokens: TITLE_PROMPT_BUDGET, temperature: 0.3 }),
      signal: AbortSignal.timeout(10000),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Title generation failed: ${res.status} ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const fullBody = await res.text();
  const parsed = parseNonStreamingResponse(fullBody);
  let raw = (parsed?.content ?? "").trim();
  if (!raw && parsed?.thinking) {
    raw = parsed.thinking.trim();
  }

  return cleanTitle(raw);
}

export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-gen-title:${user.id}`, { capacity: 20, refillPerSec: 20 / 60 });
    if (limited) return limited;
    const { id } = await params;

    const conv = await db.conversation.findUnique({ where: { id } });
    if (!conv || conv.userId !== user.id) return notFound("Conversation not found");

    const body = await parseJson<{ force?: boolean }>(req).catch(() => null);
    const force = body?.force === true;

    if (!force && conv.title && conv.title.trim().toLowerCase() !== "new conversation" && conv.title.trim() !== "") {
      return ok({ title: conv.title });
    }

    const messages = await db.message.findMany({
      where: { conversationId: id, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "asc" },
      take: 8,
      select: { role: true, content: true },
    });

    const realMessages = messages.filter(
      (m) =>
        m.content &&
        !m.content.startsWith("<context_summary") &&
        !m.content.startsWith("<subagent_report"),
    );

    if (realMessages.length === 0) {
      return ok({ title: conv.title || "New conversation" });
    }

    const firstUserMsg = realMessages.find((m) => m.role === "user");
    const fallbackTitle = cleanHeuristicTitle(firstUserMsg?.content || "") || "New conversation";

    const preview = realMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.content || "(empty)").slice(0, 400)}`)
      .join("\n\n");

    const lastMsgWithModel = await db.message.findFirst({
      where: {
        conversationId: id,
        model: { not: null },
        provider: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { provider: true, model: true },
    });

    let effectiveProvider = (lastMsgWithModel?.provider || conv.provider || "") as ProviderId;
    if (!effectiveProvider || effectiveProvider === "free" || !PROVIDERS[effectiveProvider]) {
      const activeKey = await db.providerKey.findFirst({
        where: { userId: user.id, isActive: true },
        orderBy: { updatedAt: "desc" },
      });
      effectiveProvider = (activeKey?.provider || DEFAULT_PROVIDER) as ProviderId;
    }

    const keyless = isKeylessProvider(effectiveProvider);
    const row = effectiveProvider
      ? await db.providerKey.findUnique({
          where: { userId_provider: { userId: user.id, provider: effectiveProvider } },
        })
      : null;

    const baseUrl = resolveProviderBaseUrl(effectiveProvider, row?.baseUrl);

    let effectiveModel = (lastMsgWithModel?.model || conv.model || "").trim();
    if (!effectiveModel || effectiveModel === "auto") {
      if (row?.models) {
        try {
          const parsed = JSON.parse(row.models);
          if (Array.isArray(parsed)) {
            const firstActive = parsed.find((m: any) => m && m.enabled !== false && typeof m.id === "string");
            if (firstActive?.id) effectiveModel = firstActive.id;
          }
        } catch {
          // ignore
        }
      }
    }
    if (!effectiveModel || effectiveModel === "auto") {
      const reg = getProvider(effectiveProvider) ?? PROVIDERS[effectiveProvider];
      if (reg?.models && reg.models.length > 0) {
        effectiveModel = reg.models[0].id;
      }
    }

    let apiKey = "";
    if (keyless) {
      if (row?.encryptedKey) {
        try {
          apiKey = decrypt(row.encryptedKey);
        } catch {
          apiKey = "";
        }
      }
    } else {
      if (!row || !row.isActive || !row.encryptedKey) {
        if (!conv.title || conv.title.trim().toLowerCase() === "new conversation") {
          await db.conversation.update({
            where: { id },
            data: {
              title: fallbackTitle,
              ...(effectiveProvider && conv.provider !== effectiveProvider ? { provider: effectiveProvider } : {}),
              ...(effectiveModel && conv.model !== effectiveModel ? { model: effectiveModel } : {}),
            },
          });
          return ok({ title: fallbackTitle });
        }
        return ok({ title: conv.title });
      }
      try {
        apiKey = decrypt(row.encryptedKey);
      } catch (err) {
        console.warn("[generate-title] Failed to decrypt API key:", err instanceof Error ? err.message : err);
        return ok({ title: conv.title });
      }
    }

    if (!effectiveModel || !baseUrl) {
      if (!conv.title || conv.title.trim().toLowerCase() === "new conversation") {
        await db.conversation.update({
          where: { id },
          data: {
            title: fallbackTitle,
            ...(effectiveProvider && conv.provider !== effectiveProvider ? { provider: effectiveProvider } : {}),
            ...(effectiveModel && conv.model !== effectiveModel ? { model: effectiveModel } : {}),
          },
        });
        return ok({ title: fallbackTitle });
      }
      return ok({ title: conv.title });
    }

    let title = "";
    try {
      title = await generateTitle(baseUrl, apiKey, effectiveModel, preview, effectiveProvider, id);
    } catch (err) {
      console.warn("[generate-title] LLM generation failed, falling back:", err instanceof Error ? err.message : err);
    }

    if (!title) {
      title = fallbackTitle;
    }

    await db.conversation.update({
      where: { id },
      data: {
        title,
        ...(effectiveProvider && conv.provider !== effectiveProvider ? { provider: effectiveProvider } : {}),
        ...(effectiveModel && conv.model !== effectiveModel ? { model: effectiveModel } : {}),
      },
    });

    return ok({ title });
  },
);

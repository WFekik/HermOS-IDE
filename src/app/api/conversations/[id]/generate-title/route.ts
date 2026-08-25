import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { PROVIDERS } from "@/lib/ai/providers";
import { decrypt } from "@/lib/encryption";
import type { ProviderId } from "@/lib/types";
import {
  withErrorHandler,
  notFound,
  ok,
} from "@/app/api/_lib/helpers";
import { assertUrlAllowed, checkUrlHost } from "@/lib/ssrf";

export const dynamic = "force-dynamic";

async function generateTitle(baseUrl: string, apiKey: string, model: string, preview: string): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  await assertUrlAllowed(url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a title generator. Generate a short, descriptive title (3 to 5 words) for the conversation topic. Output ONLY the title text. Do NOT include preambles, meta-commentary, or quotes.",
        },
        {
          role: "user",
          content: `Messages:\n${preview}`,
        },
      ],
      max_tokens: 20,
      temperature: 0.3,
    }),
  });

  if (res.redirected) {
    const reason = await checkUrlHost(res.url);
    if (reason) throw new Error(`URL blocked by SSRF policy after redirect: ${reason}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Title generation failed: ${res.status} ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  let raw = (data?.choices?.[0]?.message?.content ?? "New conversation").trim();

  // Clean preambles like "The user wants a concise title...", "Title:", quotes
  raw = raw.replace(/^(the user wants|the user asks|conversation title|title)[:\s]*/i, "");
  raw = raw.replace(/^["'`](.*)["'`]$/, "$1").trim();
  raw = raw.replace(/\.$/, "").trim();

  if (!raw || raw.toLowerCase().includes("concise title") || raw.toLowerCase().includes("user wants")) {
    raw = "Codebase Review";
  }

  return raw.length > 50 ? raw.slice(0, 50).replace(/\s+\S*$/, "") : raw;
}

export const POST = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `conv-gen-title:${user.id}`, { capacity: 20, refillPerSec: 20 / 60 });
    if (limited) return limited;
    const { id } = await params;

    const conv = await db.conversation.findUnique({ where: { id } });
    if (!conv || conv.userId !== user.id) return notFound("Conversation not found");

    if (conv.title !== "New conversation") {
      return ok({ title: conv.title });
    }

    const messages = await db.message.findMany({
      where: { conversationId: id, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "asc" },
      take: 4,
      select: { role: true, content: true },
    });

    if (messages.length === 0) {
      return ok({ title: "New conversation" });
    }

    const preview = messages
      .map((m) => `${m.role}: ${(m.content || "(empty)").slice(0, 300)}`)
      .join("\n\n");

    // Resolve provider key for the conversation's provider
    const providerId = (conv.provider || "") as ProviderId;

    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId: user.id, provider: providerId } },
    });
    if (!row || !row.isActive || !row.encryptedKey) return ok({ title: conv.title });
    let apiKey: string;
    try {
      apiKey = decrypt(row.encryptedKey);
    } catch (err) {
      console.warn("[generate-title] Failed to decrypt API key:", err instanceof Error ? err.message : err);
      return ok({ title: conv.title, failed: true });
    }
    const baseUrl = row.baseUrl || PROVIDERS[providerId]?.baseUrl || "";
    const model = conv.model ?? PROVIDERS[providerId]?.models[0]?.id ?? "";
    if (!model) return ok({ title: conv.title });

    let title: string;
    try {
      title = await generateTitle(baseUrl, apiKey, model, preview);
    } catch (err) {
      console.warn("[generate-title] Failed to generate title:", err instanceof Error ? err.message : err);
      return ok({ title: conv.title, failed: true });
    }

    await db.conversation.update({
      where: { id },
      data: { title },
    });

    return ok({ title });
  },
);

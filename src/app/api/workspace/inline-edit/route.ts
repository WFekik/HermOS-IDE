import { NextRequest } from "next/server";
import { z } from "zod";
import path from "path";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { parseJson, apiError, unauthorized, ok, withErrorHandler } from "@/app/api/_lib/helpers";
import { fetchWithSsrf } from "@/lib/ai/ssrf-fetch";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { PROVIDERS } from "@/lib/ai/providers";
import { parseModelsColumn } from "@/lib/provider-models";
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
  ZEN_PROTOCOL_FAILOVER_STATUSES,
  INLINE_EDIT_MAX_OUTPUT_TOKENS,
} from "@/lib/ai/provider-payloads";
import { parseNonStreamingResponse } from "@/lib/ai/tool-call-parser";

export const dynamic = "force-dynamic";

const inlineEditSchema = z.object({
  path: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(2000),
  code: z.string(),
  fullContent: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".js": "JavaScript",
    ".jsx": "JavaScript React",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".c": "C",
    ".cpp": "C++",
    ".cs": "C#",
    ".php": "PHP",
    ".rb": "Ruby",
    ".html": "HTML",
    ".css": "CSS",
    ".scss": "SCSS",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".md": "Markdown",
    ".sql": "SQL",
    ".sh": "Bash/Shell",
    ".bash": "Bash/Shell",
    ".zsh": "Zsh",
    ".ps1": "PowerShell",
    ".bat": "Batch",
    ".cmd": "Batch",
    ".dockerfile": "Dockerfile",
  };
  return map[ext] || (ext ? ext.replace(".", "") : "code");
}

function cleanCodeOutput(raw: string): string {
  let cleaned = raw.trim();
  const match = cleaned.match(/^```(?:[a-zA-Z0-9_#-]+)?\r?\n([\s\S]*?)\r?\n```$/);
  if (match) {
    cleaned = match[1];
  }
  return cleaned;
}

async function performAiInlineEdit(
  userId: string,
  filePath: string,
  instruction: string,
  code: string,
  fullContent?: string,
  startLine?: number,
  endLine?: number,
): Promise<string | null> {
  const keyRows = await db.providerKey.findMany({
    where: { userId, isActive: true },
  });
  if (!keyRows.length) return null;

  const preferredOrder: ProviderId[] = [
    "anthropic",
    "openai",
    "openrouter",
    "groq",
    "gemini",
    "nvidia",
    "mistral",
    "together",
    "puter",
    "zen",
    "custom",
  ];

  const row =
    preferredOrder
      .map((p) => keyRows.find((k) => k.provider === p))
      .find((k) => k !== undefined) || keyRows[0];

  if (!row?.encryptedKey) return null;

  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch {
    return null;
  }

  const providerId = row.provider as ProviderId;
  const info = PROVIDERS[providerId];
  const baseUrl = row.baseUrl || info?.baseUrl || "";
  if (!baseUrl && providerId !== "anthropic") return null;

  const parsedModels = parseModelsColumn(row.models);
  const model = parsedModels.find((m) => m.enabled)?.id || info?.models?.[0]?.id;
  if (!model) return null;

  const lang = getLanguageFromPath(filePath);
  const systemPrompt = `You are an expert AI code editor. Modify the user's provided code snippet according to their instruction.
Rules:
- Output ONLY the replacement code snippet.
- Do NOT wrap your output in markdown code fences (\`\`\`).
- Do NOT include any explanations, preambles, or conversational commentary.
- Preserve existing style, indentation, and formatting.`;

  const userPrompt = `File: ${filePath}
Language: ${lang}
${startLine && endLine ? `Lines: ${startLine}-${endLine}\n` : ""}${fullContent && fullContent !== code ? `Context snippet:\n${fullContent.slice(0, 1500)}\n\n` : ""}Instruction: ${instruction}

Target Code to Modify:
${code}`;

  try {
    if (providerId === "anthropic") {
      const url = (baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "") + "/messages";
      // SSRF: user-editable baseUrl — fetchWithSsrf validates every redirect hop.
      const res = await fetchWithSsrf(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          max_tokens: INLINE_EDIT_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = data?.content?.find((c) => c.type === "text")?.text;
      return text !== undefined ? cleanCodeOutput(text) : null;
    } else {
      const useResponses = isResponsesRequired(providerId, baseUrl, model);
      const { completionsUrl, responsesUrl } = resolveProviderUrls(baseUrl);
      const url = useResponses ? responsesUrl : completionsUrl;
      // SSRF: user-editable baseUrl — fetchWithSsrf validates every redirect hop.
      const headers = buildProviderHeaders({
        providerId,
        baseUrl,
        apiKey,
        // Stable per-user affinity for one-shots (avoids random session per request).
        sessionId: `inline-${userId}`,
        acceptStream: false,
      });
      const freshHeaders = () => refreshRequestId({ ...headers });
      const body = useResponses
        ? buildResponsesRequestBody({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
            maxTokens: INLINE_EDIT_MAX_OUTPUT_TOKENS,
            stream: false,
          })
        : {
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: INLINE_EDIT_MAX_OUTPUT_TOKENS,
          };
      let res = await fetchWithSsrf(url, {
        method: "POST",
        headers: freshHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const isZen = isZenProvider(providerId, baseUrl);
      if (!useResponses && ZEN_PROTOCOL_FAILOVER_STATUSES.has(res.status) && isZen) {
        markResponsesRequired(baseUrl, model);
        const fallbackUrl = resolveProviderUrls(baseUrl).responsesUrl;
        const fallbackBody = buildResponsesRequestBody({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          maxTokens: INLINE_EDIT_MAX_OUTPUT_TOKENS,
          stream: false,
        });
        res = await fetchWithSsrf(fallbackUrl, {
          method: "POST",
          headers: freshHeaders(),
          body: JSON.stringify(fallbackBody),
          signal: AbortSignal.timeout(30000),
        });
      } else if (useResponses && ZEN_PROTOCOL_FAILOVER_STATUSES.has(res.status) && isZen) {
        clearResponsesRequired(baseUrl, model);
        const fallbackUrl = resolveProviderUrls(baseUrl).completionsUrl;
        res = await fetchWithSsrf(fallbackUrl, {
          method: "POST",
          headers: freshHeaders(),
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.2,
            max_tokens: INLINE_EDIT_MAX_OUTPUT_TOKENS,
          }),
          signal: AbortSignal.timeout(30000),
        });
      }
      if (!res.ok) return null;
      const fullBody = await res.text();
      const parsed = parseNonStreamingResponse(fullBody);
      const text = parsed?.content;
      return text !== undefined ? cleanCodeOutput(text) : null;
    }
  } catch (err) {
    console.warn("[inline-edit] AI generation failed, using fallback:", err instanceof Error ? err.message : err);
    return null;
  }
}

export const POST = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const limited = await withRateLimit(req, `inline-edit:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = inlineEditSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid inline-edit payload.", 400, {
      details: parsed.error.flatten(),
    });
  }

  const { path: filePath, instruction, code, fullContent, startLine, endLine } = parsed.data;

  try {
    let modifiedCode: string | null = await performAiInlineEdit(
      user.id,
      filePath,
      instruction,
      code,
      fullContent,
      startLine,
      endLine,
    );

    if (modifiedCode === null) {
      if (instruction.toLowerCase().includes("comment") || instruction.toLowerCase().includes("jsdoc")) {
        modifiedCode = `/**\n * ${instruction}\n */\n` + code;
      } else {
        modifiedCode = code;
      }
    }

    return ok({
      ok: true,
      path: filePath,
      instruction,
      originalCode: code,
      modifiedCode,
      startLine,
      endLine,
    });
  } catch (e) {
    console.error("[inline-edit] generation failed:", e);
    return apiError("Inline edit generation failed.", 500);
  }
});

import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { unauthorized, notFound, apiError, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

/**
 * Conversation export.
 *
 *   GET /api/conversations/[id]/export
 *
 * Returns the conversation as a Markdown file with:
 *   Content-Type: text/markdown; charset=utf-8
 *   Content-Disposition: attachment; filename="<slug>.md"
 *
 * The body alternates `### You` and `### HermOS` sections for user/assistant
 * messages, skips tool-role messages (their results are summarised in a
 * `<details>` block at the end), and includes a header block with the
 * provider/model/mode and export timestamp.
 *
 * Requires auth + ownership. Rate limited at 30/min/user.
 */

export const dynamic = "force-dynamic";

const MAX_EXPORT_MESSAGES = 1000;
const MAX_TOOL_ROWS = 500;

function slugify(s: string): string {
  const cleaned = (s || "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "conversation";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/** Escape a string so it round-trips cleanly inside a markdown details block. */
function mdEscapeInline(s: string): string {
  return s.replace(/[`*_[\]<>|\\]/g, (c) => "\\" + c);
}

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
  const limited = await withRateLimit(req, `conv-export:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const { id } = await params;
  const conv = await db.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      tools: { orderBy: { createdAt: "asc" }, take: MAX_TOOL_ROWS },
    },
  });
  if (!conv || conv.userId !== user.id) {
    return notFound("Conversation not found");
  }

  const lines: string[] = [];
  lines.push(`# ${conv.title || "Untitled conversation"}`);
  lines.push("");
  lines.push(
    `> Provider: ${conv.provider} · Model: ${conv.model} · Mode: ${conv.mode}`,
  );
  lines.push(`> Exported: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  let emitted = 0;
  for (const m of conv.messages) {
    if (emitted >= MAX_EXPORT_MESSAGES) {
      lines.push(
        `> …[export truncated at ${MAX_EXPORT_MESSAGES} messages]`,
      );
      break;
    }
    if (m.role === "system") continue;
    if (m.role === "tool") continue; // summarised below
    if (m.role === "user") {
      lines.push("### You");
      lines.push("");
      lines.push(m.content || "(empty)");
      lines.push("");
    } else if (m.role === "assistant") {
      lines.push("### HermOS");
      lines.push("");
      lines.push(m.content || "(empty)");
      if (m.model || m.provider) {
        const bits: string[] = [];
        if (m.provider) bits.push(`provider: ${m.provider}`);
        if (m.model) bits.push(`model: ${m.model}`);
        if (m.tokensIn || m.tokensOut) {
          bits.push(`tokens: ${m.tokensIn} in / ${m.tokensOut} out`);
        }
        if (m.latencyMs) bits.push(`${m.latencyMs}ms`);
        lines.push("");
        lines.push(`> ${bits.join(" · ")}`);
      }
      lines.push("");
    }
    emitted++;
  }

  // Tool executions summary in a collapsible block.
  if (conv.tools.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push(
      `<details><summary>Tool executions (${conv.tools.length})</summary>`,
    );
    lines.push("");
    for (const t of conv.tools) {
      const status = t.status;
      const dur = `${t.durationMs}ms`;
      let inputStr = "(none)";
      if (t.input) {
        try {
          inputStr = truncate(JSON.stringify(JSON.parse(t.input)), 600);
        } catch {
          inputStr = truncate(t.input, 600);
        }
      }
      let outputStr = "(none)";
      if (t.output) {
        try {
          outputStr = truncate(JSON.stringify(JSON.parse(t.output)), 600);
        } catch {
          outputStr = truncate(t.output, 600);
        }
      }
      lines.push(
        `- **${mdEscapeInline(t.toolName)}** — ${status} — ${dur}`,
      );
      lines.push(`  - input: \`${mdEscapeInline(inputStr)}\``);
      lines.push(`  - output: \`${mdEscapeInline(outputStr)}\``);
    }
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  }

  const body = lines.join("\n");
  const filename = `${slugify(conv.title)}.md`;
  // Encode filename for the Content-Disposition header per RFC 5987.
  const filenameStar = encodeURIComponent(filename);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`,
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    },
  });
}

import { NextRequest } from "next/server";
import path from "path";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { apiError, notFound, enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { UPLOADS_ROOT } from "@/lib/paths";
import { isSubpathOrEqual } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/attachments/[id]
 *
 * Serves the raw attachment bytes so the frontend can display images, PDFs,
 * and downloadable files inline. Validates the requesting user owns the
 * conversation the attachment belongs to.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(_req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const id = (await params).id;

  const attachment = await db.attachment.findUnique({ where: { id } });
  if (!attachment) return notFound();

  // Verify ownership via the conversation
  const conversation = await db.conversation.findUnique({
    where: { id: attachment.conversationId },
    select: { userId: true },
  });
  if (!conversation || conversation.userId !== user.id) {
    return notFound();
  }

  const filePath = attachment.path;

  // Defense-in-depth: Ensure filePath is strictly contained in UPLOADS_ROOT
  // before any existence check, so out-of-root paths never leak existence.
  const absPath = path.resolve(/* turbopackIgnore: true */ filePath ?? "");
  const absUploads = path.resolve(/* turbopackIgnore: true */ UPLOADS_ROOT);
  if (!filePath || !isSubpathOrEqual(absPath, absUploads)) {
    return apiError("Access denied: Attachment path outside uploads root.", 403);
  }

  if (!existsSync(/* turbopackIgnore: true */ filePath)) {
    return apiError("Attachment file not found on disk.", 404);
  }

  let data: Buffer;
  try {
    data = await readFile(/* turbopackIgnore: true */ filePath);
  } catch {
    return apiError("Failed to read attachment file.", 500);
  }

  // Executable-in-browser MIME families (html/xml/svg) are served as
  // downloads with a sandbox CSP so their scripts can never run in the app
  // origin; everything else stays inline (images/PDFs display in-chat).
  const riskyInline = /(text\/html|application\/xhtml\+xml|text\/xml|application\/xml|image\/svg\+xml)/i.test(attachment.type || "");
  const disposition = riskyInline
    ? `attachment; filename="${encodeURIComponent(attachment.name)}"`
    : `inline; filename="${encodeURIComponent(attachment.name)}"`;

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": attachment.type || "application/octet-stream",
      "Content-Length": String(data.length),
      "Content-Disposition": disposition,
      "X-Content-Type-Options": "nosniff",
      ...(riskyInline
        ? { "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups" }
        : {}),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
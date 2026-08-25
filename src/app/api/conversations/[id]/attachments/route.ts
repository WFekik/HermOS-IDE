import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { UPLOADS_ROOT } from "@/lib/paths";
import {
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/validation";
import crypto from "crypto";
import { enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/conversations/[id]/attachments
 *
 * Upload one or more files to be used as chat attachments.
 * Accepts multipart/form-data with multiple `file` fields.
 *
 * Returns `{ attachments: AttachmentDTO[] }` where each entry has the
 * persisted `id` the client sends back on the next ChatRequest.
 *
 * Limits:
 *   - 50 MB per file (MAX_ATTACHMENT_BYTES)
 *   - 20 files total (MAX_ATTACHMENTS_PER_MESSAGE)
 *   - Only MIME types in ALLOWED_ATTACHMENT_TYPES (or image/* / text/*)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const limited = await withRateLimit(req, `attachments:${user.id}`, {
    capacity: 20,
    refillPerSec: 1,
  });
  if (limited) return limited;

  const conversationId = (await params).id;

  // Verify conversation ownership
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conversation || conversation.userId !== user.id) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid multipart body" }), { status: 400 });
  }

  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key === "file" && value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return new Response(JSON.stringify({ error: "No files provided. Use field name 'file'." }), { status: 400 });
  }
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return new Response(
      JSON.stringify({ error: `Too many files. Max ${MAX_ATTACHMENTS_PER_MESSAGE} per request.` }),
      { status: 400 },
    );
  }

  // Ensure uploads directory exists
  const uploadDir = path.join(UPLOADS_ROOT, user.id);
  if (!existsSync(/* turbopackIgnore: true */ uploadDir)) {
    mkdirSync(/* turbopackIgnore: true */ uploadDir, { recursive: true });
  }

  const results: Array<{
    id: string;
    name: string;
    type: string;
    size: number;
  }> = [];

  for (const file of files) {
    // Validate size
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return new Response(
        JSON.stringify({
          error: `File "${file.name}" exceeds ${MAX_ATTACHMENT_BYTES / 1000 / 1000} MB limit (${file.size} bytes).`,
        }),
        { status: 413 },
      );
    }

    // Validate MIME type
    const fileType = file.type || "application/octet-stream";
    if (!isAllowedAttachmentType(fileType)) {
      return new Response(
        JSON.stringify({
          error: `File type "${fileType}" for "${file.name}" is not allowed. Accepted: images, text files, PDFs, and common office/doc formats.`,
        }),
        { status: 415 },
      );
    }

    // Read bytes and write to disk
    const buffer = Buffer.from(await file.arrayBuffer());

    // Content-sniffing: if octet-stream but looks like text, reclassify
    let resolvedType = fileType;
    if (resolvedType === "application/octet-stream") {
      if (looksLikeText(buffer)) {
        resolvedType = "text/plain";
      }
    }

    const ext = path.extname(file.name) || ".bin";
    const id = crypto.randomUUID();
    const safeName = `${id}${ext}`;
    const dest = path.join(/* turbopackIgnore: true */ uploadDir, safeName);

    // Write to disk
    await writeFile(/* turbopackIgnore: true */ dest, buffer);

    // Persist Attachment row
    const attachment = await db.attachment.create({
      data: {
        conversationId,
        userId: user.id,
        name: file.name,
        type: resolvedType,
        size: file.size,
        path: dest,
      },
    });

    results.push({
      id: attachment.id,
      name: file.name,
      type: resolvedType,
      size: file.size,
    });
  }

  return NextResponse.json({ attachments: results });
}

function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  // Scan first 1024 bytes; if no null bytes (common binary marker), treat as text.
  const sample = buf.slice(0, Math.min(buf.length, 1024));
  for (const b of sample) {
    if (b === 0) return false;
  }
  return true;
}

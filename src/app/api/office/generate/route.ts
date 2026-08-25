import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import {
  generatePpt,
  generateDoc,
  generatePdf,
  resolveOutputPath,
  MAX_SLIDES,
  MAX_SECTIONS,
  type PptSlide,
  type DocSection,
  type PdfSection,
  type PptTheme,
} from "@/lib/office/generator";
import { parseJson, apiError, unauthorized, ok, audit, withErrorHandler } from "@/app/api/_lib/helpers";

/**
 * POST /api/office/generate — generate a real Office/PDF document into the
 * user's active workspace.
 *
 * Body:
 *   {
 *     type:     "ppt" | "doc" | "pdf",
 *     path:     "<workspace-relative output path>",
 *     title:    "<document title>",
 *     slides?:  [{ title, bullets: string[], notes? }]   (for "ppt", ≤50),
 *     sections?: [{ heading, paragraphs: string[] }]      (for "doc"/"pdf", ≤50),
 *     theme?:   "professional" | "modern" | "minimal"     (for "ppt")
 *   }
 *
 * Returns `{ ok: true, path, stats }` where `stats` is `{ slides: N }` for
 * PPT or `{ sections: N }` for DOC/PDF.
 *
 * Security:
 *   - requireUser (401 on no session).
 *   - Active workspace auto-provisioned if none exists.
 *   - Output path confined via `safePath` (no traversal escapes).
 *   - Title ≤200 chars; slides/sections ≤50 each; bullets/paragraphs capped
 *     inside the generators.
 *   - Rate limit: 5/min/user (generation is heavy).
 *   - Audit log entry on every generation.
 */

export const dynamic = "force-dynamic";

const slideSchema = z.object({
  title: z.string().trim().min(1).max(200),
  bullets: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  notes: z.string().trim().max(8000).optional(),
});

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.string().trim().min(1).max(8000)).max(50).default([]),
});

const bodySchema = z
  .object({
    type: z.enum(["ppt", "doc", "pdf"]),
    path: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(200),
    slides: z.array(slideSchema).max(MAX_SLIDES).optional(),
    sections: z.array(sectionSchema).max(MAX_SECTIONS).optional(),
    theme: z.enum(["professional", "modern", "minimal"]).optional(),
  })
  .refine((d) => {
    if (d.type === "ppt") return Array.isArray(d.slides) && d.slides.length > 0;
    return Array.isArray(d.sections) && d.sections.length > 0;
  }, "ppt requires non-empty `slides`; doc/pdf require non-empty `sections`");

async function resolveWs(userId: string) {
  return await getActiveWorkspace(userId) ?? await ensureDefaultWorkspace(userId);
}

export const POST = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  // 5/min/user — generation is heavy.
  const limited = await withRateLimit(req, `office:${user.id}`, {
    capacity: 5,
    refillPerSec: 5 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }
  const d = parsed.data;

  const ws = await resolveWs(user.id);
  // Resolve + confine the output path. This also creates the parent dir.
  let absPath: string;
  try {
    absPath = await resolveOutputPath(user.id, ws.name, d.path);
  } catch (e) {
    return apiError(
      e instanceof Error ? e.message : "Invalid output path.",
      400,
    );
  }

  try {
    if (d.type === "ppt") {
      const slides: PptSlide[] = (d.slides || []).map((s) => ({
        title: s.title,
        bullets: s.bullets,
        notes: s.notes,
      }));
      const theme: PptTheme = d.theme ?? "professional";
      const r = await generatePpt({
        title: d.title,
        slides,
        theme,
        outputPath: absPath,
      });
      await audit(
        user.id,
        "office_generate",
        JSON.stringify({ type: "ppt", path: d.path, slides: r.slides, theme }),
      );
      return ok({ ok: true, path: d.path, stats: { slides: r.slides } });
    }
    if (d.type === "doc") {
      const sections: DocSection[] = (d.sections || []).map((s) => ({
        heading: s.heading,
        paragraphs: s.paragraphs,
      }));
      const r = await generateDoc({
        title: d.title,
        sections,
        outputPath: absPath,
      });
      await audit(
        user.id,
        "office_generate",
        JSON.stringify({ type: "doc", path: d.path, sections: r.sections }),
      );
      return ok({ ok: true, path: d.path, stats: { sections: r.sections } });
    }
    const sections: PdfSection[] = (d.sections || []).map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs,
    }));
    const r = await generatePdf({
      title: d.title,
      sections,
      outputPath: absPath,
    });
    await audit(
      user.id,
      "office_generate",
      JSON.stringify({ type: "pdf", path: d.path, sections: r.sections }),
    );
    return ok({ ok: true, path: d.path, stats: { sections: r.sections } });
  } catch (e) {
    // Log the real failure server-side; return a generic message so library
    // internals / filesystem details never leak to the client.
    console.error("[office:generate] generation failed:", e);
    return apiError("Document generation failed.", 500, { code: "GENERATE_FAILED" });
  }
});

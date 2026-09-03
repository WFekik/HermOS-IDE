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
} from "@/lib/office/generator";
import type {
  PptSlide,
  DocSection,
  OfficeThemeId,
} from "@/lib/office/types";
import { parseJson, apiError, unauthorized, ok, audit, withErrorHandler } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const slideSchema = z.object({
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().max(300).optional(),
  layout: z
    .enum(["title", "bullets", "cards", "split", "image_split", "table", "timeline", "quote"])
    .optional(),
  bullets: z.array(z.string().trim().max(100_000)).max(30).default([]),
  cards: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(1000),
        value: z.string().trim().max(50).optional(),
        badge: z.string().trim().max(50).optional(),
        icon: z.string().trim().max(50).optional(),
      })
    )
    .max(6)
    .optional(),
  columns: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(120),
        bullets: z.array(z.string().trim().max(1000)).max(15),
      })
    )
    .max(2)
    .optional(),
  table: z
    .object({
      headers: z.array(z.string().trim().max(100)).max(10),
      rows: z.array(z.array(z.string().trim().max(500)).max(10)).max(20),
    })
    .optional(),
  steps: z
    .array(
      z.object({
        step: z.string().trim().max(20),
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(1000),
      })
    )
    .max(6)
    .optional(),
  quote: z
    .object({
      text: z.string().trim().min(1).max(2000),
      author: z.string().trim().max(120).optional(),
      role: z.string().trim().max(120).optional(),
    })
    .optional(),
  image: z
    .object({
      path: z.string().trim().min(1).max(1000),
      alt: z.string().trim().max(200).optional(),
      caption: z.string().trim().max(300).optional(),
      position: z.enum(["left", "right", "hero"]).optional(),
    })
    .optional(),
  notes: z.string().trim().max(8000).optional(),
  accentColor: z.string().trim().max(20).optional(),
});

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(300),
  subheading: z.string().trim().max(300).optional(),
  paragraphs: z.array(z.string().trim().max(10_000)).max(50).default([]),
  bullets: z.array(z.string().trim().max(2000)).max(30).optional(),
  callout: z
    .object({
      type: z.enum(["info", "tip", "warning", "quote"]).optional(),
      title: z.string().trim().max(120).optional(),
      text: z.string().trim().min(1).max(3000),
    })
    .optional(),
  table: z
    .object({
      headers: z.array(z.string().trim().max(100)).max(10),
      rows: z.array(z.array(z.string().trim().max(500)).max(10)).max(25),
    })
    .optional(),
  metrics: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        value: z.string().trim().min(1).max(50),
        change: z.string().trim().max(50).optional(),
      })
    )
    .max(6)
    .optional(),
  image: z
    .object({
      path: z.string().trim().min(1).max(1000),
      caption: z.string().trim().max(300).optional(),
    })
    .optional(),
});

const bodySchema = z
  .object({
    type: z.enum(["ppt", "doc", "pdf"]),
    path: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(300),
    subtitle: z.string().trim().max(300).optional(),
    author: z.string().trim().max(120).optional(),
    organization: z.string().trim().max(120).optional(),
    slides: z.array(slideSchema).max(MAX_SLIDES).optional(),
    sections: z.array(sectionSchema).max(MAX_SECTIONS).optional(),
    theme: z
      .enum(["executive", "emerald", "charcoal", "crimson", "nordic", "cyberpunk", "professional", "modern", "minimal"])
      .optional(),
  })
  .refine((d) => {
    if (d.type === "ppt") return Array.isArray(d.slides) && d.slides.length > 0;
    return Array.isArray(d.sections) && d.sections.length > 0;
  }, "ppt requires non-empty `slides`; doc/pdf require non-empty `sections`");

async function resolveWs(userId: string) {
  return (await getActiveWorkspace(userId)) ?? (await ensureDefaultWorkspace(userId));
}

export const POST = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const limited = await withRateLimit(req, `office:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
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
  let absPath: string;
  try {
    absPath = await resolveOutputPath(user.id, ws.name, d.path);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "Invalid output path.", 400);
  }

  try {
    if (d.type === "ppt") {
      const r = await generatePpt({
        title: d.title,
        subtitle: d.subtitle,
        author: d.author,
        slides: (d.slides || []) as PptSlide[],
        theme: d.theme as OfficeThemeId,
        outputPath: absPath,
      });
      await audit(
        user.id,
        "office_generate",
        JSON.stringify({ type: "ppt", path: d.path, slides: r.slides, theme: r.manifest.theme }),
      );
      return ok({ ok: true, path: d.path, stats: { slides: r.slides }, manifest: r.manifest });
    }
    if (d.type === "doc") {
      const r = await generateDoc({
        title: d.title,
        subtitle: d.subtitle,
        author: d.author,
        organization: d.organization,
        sections: (d.sections || []) as DocSection[],
        theme: d.theme as OfficeThemeId,
        outputPath: absPath,
      });
      await audit(
        user.id,
        "office_generate",
        JSON.stringify({ type: "doc", path: d.path, sections: r.sections, theme: r.manifest.theme }),
      );
      return ok({ ok: true, path: d.path, stats: { sections: r.sections }, manifest: r.manifest });
    }

    const r = await generatePdf({
      title: d.title,
      subtitle: d.subtitle,
      author: d.author,
      organization: d.organization,
      sections: (d.sections || []) as DocSection[],
      theme: d.theme as OfficeThemeId,
      outputPath: absPath,
    });
    await audit(
      user.id,
      "office_generate",
      JSON.stringify({ type: "pdf", path: d.path, sections: r.sections, theme: r.manifest.theme }),
    );
    return ok({ ok: true, path: d.path, stats: { sections: r.sections }, manifest: r.manifest });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "Office generation failed.", 500);
  }
});

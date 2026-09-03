import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { requireUser } from "@/lib/session";
import { getActiveWorkspace, ensureDefaultWorkspace, safePath } from "@/lib/workspace";
import { readOfficeManifest, extractOfficeText } from "@/lib/office/generator";
import type { OfficeDocManifest } from "@/lib/office/types";
import { apiError, unauthorized, ok, withErrorHandler } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const OFFICE_EXTS = new Set([".pptx", ".docx", ".pdf"]);

async function findOfficeFiles(dir: string, maxDepth = 4, currentDepth = 0): Promise<string[]> {
  if (currentDepth > maxDepth || !existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await findOfficeFiles(full, maxDepth, currentDepth + 1);
        results.push(...sub);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (OFFICE_EXTS.has(ext)) {
          results.push(full);
        }
      }
    }
  } catch {
    /* ignore read errors */
  }
  return results;
}

export const GET = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const ws = (await getActiveWorkspace(user.id)) ?? (await ensureDefaultWorkspace(user.id));
  const rootDir = ws.rootDir;
  const searchParams = req.nextUrl.searchParams;
  const action = searchParams.get("action");
  const docPath = searchParams.get("path");

  // 1. List all office documents in workspace
  if (action === "list") {
    const absFiles = await findOfficeFiles(rootDir);
    const docs: Array<{
      path: string;
      relPath: string;
      name: string;
      type: "presentation" | "document" | "pdf";
      size: number;
      updatedAt: number;
      manifest?: OfficeDocManifest | null;
    }> = [];

    for (const file of absFiles) {
      try {
        const stat = await fs.stat(file);
        const rel = path.relative(rootDir, file).replace(/\\/g, "/");
        const ext = path.extname(file).toLowerCase();
        const type = ext === ".pptx" ? "presentation" : ext === ".pdf" ? "pdf" : "document";
        const manifest = await readOfficeManifest(file);

        docs.push({
          path: rel,
          relPath: rel,
          name: path.basename(file),
          type,
          size: stat.size,
          updatedAt: manifest?.updatedAt || Math.round(stat.mtimeMs),
          manifest: manifest ?? undefined,
        });
      } catch {
        /* skip unreadable file */
      }
    }

    // Sort by most recently updated first
    docs.sort((a, b) => b.updatedAt - a.updatedAt);
    return ok({ ok: true, documents: docs });
  }

  // 2. Fetch specific document details / manifest
  if (!docPath) {
    return apiError("Missing document path parameter.", 400);
  }

  const abs = safePath(user.id, ws.name, docPath, ws.rootDir);
  if (!abs || !existsSync(abs)) {
    return apiError("Document not found.", 404);
  }

  const stat = await fs.stat(abs);
  const ext = path.extname(abs).toLowerCase();
  const type = ext === ".pptx" ? "presentation" : ext === ".pdf" ? "pdf" : "document";
  const manifest = await readOfficeManifest(abs);

  let fallbackText: string | undefined;
  if (!manifest) {
    const extracted = await extractOfficeText(abs);
    fallbackText = extracted.text;
  }

  return ok({
    ok: true,
    document: {
      path: docPath,
      name: path.basename(abs),
      type,
      size: stat.size,
      updatedAt: manifest?.updatedAt || Math.round(stat.mtimeMs),
      manifest: manifest ?? null,
      fallbackText,
    },
  });
});

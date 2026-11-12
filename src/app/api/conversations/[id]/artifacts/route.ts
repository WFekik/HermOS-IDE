import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import { existsSync, statSync } from "fs";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ARTIFACTS_DIR } from "@/lib/paths";
import { isSubpathOrEqual } from "@/lib/workspace";
import { withErrorHandler, notFound, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export interface ArtifactItemDTO {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
  conversationId: string;
  workspaceId: string | null;
}

/** Documented agent artifact filenames (written relative to the workspace root). */
const ARTIFACT_FILENAMES = new Set(["implementation_plan.md", "walkthrough.md", "task.md"]);

export const GET = withErrorHandler(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    const conv = await db.conversation.findUnique({
      where: { id },
      select: { id: true, userId: true, workspaceId: true },
    });
    if (!conv || conv.userId !== user.id) return notFound("Conversation not found");

    const artifacts: ArtifactItemDTO[] = [];
    const seenNames = new Set<string>();

    // 1. Files on disk under ARTIFACTS_DIR/<userId>/<conversationId>
    const convArtifactDir = path.join(ARTIFACTS_DIR, user.id, id);
    if (existsSync(convArtifactDir)) {
      try {
        const entries = await fs.readdir(convArtifactDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fullPath = path.join(convArtifactDir, entry.name);
          try {
            const st = statSync(fullPath);
            seenNames.add(entry.name.toLowerCase());
            artifacts.push({
              name: entry.name,
              path: fullPath,
              size: st.size,
              updatedAt: st.mtime.toISOString(),
              conversationId: id,
              workspaceId: conv.workspaceId,
            });
          } catch {
            // ignore unreadable file
          }
        }
      } catch {
        // ignore directory read errors
      }
    }

    // 2. Discover any additional artifacts recorded in messages/tool calls for this conversation
    try {
      const artifactUserDir = path.join(ARTIFACTS_DIR, user.id);
      const messages = await db.message.findMany({
        where: { conversationId: id },
        select: { toolCalls: true, createdAt: true },
      });
      for (const m of messages) {
        if (!m.toolCalls) continue;
        try {
          const calls = JSON.parse(m.toolCalls);
          if (!Array.isArray(calls)) continue;
          for (const tc of calls) {
            const isCreateArtifact = tc?.name === "create_artifact";
            const isWrite = tc?.name === "write_file" || tc?.name === "write_to_file";
            const p = (tc?.args?.path || tc?.args?.targetFile || tc?.result?.path || "") as string;
            const hasArtifactMeta = !!tc?.args?.ArtifactMetadata;
            const isArtifactResult = tc?.result?.isArtifact === true;
            // A write only counts as an artifact when it lands in the user's
            // artifact root, or one of the documented artifact filenames. A
            // loose substring match on "artifact" wrongly promoted workspace
            // docs (e.g. `docs/artifacts.md`) into the panel.
            const isArtifactPath = p
              ? path.isAbsolute(p)
                ? isSubpathOrEqual(path.resolve(p), path.resolve(artifactUserDir))
                : ARTIFACT_FILENAMES.has(path.basename(p).toLowerCase())
              : false;
            if (
              p &&
              (isCreateArtifact || hasArtifactMeta || isArtifactResult || (isWrite && isArtifactPath))
            ) {
              const base = path.basename(p);
              if (base && !seenNames.has(base.toLowerCase())) {
                seenNames.add(base.toLowerCase());
                let size = 0;
                let updatedAt = m.createdAt;
                if (path.isAbsolute(p) && existsSync(p)) {
                  try {
                    const st = statSync(p);
                    size = st.size;
                    updatedAt = st.mtime;
                  } catch {
                    /* unreadable — keep the message timestamp */
                  }
                }
                artifacts.push({
                  name: base,
                  path: p,
                  size,
                  updatedAt: updatedAt.toISOString(),
                  conversationId: id,
                  workspaceId: conv.workspaceId,
                });
              }
            }
          }
        } catch {
          // ignore malformed toolCall json
        }
      }
    } catch {
      // ignore db errors
    }

    // Sort newest first
    artifacts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return ok({ artifacts });
  },
);

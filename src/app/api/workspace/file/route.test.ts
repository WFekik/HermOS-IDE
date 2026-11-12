import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";

const DIRS = vi.hoisted(() => {
  const base = `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/hermos-ws-file-${process.pid}`;
  return {
    base,
    artifacts: `${base}/artifacts`,
    workspace: `${base}/workspace`,
    outside: `${base}/outside`,
  };
});

vi.mock("@/lib/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paths")>();
  return { ...actual, ARTIFACTS_DIR: DIRS.artifacts };
});

vi.mock("@/lib/session", () => ({
  requireUser: async () => ({ id: "user-1", email: "test@hermos.local" }),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: async () => null,
  RATE_LIMITS: { terminal: { capacity: 100, refillPerSec: 100 } },
}));

vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    getActiveWorkspace: async () => ({ name: "ws", rootDir: DIRS.workspace }),
    ensureDefaultWorkspace: async () => ({ name: "ws", rootDir: DIRS.workspace }),
    readFileWs: async () => {
      throw new Error("File not found.");
    },
  };
});

import { GET } from "./route";

const CONVERSATION_ID = "conv123";
const userId = "user-1";

function fileRequest(query: Record<string, string>): NextRequest {
  const url = new URL("http://127.0.0.1/api/workspace/file");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

let conversationArtifact: string;
let legacyArtifact: string;
let outsideSecret: string;

describe("GET /api/workspace/file — artifact confinement", () => {
  beforeAll(async () => {
    conversationArtifact = path.join(DIRS.artifacts, userId, CONVERSATION_ID, "diagram.png");
    legacyArtifact = path.join(DIRS.artifacts, userId, "legacy.md");
    outsideSecret = path.join(DIRS.outside, "secret.txt");
    await fs.mkdir(path.dirname(conversationArtifact), { recursive: true });
    await fs.mkdir(DIRS.workspace, { recursive: true });
    await fs.mkdir(DIRS.outside, { recursive: true });
    await fs.writeFile(conversationArtifact, Buffer.from([1, 2, 3]));
    await fs.writeFile(legacyArtifact, "# legacy artifact\n");
    await fs.writeFile(outsideSecret, "TOP SECRET\n");
  });

  afterAll(async () => {
    await fs.rm(DIRS.base, { recursive: true, force: true });
  });

  it("serves a raw artifact inside the requested conversation directory", async () => {
    const res = await GET(
      fileRequest({ path: conversationArtifact, raw: "true", conversationId: CONVERSATION_ID }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects a traversing conversationId instead of escaping the artifact root", async () => {
    for (const conversationId of ["../../../../..", "..\\..\\..\\..\\..", "conv/../../../..", ".."]) {
      for (const raw of ["true", "false"]) {
        const res = await GET(
          fileRequest({ path: outsideSecret, raw, conversationId }),
        );
        expect(res.status, `conversationId=${conversationId} raw=${raw}`).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Invalid conversation.");
        expect(JSON.stringify(body)).not.toContain("TOP SECRET");
      }
    }
  });

  it("does not read files outside the workspace and artifact roots for a valid conversation", async () => {
    const res = await GET(
      fileRequest({ path: outsideSecret, conversationId: CONVERSATION_ID }),
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("TOP SECRET");
  });

  it("falls back to the user artifact root for artifacts outside the conversation directory", async () => {
    const res = await GET(fileRequest({ path: legacyArtifact, conversationId: CONVERSATION_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# legacy artifact\n");
  });

  it("resolves a bare artifact filename without a conversation scope", async () => {
    const res = await GET(fileRequest({ path: "legacy.md" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# legacy artifact\n");
  });
});

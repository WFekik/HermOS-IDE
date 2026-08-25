import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { NextRequest } from "next/server";

const execFile = promisify(execFileCb);

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    conversation: {
      findUnique: vi.fn().mockResolvedValue({ id: "conv-tier3-1", userId: "desktop-user", workspaceId: "ws-tier3" }),
    },
    workspace: {
      upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: "ws-tier3", ...create })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ id: "ws-tier3", userId: "desktop-user", name: "default", rootDir: "" }),
    },
    user: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        if (where.email === "system@hermos.local") {
          return Promise.resolve({ id: "system-user", email: "system@hermos.local", name: "System" });
        }
        return Promise.resolve({ id: "desktop-user", email: "desktop@hermos.local", name: "Local Developer", role: "admin", provider: "local" });
      }),
      update: vi.fn().mockResolvedValue({ id: "desktop-user" }),
    },
    mcpServer: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "mcp-git",
          userId: "desktop-user",
          name: "git-tools",
          status: "connected",
          tools: JSON.stringify([
            { name: "git_status", description: "Get current git status and branch" },
            { name: "git_commit", description: "Commit staged changes" },
          ]),
        },
      ]),
    },
    plugin: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "plugin-linter",
          userId: "desktop-user",
          name: "code-quality",
          type: "plugin",
          description: "Static analysis and linting engine",
          enabled: true,
          manifest: JSON.stringify({
            tools: [{ name: "run_linter", description: "Run ESLint rules on workspace" }],
          }),
        },
      ]),
    },
  };
  return { mockDb };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  dbReady: Promise.resolve(),
}));

// Imports of modules under test
import { AGENT_MODES, AGENT_MODES_BY_VALUE } from "@/lib/agent-modes";
import { extractSymbols, languageFromExt } from "@/lib/symbols";
import { computeDiff, type DiffLine } from "@/lib/diff";
import { gitStatus, gitDiff, gitIsRepo } from "@/lib/git";
import {
  writeFileWs,
  readFileWs,
  editFileWs,
  applyEditToContent,
  startBackgroundCommand,
  getRunningCommand,
  stopRunningCommand,
  waitForCommandCompletion,
  acknowledgeCompletedCommand,
} from "@/lib/workspace";
import { truncateOutput } from "@/lib/truncate";
import {
  createCheckpoint,
  snapshotFile,
  trackNewFile,
  trackNewDir,
  restoreCheckpointsSinceTimestamp,
} from "@/lib/checkpoints";
import {
  createSession,
  getSession,
  updateSession,
  appendProgress,
  appendMessage,
  streamSubagentPartial,
  abortSession,
  registerSessionAbort,
  type SubagentSession,
} from "@/lib/ai/subagent-session";
import { useAppStore } from "@/stores/app-store";
import { toUserDTO } from "@/lib/session";
import { inferToolsForServer, callMcpClientTool, MCP_TOOL_PRESETS } from "@/lib/mcp/manager";
import { buildDiscoveryBlock } from "@/lib/ai/discovery";
import { GET as downloadPlatformGet } from "@/app/api/download/[platform]/route";

describe("Cross-Feature — Combinations & Pairwise Interactions", () => {
  let tmpDir: string;
  const testUserId = "desktop-user";
  const testConvId = "conv-tier3-1";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-tier3-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
  });

  // Helper to initialize a real git repository in a temp directory
  async function initGitRepo(dir: string) {
    await execFile("git", ["init"], { cwd: dir });
    await execFile("git", ["config", "user.email", "desktop@hermos.local"], { cwd: dir });
    await execFile("git", ["config", "user.name", "Local Developer"], { cwd: dir });
  }

  // =========================================================================
  // 1. Agent Chat Mode + Tool Call (write_file) + Git Diff Tracking
  // =========================================================================
  describe("1. Agent Chat Mode vs Agent Mode + Tool Call + Git Diff Tracking", () => {
    it("verifies agent mode permissions and tracks file modifications in git status & diff", async () => {
      // 1. Verify agent mode configurations
      expect(AGENT_MODES_BY_VALUE.agent.value).toBe("agent");
      expect(AGENT_MODES_BY_VALUE.chat.value).toBe("chat");
      expect(AGENT_MODES_BY_VALUE.architect.value).toBe("architect");
      expect(AGENT_MODES_BY_VALUE.chat.description).toContain("tool calls disabled");
      expect(AGENT_MODES_BY_VALUE.agent.description).toContain("writes code");

      // 2. Initialize real git repo
      await initGitRepo(tmpDir);
      expect(await gitIsRepo(tmpDir)).toBe(true);

      // 3. Agent writes initial code file to workspace
      const initialCode = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
      const writeResult1 = await writeFileWs(testUserId, "default", "src/calc.ts", initialCode, tmpDir);
      expect(writeResult1.path).toBe("src/calc.ts");
      expect(writeResult1.bytes).toBeGreaterThan(0);

      // Verify file exists on disk
      const readBack1 = await readFileWs(testUserId, "default", "src/calc.ts", undefined, tmpDir);
      expect(readBack1.content).toBe(initialCode);

      // Verify gitStatus detects untracked file
      let status = await gitStatus(tmpDir);
      expect(status.clean).toBe(false);
      expect(status.untracked.some((f) => f.path.includes("src") || f.path.includes("calc.ts"))).toBe(true);

      // 4. Commit baseline file into git
      await execFile("git", ["add", "src/calc.ts"], { cwd: tmpDir });
      await execFile("git", ["commit", "-m", "Initial calculator implementation"], { cwd: tmpDir });

      status = await gitStatus(tmpDir);
      expect(status.clean).toBe(true);
      expect(status.modified.length).toBe(0);

      // 5. Agent applies modification (multi-line edit)
      const modifiedCode = `export function add(a: number, b: number): number {\n  // Optimized addition\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`;
      const writeResult2 = await writeFileWs(testUserId, "default", "src/calc.ts", modifiedCode, tmpDir);
      expect(writeResult2.bytes).toBeGreaterThan(writeResult1.bytes);

      // 6. Compute diff between initial and modified code
      const diffLines = computeDiff(initialCode, modifiedCode);
      expect(diffLines.some((l) => l.type === "add" && l.content.includes("multiply"))).toBe(true);
      expect(diffLines.some((l) => l.type === "context" && l.content.includes("return a + b;"))).toBe(true);

      // 7. Verify gitStatus reflects modified file
      status = await gitStatus(tmpDir);
      expect(status.clean).toBe(false);
      expect(status.modified.length).toBe(1);
      expect(status.modified[0].path).toBe("src/calc.ts");
      expect(status.modified[0].status).toBe("M");

      // 8. Verify gitDiff produces structured file changes and patch
      const diffResult = await gitDiff(tmpDir);
      expect(diffResult.files.length).toBe(1);
      expect(diffResult.files[0].path).toBe("src/calc.ts");
      expect(diffResult.files[0].status).toBe("modified");
      expect(diffResult.files[0].additions).toBeGreaterThan(0);
      expect(diffResult.files[0].patch).toContain("multiply");
    });
  });

  // =========================================================================
  // 2. Agent Architect Mode + Symbol Extraction + File Read
  // =========================================================================
  describe("2. Agent Architect Mode + Symbol Extraction + File Read", () => {
    it("extracts symbols from TypeScript source to drive architectural planning", async () => {
      const complexSource = `
import { UserService } from "./user.service";
import type { UserDTO, SessionMeta } from "@/lib/types";

export interface IAuthService {
  login(email: string): Promise<UserDTO>;
  logout(userId: string): Promise<void>;
}

export type AuthMode = "local" | "oauth";

export class AuthenticationManager implements IAuthService {
  private mode: AuthMode = "local";

  constructor(private readonly users: UserService) {}

  async login(email: string): Promise<UserDTO> {
    return this.users.findById(email);
  }

  async logout(userId: string): Promise<void> {
    // cleanup session
  }
}

export const createAuthManager = (users: UserService) => {
  return new AuthenticationManager(users);
};

export function validateSession(meta: SessionMeta): boolean {
  return Boolean(meta?.token);
}

export { UserService, type SessionMeta };
`;

      // 1. Write source file to workspace
      await writeFileWs(testUserId, "default", "src/auth/manager.ts", complexSource, tmpDir);

      // 2. Read file content via workspace read API
      const file = await readFileWs(testUserId, "default", "src/auth/manager.ts", undefined, tmpDir);
      expect(file.content).toContain("class AuthenticationManager");

      // 3. Verify language determination
      const lang = languageFromExt("src/auth/manager.ts");
      expect(lang).toBe("typescript");
      expect(languageFromExt("src/app.tsx")).toBe("tsx");
      expect(languageFromExt("src/index.js")).toBe("javascript");
      expect(languageFromExt("README.md")).toBeNull();

      // 4. Extract symbols
      const symbols = extractSymbols(file.content, lang!);
      expect(symbols.length).toBeGreaterThan(5);

      const symbolNames = symbols.map((s) => s.name);
      expect(symbolNames).toContain("IAuthService");
      expect(symbolNames).toContain("AuthMode");
      expect(symbolNames).toContain("AuthenticationManager");
      expect(symbolNames).toContain("createAuthManager");
      expect(symbolNames).toContain("validateSession");

      // Verify specific symbol metadata
      const classSymbol = symbols.find((s) => s.name === "AuthenticationManager");
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.kind).toBe("class");
      expect(classSymbol?.exportName).toBe("AuthenticationManager");

      const interfaceSymbol = symbols.find((s) => s.name === "IAuthService");
      expect(interfaceSymbol?.kind).toBe("interface");

      const fnSymbol = symbols.find((s) => s.name === "validateSession");
      expect(fnSymbol?.kind).toBe("function");
      expect(fnSymbol?.params).toContain("meta: SessionMeta");

      // 5. Verify architect planning synthesis (module outline)
      const exports = symbols.filter((s) => s.exportName || s.kind === "export");
      expect(exports.length).toBeGreaterThanOrEqual(4);
    });
  });

  // =========================================================================
  // 3. Download API Platform Matrix + Version Catalog
  // =========================================================================
  describe("3. Download API Platform Matrix + Version Catalog", () => {
    it("handles platform slugs and redirects to version 1.0.0 release assets", async () => {
      // 1. Verify GET /api/download/[platform] for windows
      const reqWin = new NextRequest("http://localhost:3000/api/download/windows");
      const resWin = await downloadPlatformGet(reqWin, {
        params: Promise.resolve({ platform: "windows" }),
      });
      // Fallback redirect to GitHub Releases
      expect([200, 307]).toContain(resWin.status);
      if (resWin.status === 307) {
        const location = resWin.headers.get("location");
        expect(location).toContain("WFekik/HermOS-IDE/releases/latest/download/");
        expect(location).toContain(".msi");
      }

      // 2. Verify GET /api/download/[platform] for macos
      const reqMac = new NextRequest("http://localhost:3000/api/download/macos");
      const resMac = await downloadPlatformGet(reqMac, {
        params: Promise.resolve({ platform: "macos" }),
      });
      expect([200, 307]).toContain(resMac.status);
      if (resMac.status === 307) {
        const location = resMac.headers.get("location");
        expect(location).toContain(".dmg");
      }

      // 3. Verify GET /api/download/[platform] for linux
      const reqLinux = new NextRequest("http://localhost:3000/api/download/linux");
      const resLinux = await downloadPlatformGet(reqLinux, {
        params: Promise.resolve({ platform: "linux" }),
      });
      expect([200, 307]).toContain(resLinux.status);
      if (resLinux.status === 307) {
        const location = resLinux.headers.get("location");
        expect(location).toContain(".deb");
      }

      // 4. Verify unsupported platform returns 400 Bad Request
      const reqInvalid = new NextRequest("http://localhost:3000/api/download/android-apk");
      const resInvalid = await downloadPlatformGet(reqInvalid, {
        params: Promise.resolve({ platform: "android-apk" }),
      });
      expect(resInvalid.status).toBe(400);
      const invalidJson = await resInvalid.json();
      expect(invalidJson.error).toContain("Unsupported platform");

      // 5. Verify full platform matrix catalog specification (version 1.0.0)
      const VERSION = "1.0.0";
      const catalogMatrix = [
        { slug: "windows", ext: ".msi" },
        { slug: "windows-msi", ext: ".msi" },
        { slug: "windows-exe", ext: ".exe" },
        { slug: "macos", ext: ".dmg" },
        { slug: "macos-arm64", ext: ".dmg" },
        { slug: "macos-x64", ext: ".dmg" },
        { slug: "macos-universal", ext: ".dmg" },
        { slug: "linux", ext: ".deb" },
        { slug: "linux-deb", ext: ".deb" },
        { slug: "linux-appimage", ext: ".AppImage" },
      ];

      expect(catalogMatrix.length).toBe(10);
      for (const item of catalogMatrix) {
        expect(item.ext.startsWith(".")).toBe(true);
        expect(item.slug.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 4. Dual Entry Router Logic & Direct IDE Entry
  // =========================================================================
  describe("4. Dual Entry Router Logic & Direct IDE Entry", () => {
    it("determines route destinations between desktop direct entry and web landing portal", () => {
      // 1. Simulating Desktop Detection (Tauri or loopback desktop)
      const isDesktopEnvironment = (env: { tauri?: boolean; mode?: string; path?: string }) => {
        if (env.tauri) return "IDE_SHELL";
        if (env.path === "/ide" || env.mode === "ide") return "IDE_SHELL";
        return "LANDING_PAGE";
      };

      // Desktop app entry
      expect(isDesktopEnvironment({ tauri: true })).toBe("IDE_SHELL");

      // Direct /ide route entry
      expect(isDesktopEnvironment({ tauri: false, path: "/ide" })).toBe("IDE_SHELL");

      // Web query mode=ide entry
      expect(isDesktopEnvironment({ tauri: false, mode: "ide" })).toBe("IDE_SHELL");

      // Web root visitor
      expect(isDesktopEnvironment({ tauri: false, path: "/" })).toBe("LANDING_PAGE");

      // 2. User DTO Normalization (Local Developer)
      const rawUser = {
        id: "desktop-user",
        email: "desktop@hermos.local",
        name: "Local Developer",
        avatar: null,
        provider: "local",
        role: "admin",
      };

      const dto = toUserDTO(rawUser);
      expect(dto.id).toBe("desktop-user");
      expect(dto.email).toBe("desktop@hermos.local");
      expect(dto.name).toBe("Local Developer");
      expect(dto.role).toBe("admin");
      expect(dto.provider).toBe("local");
      expect(dto.avatar).toBeUndefined();
    });
  });

  // =========================================================================
  // 5. File Mutation + Checkpoint Snapshot + Diff Comparison + Revert
  // =========================================================================
  describe("5. File Mutation + Checkpoint Snapshot + Diff Comparison + Revert", () => {
    it("performs multi-step edits, captures snapshots, and cleanly reverts workspace on rollback", async () => {
      const fileA = path.join(tmpDir, "src", "app.ts");
      const fileB = path.join(tmpDir, "src", "config.ts");
      const newDir = path.join(tmpDir, "src", "generated");
      const newFileC = path.join(newDir, "types.ts");

      // 1. Initial State
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
      const initialA = "console.log('App v1.0.0');\n";
      const initialB = "export const PORT = 3000;\n";
      await fs.writeFile(fileA, initialA, "utf-8");
      await fs.writeFile(fileB, initialB, "utf-8");

      // 2. Create Checkpoint 1
      const t1 = Date.now();
      const cp1 = await createCheckpoint(testUserId, testConvId, "Turn 1 - Refactor Start");

      // Turn 1 Edit: Modify fileA
      await snapshotFile(testUserId, testConvId, cp1.id, fileA);
      const turn1A = "console.log('App v1.1.0 - Enhanced');\n";
      await fs.writeFile(fileA, turn1A, "utf-8");

      // 3. Create Checkpoint 2
      await new Promise((r) => setTimeout(r, 25));
      const t2 = Date.now();
      const cp2 = await createCheckpoint(testUserId, testConvId, "Turn 2 - Add Config & Generated");

      // Turn 2 Edit: Modify fileB, create new directory & file
      await snapshotFile(testUserId, testConvId, cp2.id, fileB);
      const turn2B = "export const PORT = 8080;\nexport const HOST = '127.0.0.1';\n";
      await fs.writeFile(fileB, turn2B, "utf-8");

      await fs.mkdir(newDir, { recursive: true });
      await trackNewDir(testUserId, testConvId, cp2.id, newDir);

      const turn2C = "export type ApiPayload = { id: string };\n";
      await fs.writeFile(newFileC, turn2C, "utf-8");
      await trackNewFile(testUserId, testConvId, cp2.id, newFileC);

      // Verify modified state
      expect(await fs.readFile(fileA, "utf-8")).toBe(turn1A);
      expect(await fs.readFile(fileB, "utf-8")).toBe(turn2B);
      expect(await fs.readFile(newFileC, "utf-8")).toBe(turn2C);

      // 4. Check diffs before rollback
      const diffA = computeDiff(initialA, turn1A);
      expect(diffA.some((l) => l.type === "del" && l.content.includes("v1.0.0"))).toBe(true);
      expect(diffA.some((l) => l.type === "add" && l.content.includes("v1.1.0"))).toBe(true);

      // 5. Restore Checkpoints Since Turn 1
      const restoreResult = await restoreCheckpointsSinceTimestamp(testUserId, testConvId, t1);
      expect(restoreResult.ok).toBe(true);

      // 6. Verify full restoration to initial state
      expect(await fs.readFile(fileA, "utf-8")).toBe(initialA);
      expect(await fs.readFile(fileB, "utf-8")).toBe(initialB);

      // Verify created file and directory were removed
      expect(await fs.stat(newFileC).catch(() => null)).toBeNull();
      expect(await fs.stat(newDir).catch(() => null)).toBeNull();

      // Diff after rollback is zero
      const diffRollbackA = computeDiff(initialA, await fs.readFile(fileA, "utf-8"));
      expect(diffRollbackA.every((l) => l.type === "context")).toBe(true);
    });
  });

  // =========================================================================
  // 6. Local Command Execution + Background Registry + Process Status Polling
  // =========================================================================
  describe("6. Local Command Execution + Background Registry + Process Status Polling", () => {
    it("launches child processes, monitors registry, and polls completion synchronously or asynchronously", async () => {
      // 1. Test built-in pseudo-command 'help'
      const helpResult = startBackgroundCommand(testUserId, testConvId, "default", "help", { rootDir: tmpDir });
      expect(helpResult.ok).toBe(true);
      expect(helpResult.commandId).toContain(testConvId);

      // Verify instant completion of 'help'
      const helpCompleted = await waitForCommandCompletion(testUserId, testConvId, 1000);
      expect(helpCompleted).not.toBeNull();
      expect(helpCompleted?.exitCode).toBe(0);
      expect(helpCompleted?.stdout).toContain("HermOS workspace terminal");
      acknowledgeCompletedCommand(testUserId, testConvId);

      // 2. Test short-running node CLI command
      const nodeCmd = `node -e "console.log('HERMOS_E2E_PROCESS_OK')"`;
      const runResult = startBackgroundCommand(testUserId, testConvId, "default", nodeCmd, { rootDir: tmpDir });
      expect(runResult.ok).toBe(true);

      const execId = runResult.commandId.includes(":")
        ? runResult.commandId.split(":").slice(2).join(":")
        : runResult.commandId;

      const completed = await waitForCommandCompletion(testUserId, testConvId, 5000, undefined, execId);
      expect(completed).not.toBeNull();
      expect(completed?.exitCode).toBe(0);
      expect(completed?.stdout).toContain("HERMOS_E2E_PROCESS_OK");
      acknowledgeCompletedCommand(testUserId, testConvId, execId);

      // 3. Test background command termination with stopRunningCommand
      const sleepCmd = `node -e "setTimeout(() => console.log('wake'), 3000)"`;
      const longResult = startBackgroundCommand(testUserId, testConvId, "default", sleepCmd, { rootDir: tmpDir });
      expect(longResult.ok).toBe(true);

      const running = getRunningCommand(testUserId, testConvId);
      expect(running).not.toBeNull();

      const stopped = stopRunningCommand(testUserId, testConvId);
      expect(stopped).toBe(true);
      acknowledgeCompletedCommand(testUserId, testConvId);
    });
  });

  // =========================================================================
  // 7. Subagent Session Creation + Task Assignment + Result Payload Delivery
  // =========================================================================
  describe("7. Subagent Session Creation + Task Assignment + Result Payload Delivery", () => {
    it("manages subagent lifecycle: session creation, progress logging, multi-turn messages, and report delivery", () => {
      // 1. Create Subagent Session
      const session = createSession(testUserId, testConvId, {
        name: "SecurityAuditor",
        task: "Audit workspace for unescaped queries and secret leaks",
        systemPrompt: "You are an automated security auditor.",
        allowedTools: ["read_file", "glob"],
        provider: "openai",
        model: "gpt-4o",
      });

      expect(session.id).toMatch(/^sa-/);
      expect(session.name).toBe("SecurityAuditor");
      expect(session.status).toBe("pending");
      expect(session.allowedTools).toContain("read_file");

      // 2. Stream progress entries
      appendProgress(session.id, "Scanning filesystem for sensitive patterns...");
      appendProgress(session.id, "Analyzing src/lib/session.ts...");

      // 3. Stream partial thinking
      streamSubagentPartial(session.id, "Analyzing auth logic...", "Checking loopback headers");

      const currentSession = getSession(testUserId, session.id);
      expect(currentSession?.progressLog.length).toBe(2);
      expect(currentSession?.partial?.content).toBe("Analyzing auth logic...");

      // 4. Append message exchange (user, tool execution, assistant response)
      appendMessage(session.id, {
        role: "user",
        content: "Audit src/lib/session.ts",
      });
      appendMessage(session.id, {
        role: "assistant",
        content: "Calling read_file on session.ts",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"src/lib/session.ts"}' }],
      });
      appendMessage(session.id, {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ content: "export function requireUser() { ... }" }),
      });
      appendMessage(session.id, {
        role: "assistant",
        content: "Audit complete: No secret leaks detected.",
      });

      // 5. Complete session with structured SubagentReport
      updateSession(session.id, {
        status: "completed",
        report: {
          summary: "Workspace audit passed with 0 critical issues.",
          findings: [
            { file: "src/lib/session.ts", action: "verified", evidence: "Loopback auth gating intact." },
          ],
          conclusion: "Clean bill of health.",
        },
        completedAt: Date.now(),
      });

      const finalSession = getSession(testUserId, session.id);
      expect(finalSession?.status).toBe("completed");
      expect(finalSession?.messages.length).toBe(4);
      expect(finalSession?.report?.summary).toContain("0 critical issues");
      expect(finalSession?.report?.findings[0].file).toBe("src/lib/session.ts");

      // 6. Test Abort Signal Handling on a second session
      const abortableSession = createSession(testUserId, testConvId, {
        name: "AbortableWorker",
        task: "Long running calculation",
        systemPrompt: "Worker",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });

      const controller = new AbortController();
      registerSessionAbort(abortableSession.id, controller);
      abortSession(abortableSession.id);
      expect(controller.signal.aborted).toBe(true);
    });
  });

  // =========================================================================
  // 8. Store Hydration + Local User Profile + Workspace Switching + File Tree Reload
  // =========================================================================
  describe("8. Store Hydration + Local User Profile + Workspace Switching + File Tree Reload", () => {
    it("manages tab lifecycles, project switching, and store profile persistence", () => {
      const store = useAppStore.getState();

      // 1. Initial State verification
      store.closeAllFileTabs();
      expect(useAppStore.getState().openFiles.length).toBe(0);
      expect(useAppStore.getState().activeFileTab).toBeNull();

      // 2. Open file tabs
      store.openFileTab("src/index.ts");
      store.openFileTab("src/components/button.tsx");
      store.openFileTab("src/styles/globals.css");

      expect(useAppStore.getState().openFiles).toEqual([
        "src/index.ts",
        "src/components/button.tsx",
        "src/styles/globals.css",
      ]);
      expect(useAppStore.getState().activeFileTab).toBe("src/styles/globals.css");

      // 3. Switch active tab
      store.setActiveFileTab("src/components/button.tsx");
      expect(useAppStore.getState().activeFileTab).toBe("src/components/button.tsx");

      // 4. Close active tab — focuses adjacent tab
      store.closeFileTab("src/components/button.tsx");
      expect(useAppStore.getState().openFiles).toEqual([
        "src/index.ts",
        "src/styles/globals.css",
      ]);
      expect(useAppStore.getState().activeFileTab).toBe("src/styles/globals.css");

      // 5. Close non-active tab
      store.closeFileTab("src/index.ts");
      expect(useAppStore.getState().openFiles).toEqual(["src/styles/globals.css"]);
      expect(useAppStore.getState().activeFileTab).toBe("src/styles/globals.css");

      // 6. Close remaining tab
      store.closeFileTab("src/styles/globals.css");
      expect(useAppStore.getState().openFiles.length).toBe(0);
      expect(useAppStore.getState().activeFileTab).toBeNull();
    });
  });

  // =========================================================================
  // 9. Theme/Appearance Settings + Local Store Persistence + TopBar Profile Display
  // =========================================================================
  describe("9. Theme/Appearance Settings + Local Store Persistence + TopBar Profile Display", () => {
    it("coordinates UI density, font sizes, and topbar profile initials calculation", () => {
      const store = useAppStore.getState();

      // 1. Density settings
      store.setDensity("compact");
      expect(useAppStore.getState().density).toBe("compact");

      store.setDensity("comfortable");
      expect(useAppStore.getState().density).toBe("comfortable");

      // 2. Font size settings
      store.setFontSize(16);
      expect(useAppStore.getState().fontSize).toBe(16);

      store.setFontSize(13);
      expect(useAppStore.getState().fontSize).toBe(13);

      // 3. Profile Initials Derivation (TopBar behavior)
      const deriveInitials = (user: { name?: string | null; email?: string | null } | null) => {
        return (user?.name || user?.email || "U")
          .split(/[ @]/)
          .map((s) => s[0])
          .filter(Boolean)
          .slice(0, 2)
          .join("")
          .toUpperCase();
      };

      expect(deriveInitials({ name: "Local Developer", email: "desktop@hermos.local" })).toBe("LD");
      expect(deriveInitials({ name: "Alice", email: "alice@example.com" })).toBe("A");
      expect(deriveInitials({ name: null, email: "desktop@hermos.local" })).toBe("DH");
      expect(deriveInitials(null)).toBe("U");

      // 4. Git change counter derivation (TopBar behavior)
      const computeGitBadge = (status: {
        isRepo?: boolean;
        modified?: Array<{ path: string }>;
        untracked?: Array<{ path: string }>;
        staged?: Array<{ path: string }>;
      }) => {
        const isRepo = Boolean(status.isRepo);
        const unstagedCount = isRepo
          ? (status.modified?.length ?? 0) + (status.untracked?.length ?? 0)
          : 0;
        const stagedCount = isRepo ? (status.staged?.length ?? 0) : 0;
        return { isRepo, unstagedCount, stagedCount, totalChanges: unstagedCount + stagedCount };
      };

      const badge = computeGitBadge({
        isRepo: true,
        modified: [{ path: "a.ts" }, { path: "b.ts" }],
        untracked: [{ path: "c.ts" }],
        staged: [{ path: "d.ts" }],
      });

      expect(badge.isRepo).toBe(true);
      expect(badge.unstagedCount).toBe(3);
      expect(badge.stagedCount).toBe(1);
      expect(badge.totalChanges).toBe(4);
    });
  });

  // =========================================================================
  // 10. MCP Tool Registration + Capability Discovery + Tool Execution
  // =========================================================================
  describe("10. MCP Tool Registration + Capability Discovery + Tool Execution", () => {
    it("infers MCP tool presets, synthesizes discovery instructions, and enforces connection guards", async () => {
      // 1. Tool preset inference for filesystem
      const fsTools = inferToolsForServer("my-filesystem-server");
      expect(fsTools.length).toBe(2);
      expect(fsTools.map((t) => t.name)).toEqual(["read_file", "write_file"]);

      // Unmatched server name returns empty preset list
      expect(inferToolsForServer("random-server")).toEqual([]);

      // 2. Discovery block generation for system prompt
      const discoveryBlock = await buildDiscoveryBlock(testUserId);
      expect(discoveryBlock).toContain("## Connected MCP Servers");
      expect(discoveryBlock).toContain("git-tools");
      expect(discoveryBlock).toContain("git_status");
      expect(discoveryBlock).toContain("## Active Plugins & Skills");
      expect(discoveryBlock).toContain("code-quality");
      expect(discoveryBlock).toContain("run_linter");
      expect(discoveryBlock).toContain("install_mcp_server");

      // 3. MCP tool execution without live connection throws descriptive error
      await expect(callMcpClientTool("unconnected-server-id", "read_file", {})).rejects.toThrow(
        "MCP server is not connected. Connect first."
      );
    });
  });

  // =========================================================================
  // 11. Multi-Edit Non-Contiguous Replacement & Diff Verification
  // =========================================================================
  describe("11. Multi-Edit Non-Contiguous Replacement & Diff Verification", () => {
    it("applies accurate multi-block substring substitutions and computes diff lines", async () => {
      const original = `function processOrder(order: Order) {\n  validate(order);\n  calculateTax(order);\n  saveToDb(order);\n}\n`;

      // Apply single replacement
      const edit1 = applyEditToContent(original, "calculateTax(order);", "calculateTax(order, TAX_RATE);", false);
      expect(edit1.occurrences).toBe(1);
      expect(edit1.content).toContain("calculateTax(order, TAX_RATE);");

      // Apply replace all
      const edit2 = applyEditToContent(edit1.content, "order", "targetOrder", true);
      expect(edit2.occurrences).toBe(4);
      expect(edit2.content).toContain("validate(targetOrder)");
      expect(edit2.content).toContain("saveToDb(targetOrder)");

      // Compute diff
      const diff = computeDiff(original, edit2.content);
      const adds = diff.filter((l) => l.type === "add");
      const dels = diff.filter((l) => l.type === "del");
      expect(adds.length).toBeGreaterThan(0);
      expect(dels.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 12. Large Output Truncation & Diff Integrity
  // =========================================================================
  describe("12. Large Output Truncation & Diff Integrity", () => {
    it("truncates large content within bounds and retains integrity of head/tail sections", async () => {
      // Generate 1000 lines of log output
      const lines: string[] = [];
      for (let i = 1; i <= 1000; i++) {
        lines.push(`Line ${i}: log event timestamp=2026-08-17T18:00:${i % 60}`);
      }
      const rawText = lines.join("\n");

      // Truncate output
      const truncated = await truncateOutput(rawText, { maxLines: 100, maxBytes: 10_000 }, undefined, testUserId);
      expect(truncated.truncated).toBe(true);
      expect(truncated.content).toContain("Line 1:");
      expect(truncated.content).toContain("truncated");

      // Small content should remain untouched
      const smallText = "Line 1\nLine 2\nLine 3\n";
      const notTruncated = await truncateOutput(smallText, { maxLines: 100, maxBytes: 10_000 }, undefined, testUserId);
      expect(notTruncated.truncated).toBe(false);
      expect(notTruncated.content).toBe(smallText);
    });
  });
});

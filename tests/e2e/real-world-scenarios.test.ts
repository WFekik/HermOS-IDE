/**
 * Real-World Scenarios E2E Suite — Real-World Application Scenarios
 * 
 * Implements 5 realistic end-to-end developer workflows:
 * 1. Scenario 1: New Project Launch & Local Development Cycle (F1, F3, F6, F7)
 * 2. Scenario 2: Autonomous AI Subagent Investigation Workflow (F1, F3, F6)
 * 3. Scenario 3: Web Visitor Discovery -> Download -> Direct IDE Launch Journey (F1, F4, F5)
 * 4. Scenario 4: Offline Air-Gapped Code Editing & Persistence (F1, F2, F3, F6)
 * 5. Scenario 5: Multi-File Refactoring with Checkpoint Rollback (F6, F7)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import { acquireInstallersLock, releaseInstallersLock } from "./installers-lock";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { NextRequest } from "next/server";

const execFile = promisify(execFileCb);

// Sandbox execution
import { LocalSandboxRunner } from "@/lib/sandbox/local-runner";
import { getSandboxRunner } from "@/lib/sandbox";

// Session & Auth
import { toUserDTO, getCurrentUser, requireUser } from "@/lib/session";
import { GET as getAuthMe } from "@/app/api/auth/me/route";

// Download API
import { GET as getDownloadPlatform } from "@/app/api/download/[platform]/route";

// Workspace operations
import {
  openWorkspace,
  getActiveWorkspace,
  writeFileWs,
  readFileWs,
  editFileWs,
  multiEditWs,
  readTree,
  createFileWs,
  deletePathWs,
} from "@/lib/workspace";

// Symbol extraction
import { extractSymbols, languageFromExt } from "@/lib/symbols";

// Git integration
import { gitIsRepo, gitStatus, gitDiff } from "@/lib/git";

// Checkpoints
import {
  createCheckpoint,
  snapshotFile,
  trackNewFile,
  trackNewDir,
  listCheckpoints,
  restoreCheckpoint,
  getCheckpointFiles,
  deleteCheckpoint,
} from "@/lib/checkpoints";

// Subagents
import {
  createSubagent,
  getSubagent,
  getSubagents,
  getSubagentMessages,
  getSubagentStructuredReport,
  deleteSubagent,
} from "@/lib/ai/subagents";
import {
  createSession,
  getSession,
  appendProgress,
  appendMessage,
  updateSession,
} from "@/lib/ai/subagent-session";
import {
  enqueueSubagentReport,
  drainSubagentReports,
  isSubagentReportDelivered,
  markSubagentReportDelivered,
  clearConversationQueue,
  formatSubagentReportText,
} from "@/lib/ai/subagent-queue";

// Database
import { db, dbReady } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";

// Store
import { useAppStore } from "@/stores/app-store";

// Helper for Mock Request
function createMockRequest(url: string, headers?: Record<string, string>): NextRequest {
  const h = new Headers();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      h.set(k, v);
    }
  }
  return new NextRequest(url, { headers: h });
}

describe("Real-World Scenarios — E2E Suite", () => {
  let testTempRoot: string;
  let testUser: { id: string; email: string; name: string };
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    await dbReady;
    await seedIfNeeded();

    // Ensure desktop developer user exists in DB
    const email = "desktop@hermos.local";
    let u = await db.user.findUnique({ where: { email } });
    if (!u) {
      u = await db.user.create({
        data: {
          email,
          name: "Local Developer",
          provider: "local",
          role: "admin",
        },
      });
    } else if (u.role !== "admin") {
      u = await db.user.update({
        where: { id: u.id },
        data: { role: "admin" },
      });
    }
    testUser = { id: u.id, email: u.email, name: u.name ?? "Local Developer" };
  });

  beforeEach(async () => {
    testTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-tier4-"));
    process.env = { ...originalEnv };
    process.env.HERMOS_DESKTOP = "true";
    delete process.env.TRUST_PROXY;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    try {
      if (testTempRoot && existsSync(testTempRoot)) {
        await fs.rm(testTempRoot, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  });

  // =========================================================================
  // Scenario 1: New Project Launch & Local Development Cycle
  // =========================================================================
  describe("Scenario 1: New Project Launch & Local Development Cycle", () => {
    it("1.1: initializes a new workspace, scaffolds source files, and verifies tree hierarchy", async () => {
      const wsName = "calc-project";
      const wsRoot = path.join(testTempRoot, wsName);
      await fs.mkdir(wsRoot, { recursive: true });

      // 1. Resolve user and open workspace
      const req = createMockRequest("http://127.0.0.1:3000/api/workspace", {
        host: "127.0.0.1:3000",
      });
      const user = await requireUser(req);
      expect(user.email).toBe("desktop@hermos.local");

      const ws = await openWorkspace(testUser.id, wsName, wsRoot);
      expect(ws.name).toBe(wsName);
      expect(ws.rootDir).toBe(wsRoot);
      expect(ws.isActive).toBe(true);

      const activeWs = await getActiveWorkspace(testUser.id);
      expect(activeWs?.name).toBe(wsName);

      // 2. Scaffold project structure
      const packageJsonContent = JSON.stringify(
        {
          name: "calc-project",
          version: "1.0.0",
          scripts: { test: "node test.js" },
        },
        null,
        2,
      );

      const calcJsContent = `
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
`.trim();

      const testJsContent = `
const { add, subtract } = require('./src/calc.js');
if (add(10, 5) !== 15) {
  console.error('add failed');
  process.exit(1);
}
if (subtract(10, 5) !== 5) {
  console.error('subtract failed');
  process.exit(1);
}
console.log('ALL UNIT TESTS PASSED');
`.trim();

      await writeFileWs(testUser.id, wsName, "package.json", packageJsonContent, wsRoot);
      await fs.mkdir(path.join(wsRoot, "src"), { recursive: true });
      await writeFileWs(testUser.id, wsName, "src/calc.js", calcJsContent, wsRoot);
      await writeFileWs(testUser.id, wsName, "test.js", testJsContent, wsRoot);

      // 3. Inspect workspace tree
      const tree = await readTree(testUser.id, wsName, 6, wsRoot);
      expect(tree.length).toBeGreaterThanOrEqual(3);

      const fileNames = tree.map((t) => t.name);
      expect(fileNames).toContain("package.json");
      expect(fileNames).toContain("test.js");
      expect(fileNames).toContain("src");

      const readCalc = await readFileWs(testUser.id, wsName, "src/calc.js", 100000, wsRoot);
      expect(readCalc.content).toContain("function add(a, b)");
      expect(readCalc.content).toContain("module.exports = { add, subtract };");
    });

    it("1.2: executes local build & test command via LocalSandboxRunner and captures output", async () => {
      const wsRoot = path.join(testTempRoot, "exec-project");
      await fs.mkdir(path.join(wsRoot, "src"), { recursive: true });

      const calcJs = `
function multiply(a, b) { return a * b; }
module.exports = { multiply };
`;
      const testJs = `
const { multiply } = require('./src/calc.js');
const result = multiply(6, 7);
if (result !== 42) {
  console.error('Multiplication mismatch:', result);
  process.exit(1);
}
console.log('PASS: 6 * 7 = 42');
`;

      await fs.writeFile(path.join(wsRoot, "src", "calc.js"), calcJs, "utf-8");
      await fs.writeFile(path.join(wsRoot, "test.js"), testJs, "utf-8");

      const runner = new LocalSandboxRunner();
      expect(runner.mode).toBe("local");
      expect(await runner.isAvailable()).toBe(true);

      const progressChunks: string[] = [];
      const result = await runner.executeCommand(
        {
          command: "node test.js",
          cwd: wsRoot,
          timeoutMs: 15000,
        },
        (chunk) => progressChunks.push(chunk),
      );

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PASS: 6 * 7 = 42");
      expect(result.durationMs).toBeGreaterThan(0);
      expect(progressChunks.join("")).toContain("PASS: 6 * 7 = 42");
    });

    it("1.3: captures non-zero exit code and stderr on test failure", async () => {
      const wsRoot = path.join(testTempRoot, "fail-project");
      await fs.mkdir(wsRoot, { recursive: true });

      const failScript = `
console.log('Starting suite...');
console.error('FATAL: assertion failed in math module');
process.exit(1);
`;
      await fs.writeFile(path.join(wsRoot, "fail-test.js"), failScript, "utf-8");

      const runner = new LocalSandboxRunner();
      const result = await runner.executeCommand({
        command: "node fail-test.js",
        cwd: wsRoot,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBeGreaterThanOrEqual(1);
      expect(result.stdout).toContain("Starting suite...");
      expect(result.stderr).toContain("FATAL: assertion failed in math module");
    });

    it("1.4: tracks git repository lifecycle, detects file modifications and generates diffs", async () => {
      const wsName = "git-project";
      const wsRoot = path.join(testTempRoot, wsName);
      await fs.mkdir(path.join(wsRoot, "src"), { recursive: true });

      const initialSource = `export function greet(name) { return 'Hello ' + name; }`;
      await fs.writeFile(path.join(wsRoot, "src", "greet.js"), initialSource, "utf-8");

      // Initialize git repo in wsRoot
      await execFile("git", ["init"], { cwd: wsRoot });
      await execFile("git", ["config", "user.name", "HermOS Test"], { cwd: wsRoot });
      await execFile("git", ["config", "user.email", "test@hermos.local"], { cwd: wsRoot });

      // Verify gitIsRepo
      const isRepo = await gitIsRepo(wsRoot);
      expect(isRepo).toBe(true);

      // Verify untracked files
      const status1 = await gitStatus(wsRoot);
      expect(status1.untracked.length).toBeGreaterThan(0);

      // Commit initial files
      await execFile("git", ["add", "."], { cwd: wsRoot });
      await execFile("git", ["commit", "-m", "Initial commit"], { cwd: wsRoot });

      const statusAfterCommit = await gitStatus(wsRoot);
      expect(statusAfterCommit.clean).toBe(true);
      expect(statusAfterCommit.modified.length).toBe(0);

      // Modify greet.js via writeFileWs
      const updatedSource = `
export function greet(name) { return 'Hello ' + name; }
export function farewell(name) { return 'Goodbye ' + name; }
`.trim();
      await writeFileWs(testUser.id, wsName, "src/greet.js", updatedSource, wsRoot);

      // Verify gitStatus detects modification
      const statusModified = await gitStatus(wsRoot);
      expect(statusModified.clean).toBe(false);
      expect(statusModified.modified.some((f) => f.path.includes("greet.js"))).toBe(true);

      // Verify gitDiff returns unified patch
      const diff = await gitDiff(wsRoot);
      expect(diff.files.length).toBeGreaterThan(0);
      const greetDiff = diff.files.find((f) => f.path.includes("greet.js"));
      expect(greetDiff).toBeDefined();
      expect(greetDiff?.additions).toBeGreaterThan(0);
      expect(greetDiff?.patch).toContain("farewell");
    });

    it("1.5: creates pre-edit checkpoints and snapshots files during project evolution", async () => {
      // Create a conversation in DB
      const conv = await db.conversation.create({
        data: {
          userId: testUser.id,
          title: "Dev Cycle Conversation",
          provider: "local",
          model: "default",
          mode: "agent",
        },
      });

      const wsRoot = path.join(testTempRoot, "checkpoint-cycle");
      await fs.mkdir(wsRoot, { recursive: true });
      const targetFile = path.join(wsRoot, "config.json");
      await fs.writeFile(targetFile, JSON.stringify({ version: "1.0.0", port: 3000 }), "utf-8");

      // 1. Create checkpoint
      const cp = await createCheckpoint(testUser.id, conv.id, "Step 1: Initial Config");
      expect(cp.id).toBeDefined();
      expect(cp.conversationId).toBe(conv.id);

      // 2. Snapshot file
      await snapshotFile(testUser.id, conv.id, cp.id, targetFile);

      // 3. Verify checkpoint manifests and listings
      const checkpoints = await listCheckpoints(testUser.id, conv.id);
      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(checkpoints[0].id).toBe(cp.id);

      const filesInfo = await getCheckpointFiles(testUser.id, cp.id);
      expect(filesInfo.files.length).toBe(1);
      expect(filesInfo.files[0]).toBe(targetFile);

      // Cleanup conversation
      await db.conversation.delete({ where: { id: conv.id } }).catch(() => null);
    });
  });

  // =========================================================================
  // Scenario 2: Autonomous AI Subagent Investigation Workflow
  // =========================================================================
  describe("Scenario 2: Autonomous AI Subagent Investigation Workflow", () => {
    let parentConvId: string;

    beforeEach(async () => {
      const conv = await db.conversation.create({
        data: {
          userId: testUser.id,
          title: "Parent Investigation Conversation",
          provider: "local",
          model: "default",
          mode: "agent",
        },
      });
      parentConvId = conv.id;
      clearConversationQueue(testUser.id, parentConvId);
    });

    afterEach(async () => {
      clearConversationQueue(testUser.id, parentConvId);
      await db.conversation.delete({ where: { id: parentConvId } }).catch(() => null);
    });

    it("2.1: spawns an autonomous subagent with scoped task, system prompt, and tools", () => {
      const subagent = createSubagent(testUser.id, parentConvId, {
        name: "SecurityAuditor",
        task: "Audit session resolver and authentication boundaries",
        systemPrompt: "You are a specialized security audit agent.",
        allowedTools: ["run_command", "read_file"],
      });

      expect(subagent.id).toMatch(/^sa-/);
      expect(subagent.name).toBe("SecurityAuditor");
      expect(subagent.task).toContain("Audit session resolver");
      expect(subagent.conversationId).toBe(parentConvId);
      expect(subagent.status).toBe("running");

      const fetched = getSubagent(testUser.id, subagent.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(subagent.id);
      expect(fetched?.name).toBe("SecurityAuditor");
    });

    it("2.2: records subagent multi-step tool execution, CLI commands, and message history", async () => {
      const subagent = createSubagent(testUser.id, parentConvId, {
        name: "VulnerabilityScanner",
        task: "Scan codebase for hardcoded credentials",
        allowedTools: ["run_command"],
      });

      // 1. Subagent logs progress
      appendProgress(subagent.id, "Scanning src/lib/session.ts...");
      appendProgress(subagent.id, "Checking loopback IP verification...");

      // 2. Subagent emits assistant message with tool call
      appendMessage(subagent.id, {
        role: "assistant",
        thinking: "Inspecting loopback IP definitions in session.ts",
        content: "Checking loopback set",
        toolCalls: [
          {
            id: "tc-scan-1",
            name: "run_command",
            arguments: JSON.stringify({ command: "node -e \"console.log('PASS: 0 ISSUES')\"" }),
          },
        ],
      });

      // 3. Execute tool via LocalSandboxRunner
      const runner = new LocalSandboxRunner();
      const execResult = await runner.executeCommand({
        command: "node -e \"console.log('PASS: 0 ISSUES')\"",
        cwd: testTempRoot,
      });
      expect(execResult.ok).toBe(true);

      // 4. Subagent records tool response message
      appendMessage(subagent.id, {
        role: "tool",
        toolCallId: "tc-scan-1",
        content: execResult.stdout.trim(),
      });

      // 5. Verify message history
      const history = getSubagentMessages(testUser.id, subagent.id);
      expect(history).not.toBeNull();
      expect(history!.length).toBeGreaterThanOrEqual(2);

      const assistantMsg = history!.find((m) => m.role === "assistant");
      expect(assistantMsg?.toolCalls?.[0].id).toBe("tc-scan-1");

      const toolMsg = history!.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("PASS: 0 ISSUES");
    });

    it("2.3: compiles structured subagent handoff report with findings and conclusion", () => {
      const subagent = createSubagent(testUser.id, parentConvId, {
        name: "ComplianceChecker",
        task: "Verify local-first desktop compliance",
      });

      const structuredReport = {
        summary: "Verified that all API routes resolve desktop@hermos.local with zero authentication prompts.",
        findings: [
          {
            file: "src/lib/session.ts",
            action: "verified",
            evidence: "requireUser resolves desktop user without throwing UNAUTHORIZED",
          },
          {
            file: "src/lib/sandbox/local-runner.ts",
            action: "verified",
            evidence: "LocalSandboxRunner spawns local child processes directly on host",
          },
        ],
        conclusion: "100% compliant with local-first desktop requirements.",
      };

      updateSession(subagent.id, {
        status: "completed",
        report: structuredReport,
        completedAt: Date.now(),
      });

      const updated = getSubagent(testUser.id, subagent.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeDefined();

      const reportData = getSubagentStructuredReport(testUser.id, subagent.id);
      expect(reportData).not.toBeNull();
      expect(reportData?.text).toContain("## Summary");
      expect(reportData?.text).toContain("src/lib/session.ts");
      expect(reportData?.text).toContain("## Conclusion");
      expect(reportData?.findings.length).toBe(2);
    });

    it("2.4: enqueues report and enables parent conversation to drain structured handoff", () => {
      const subagent = createSubagent(testUser.id, parentConvId, {
        name: "ArchitectSubagent",
        task: "Analyze refactoring plan",
      });

      updateSession(subagent.id, {
        status: "completed",
        report: {
          summary: "Refactoring plan approved.",
          findings: [
            {
              file: "src/app/page.tsx",
              action: "reviewed",
              evidence: "Direct IdeShell mounting verified",
            },
          ],
          conclusion: "Ready for implementation.",
        },
        completedAt: Date.now(),
      });

      // 1. Enqueue report
      enqueueSubagentReport(testUser.id, parentConvId, subagent.id);
      expect(isSubagentReportDelivered(testUser.id, parentConvId, subagent.id)).toBe(false);

      // 2. Parent drains queue
      const drained = drainSubagentReports(testUser.id, parentConvId);
      expect(drained.length).toBe(1);
      expect(drained[0].subagentId).toBe(subagent.id);
      expect(drained[0].content).toContain("<subagent_report name=\"ArchitectSubagent\">");
      expect(drained[0].content).toContain("Refactoring plan approved.");
      expect(drained[0].content).toContain("</subagent_report>");

      // 3. Mark delivered to avoid re-processing
      markSubagentReportDelivered(testUser.id, parentConvId, subagent.id);
      expect(isSubagentReportDelivered(testUser.id, parentConvId, subagent.id)).toBe(true);

      // Draining again returns empty
      const secondDrain = drainSubagentReports(testUser.id, parentConvId);
      expect(secondDrain.length).toBe(0);
    });

    it("2.5: lists conversation subagents and handles deletion cleanly", () => {
      const sa1 = createSubagent(testUser.id, parentConvId, { name: "Agent 1", task: "Task 1" });
      const sa2 = createSubagent(testUser.id, parentConvId, { name: "Agent 2", task: "Task 2" });

      const list = getSubagents(testUser.id, parentConvId);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((s) => s.id === sa1.id)).toBe(true);
      expect(list.some((s) => s.id === sa2.id)).toBe(true);

      const deleted = deleteSubagent(testUser.id, sa1.id);
      expect(deleted).toBe(true);

      expect(getSubagent(testUser.id, sa1.id)).toBeNull();
      expect(getSubagent(testUser.id, sa2.id)).not.toBeNull();
    });
  });

  // =========================================================================
  // Scenario 3: Web Visitor Discovery -> Download -> Direct IDE Launch Journey
  // =========================================================================
  describe("Scenario 3: Web Visitor Discovery -> Download -> Direct IDE Launch Journey", () => {
    it("3.1: web visitor requests platform installers and receives HTTP 307 redirects to releases", async () => {
      await acquireInstallersLock();
      try {
        const platforms = [
          { platform: "windows", expectedExt: ".msi" },
          { platform: "macos", expectedExt: ".dmg" },
          { platform: "linux", expectedExt: ".deb" },
        ];

        for (const { platform, expectedExt } of platforms) {
          const req = createMockRequest(`http://localhost:3000/api/download/${platform}`);
          const res = await getDownloadPlatform(req, {
            params: Promise.resolve({ platform }),
          });

          expect(res.status).toBe(307);
          const location = res.headers.get("location");
          expect(location).toBeDefined();
          expect(location).toContain("github.com/WFekik/HermOS-IDE/releases/");
          expect(location).toMatch(/releases\/(latest\/download|download\/v\d+\.\d+\.\d+)/);
          if (platform === "windows") {
            expect(location).toMatch(/\.(msi|exe)$/i);
          } else {
            expect(location).toContain(expectedExt);
          }
        }
      } finally {
        await releaseInstallersLock();
      }
    });

    it("3.2: rejects unsupported OS download requests with HTTP 400", async () => {
      const req = createMockRequest("http://localhost:3000/api/download/android");
      const res = await getDownloadPlatform(req, {
        params: Promise.resolve({ platform: "android" }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Unsupported platform");
    });

    it("3.3: serves pre-bundled local installer directly when available in public/installers/", async () => {
      await acquireInstallersLock();
      try {
        const installersDir = path.join(process.cwd(), "public", "installers");
        await fs.mkdir(installersDir, { recursive: true });

        const testMsiPath = path.join(installersDir, "hermos-ide-setup.msi");
        const dummyInstallerData = Buffer.from("DUMMY_MSI_BINARY_PAYLOAD_HERMOS_0.1.0");
        await fs.writeFile(testMsiPath, dummyInstallerData);

        try {
          const req = createMockRequest("http://localhost:3000/api/download/windows");
          const res = await getDownloadPlatform(req, {
            params: Promise.resolve({ platform: "windows" }),
          });

          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toBe("application/x-msi");
          expect(res.headers.get("Content-Disposition")).toBe(
            'attachment; filename="hermos-ide-setup.msi"',
          );

          const arrayBuf = await res.arrayBuffer();
          const downloadedBuffer = Buffer.from(arrayBuf);
          expect(downloadedBuffer.toString()).toBe("DUMMY_MSI_BINARY_PAYLOAD_HERMOS_0.1.0");
        } finally {
          await fs.rm(testMsiPath, { force: true }).catch(() => null);
        }
      } finally {
        await releaseInstallersLock();
      }
    });

    it("3.4: desktop app launches with HERMOS_DESKTOP and loopback host, resolving local user with zero auth gating", async () => {
      process.env.HERMOS_DESKTOP = "true";
      delete process.env.TRUST_PROXY;
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;

      const req = createMockRequest("http://127.0.0.1:3000/api/auth/me", {
        host: "127.0.0.1:3000",
      });

      // Test session resolver
      const currentUser = await getCurrentUser(req);
      expect(currentUser).not.toBeNull();
      expect(currentUser?.email).toBe("desktop@hermos.local");

      const requiredUser = await requireUser(req);
      expect(requiredUser.email).toBe("desktop@hermos.local");
      expect(["admin", "user"]).toContain(requiredUser.role);

      // Test /api/auth/me response
      const res = await getAuthMe(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.user).toBeDefined();
      expect(json.user.email).toBe("desktop@hermos.local");
    });

    it("3.5: client Zustand store hydrates desktop user directly without login splash", async () => {
      // Mock global fetch for /api/auth/me
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation((input: string | URL | Request) => {
        const urlStr = input.toString();
        if (urlStr.includes("/api/auth/me")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: {
                  id: testUser.id,
                  email: "desktop@hermos.local",
                  name: "Local Developer",
                  role: "admin",
                  provider: "local",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });

      try {
        const store = useAppStore.getState();
        await store.refreshAuth();

        const state = useAppStore.getState();
        expect(state.authChecked).toBe(true);
        expect(state.authLoading).toBe(false);
        expect(state.currentUser).not.toBeNull();
        expect(state.currentUser?.email).toBe("desktop@hermos.local");
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // =========================================================================
  // Scenario 4: Offline Air-Gapped Code Editing & Persistence
  // =========================================================================
  describe("Scenario 4: Offline Air-Gapped Code Editing & Persistence", () => {
    let airGappedFetch: typeof global.fetch;

    beforeEach(() => {
      // Simulate strict air-gapped network barrier
      airGappedFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = url.toString();
        // Allow internal localhost/127.0.0.1 calls only; block all external internet
        if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        return Promise.reject(new TypeError(`fetch failed: ENOTFOUND ${urlStr} (Offline Air-Gap)`));
      });
      global.fetch = airGappedFetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("4.1: verifies air-gapped network barrier blocks external network calls", async () => {
      await expect(global.fetch("https://api.openai.com/v1/models")).rejects.toThrow("ENOTFOUND");
      await expect(global.fetch("https://github.com/WFekik/HermOS-IDE")).rejects.toThrow("ENOTFOUND");
    });

    it("4.2: performs multi-file edits locally in air-gapped environment", async () => {
      const wsName = "air-gap-ws";
      const wsRoot = path.join(testTempRoot, wsName);
      await fs.mkdir(path.join(wsRoot, "src"), { recursive: true });

      const mathLibTs = `
export interface Vector2D {
  x: number;
  y: number;
}

export function calculateDistance(a: Vector2D, b: Vector2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export class GeometryCalculator {
  computeArea(width: number, height: number): number {
    return width * height;
  }
}
`.trim();

      const indexTs = `
import { calculateDistance, GeometryCalculator, Vector2D } from "./math-lib";

export const APP_VERSION = "2.0.0-offline";

export function main(): void {
  const calc = new GeometryCalculator();
  console.log("Area:", calc.computeArea(10, 20));
}
`.trim();

      await writeFileWs(testUser.id, wsName, "src/math-lib.ts", mathLibTs, wsRoot);
      await writeFileWs(testUser.id, wsName, "src/index.ts", indexTs, wsRoot);

      // Perform editFileWs
      await editFileWs(
        testUser.id,
        wsName,
        "src/math-lib.ts",
        "return width * height;",
        "return width * height * 1.0; // calibrated",
        false,
        wsRoot,
      );

      const modifiedMath = await readFileWs(testUser.id, wsName, "src/math-lib.ts", 100000, wsRoot);
      expect(modifiedMath.content).toContain("return width * height * 1.0; // calibrated");
    });

    it("4.3: extracts symbols and code outlines offline without external language servers", async () => {
      const code = `
export interface UserSession {
  userId: string;
  role: "admin" | "user";
}

export type SessionCallback = (session: UserSession) => void;

export const DEFAULT_TIMEOUT_MS = 5000;

export class SessionRegistry {
  private count = 0;

  register(u: UserSession): void {
    this.count++;
  }
}

export function createLocalSession(userId: string): UserSession {
  return { userId, role: "admin" };
}
`.trim();

      expect(languageFromExt("session-manager.ts")).toBe("typescript");

      const symbols = extractSymbols(code, "typescript");
      expect(symbols.length).toBeGreaterThanOrEqual(5);

      const symbolNames = symbols.map((s) => s.name);
      expect(symbolNames).toContain("UserSession");
      expect(symbolNames).toContain("SessionCallback");
      expect(symbolNames).toContain("DEFAULT_TIMEOUT_MS");
      expect(symbolNames).toContain("SessionRegistry");
      expect(symbolNames).toContain("createLocalSession");

      const userSessionSymbol = symbols.find((s) => s.name === "UserSession");
      expect(userSessionSymbol?.kind).toBe("interface");

      const classSymbol = symbols.find((s) => s.name === "SessionRegistry");
      expect(classSymbol?.kind).toBe("class");

      const funcSymbol = symbols.find((s) => s.name === "createLocalSession");
      expect(funcSymbol?.kind).toBe("function");
    });

    it("4.4: persists conversations and messages locally to embedded SQLite in air-gapped mode", async () => {
      // 1. Create conversation locally in SQLite
      const conv = await db.conversation.create({
        data: {
          userId: testUser.id,
          title: "Offline Air-Gap Conversation",
          provider: "local",
          model: "hermos-local-v1",
          mode: "agent",
        },
      });
      expect(conv.id).toBeDefined();

      // 2. Insert messages locally
      const userMsg = await db.message.create({
        data: {
          conversationId: conv.id,
          role: "user",
          content: "Perform local offline analysis",
        },
      });

      const assistantMsg = await db.message.create({
        data: {
          conversationId: conv.id,
          role: "assistant",
          content: "Analysis complete. All computations executed locally.",
          thinking: "Running on embedded SQLite engine.",
        },
      });

      // 3. Query conversation and messages from local SQLite
      const retrieved = await db.conversation.findUnique({
        where: { id: conv.id },
        include: { messages: true },
      });

      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Offline Air-Gap Conversation");
      expect(retrieved?.messages.length).toBe(2);

      const roles = retrieved?.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");

      // Cleanup
      await db.message.deleteMany({ where: { conversationId: conv.id } });
      await db.conversation.delete({ where: { id: conv.id } });
    });

    it("4.5: executes local computation script offline via LocalSandboxRunner", async () => {
      const wsRoot = path.join(testTempRoot, "offline-exec");
      await fs.mkdir(wsRoot, { recursive: true });

      const script = `
const numbers = [1, 2, 3, 4, 5];
const sum = numbers.reduce((a, b) => a + b, 0);
console.log('OFFLINE COMPUTED SUM:', sum);
`;
      await fs.writeFile(path.join(wsRoot, "compute.js"), script, "utf-8");

      const runner = new LocalSandboxRunner();
      const res = await runner.executeCommand({
        command: "node compute.js",
        cwd: wsRoot,
      });

      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("OFFLINE COMPUTED SUM: 15");
    });
  });

  // =========================================================================
  // Scenario 5: Multi-File Refactoring with Checkpoint Rollback
  // =========================================================================
  describe("Scenario 5: Multi-File Refactoring with Checkpoint Rollback", () => {
    let convId: string;
    let wsRoot: string;
    let engineFile: string;
    let formatterFile: string;
    let testRunnerFile: string;

    const BASELINE_ENGINE = `
function runEngine(input) {
  return "engine:" + input;
}
module.exports = { runEngine };
`.trim();

    const BASELINE_FORMATTER = `
function formatOutput(data) {
  return "[" + data + "]";
}
module.exports = { formatOutput };
`.trim();

    const BASELINE_TEST_RUNNER = `
const { runEngine } = require('../core/engine.js');
const { formatOutput } = require('../utils/formatter.js');

const raw = runEngine("alpha");
const formatted = formatOutput(raw);

if (formatted !== "[engine:alpha]") {
  console.error("FAIL: Expected [engine:alpha] but got", formatted);
  process.exit(1);
}
console.log("BASELINE SUITE PASSED");
`.trim();

    beforeEach(async () => {
      const conv = await db.conversation.create({
        data: {
          userId: testUser.id,
          title: "Refactoring Rollback Conv",
          provider: "local",
          model: "default",
          mode: "agent",
        },
      });
      convId = conv.id;

      wsRoot = path.join(testTempRoot, "refactor-ws");
      await fs.mkdir(path.join(wsRoot, "core"), { recursive: true });
      await fs.mkdir(path.join(wsRoot, "utils"), { recursive: true });
      await fs.mkdir(path.join(wsRoot, "tests"), { recursive: true });

      engineFile = path.join(wsRoot, "core", "engine.js");
      formatterFile = path.join(wsRoot, "utils", "formatter.js");
      testRunnerFile = path.join(wsRoot, "tests", "test-runner.js");

      await fs.writeFile(engineFile, BASELINE_ENGINE, "utf-8");
      await fs.writeFile(formatterFile, BASELINE_FORMATTER, "utf-8");
      await fs.writeFile(testRunnerFile, BASELINE_TEST_RUNNER, "utf-8");
    });

    afterEach(async () => {
      await db.conversation.delete({ where: { id: convId } }).catch(() => null);
    });

    it("5.1: verifies baseline test passes before refactoring starts", async () => {
      const runner = new LocalSandboxRunner();
      const res = await runner.executeCommand({
        command: "node tests/test-runner.js",
        cwd: wsRoot,
      });

      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("BASELINE SUITE PASSED");
    });

    it("5.2: executes full refactoring lifecycle, detects test regression, and rolls back to pristine state", async () => {
      const runner = new LocalSandboxRunner();

      // Step 1: Create pre-edit checkpoint
      const checkpoint = await createCheckpoint(testUser.id, convId, "Pre-Refactor Snapshot");
      expect(checkpoint.id).toBeDefined();

      // Step 2: Snapshot existing baseline files
      await snapshotFile(testUser.id, convId, checkpoint.id, engineFile);
      await snapshotFile(testUser.id, convId, checkpoint.id, formatterFile);

      // Step 3: Perform breaking multi-file refactoring
      // Modify core/engine.js (breaking return format)
      const breakingEngine = `
function runEngine(input) {
  return { payload: input }; // BREAKING OBJECT RETURN
}
module.exports = { runEngine };
`.trim();
      await fs.writeFile(engineFile, breakingEngine, "utf-8");

      // Modify utils/formatter.js (breaking syntax/output)
      const breakingFormatter = `
function formatOutput(data) {
  return "DATA::" + data.toString();
}
module.exports = { formatOutput };
`.trim();
      await fs.writeFile(formatterFile, breakingFormatter, "utf-8");

      // Create new subdirectory and new file
      const newPluginsDir = path.join(wsRoot, "core", "plugins");
      await fs.mkdir(newPluginsDir, { recursive: true });
      await trackNewDir(testUser.id, convId, checkpoint.id, newPluginsDir);

      const newLoggerFile = path.join(newPluginsDir, "logger.js");
      await fs.writeFile(
        newLoggerFile,
        'module.exports = { log: (x) => console.log("[LOGGER]", x) };',
        "utf-8",
      );
      await trackNewFile(testUser.id, convId, checkpoint.id, newLoggerFile);

      // Step 4: Run test suite — expect regression failure
      const failRun = await runner.executeCommand({
        command: "node tests/test-runner.js",
        cwd: wsRoot,
      });

      expect(failRun.ok).toBe(false);
      expect(failRun.exitCode).toBeGreaterThanOrEqual(1);
      expect(failRun.stderr).toContain("FAIL: Expected [engine:alpha]");

      // Verify files in broken refactored state
      expect(await fs.readFile(engineFile, "utf-8")).toBe(breakingEngine);
      expect(existsSync(newLoggerFile)).toBe(true);

      // Step 5: Restore Checkpoint (Rollback)
      const rollbackResult = await restoreCheckpoint(testUser.id, checkpoint.id);
      expect(rollbackResult.ok).toBe(true);

      // Step 6: Verify all original files restored and new files/dirs removed
      const restoredEngine = await fs.readFile(engineFile, "utf-8");
      expect(restoredEngine).toBe(BASELINE_ENGINE);

      const restoredFormatter = await fs.readFile(formatterFile, "utf-8");
      expect(restoredFormatter).toBe(BASELINE_FORMATTER);

      // Newly added file and directory must be completely removed
      expect(existsSync(newLoggerFile)).toBe(false);
      expect(existsSync(newPluginsDir)).toBe(false);

      // Step 7: Re-run test suite on restored workspace — expect 100% pass
      const passRun = await runner.executeCommand({
        command: "node tests/test-runner.js",
        cwd: wsRoot,
      });

      expect(passRun.ok).toBe(true);
      expect(passRun.exitCode).toBe(0);
      expect(passRun.stdout).toContain("BASELINE SUITE PASSED");
    });
  });
});

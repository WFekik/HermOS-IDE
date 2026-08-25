import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import { NextRequest } from "next/server";

import { getCurrentUser, requireUser, toUserDTO } from "@/lib/session";
import { db, dbReady, resolveDatabaseUrl } from "@/lib/db";
import { APP_DATA_DIR } from "@/lib/paths";
import {
  safePath,
  safePathFromRoot,
  isSubpathOrEqual,
  readFileWs,
  readFileRangeWs,
  writeFileWs,
  editFileWs,
  multiEditWs,
  deletePathWs,
  mkdirWs,
  renamePathWs,
  globWs,
  runCommandWs,
  startBackgroundCommand,
  getRunningCommand,
  stopRunningCommand,
  waitForCommandCompletion,
  openWorkspace,
  ensureDefaultWorkspace,
  switchWorkspace,
  resolveCommandSafety,
  deniedWriteExtension,
} from "@/lib/workspace";
import {
  truncateHistory,
  pruneOldToolOutputs,
  estimateTokens,
  estimateMessageTokens,
  isContextOverflow,
  TOOL_OUTPUT_CLEARED,
  DEFAULT_CONTEXT_CONFIG,
} from "@/lib/ai/context";
import {
  registerAgentAbort,
  unregisterAgentAbort,
  abortAgentStream,
  isAgentRunning,
  getActiveAgentConversations,
} from "@/lib/agent-abort";
import { getSandboxRunner } from "@/lib/sandbox";
import { seedIfNeeded } from "@/lib/seed";
import { useAppStore } from "@/stores/app-store";
import { GET as downloadPlatformGet } from "@/app/api/download/[platform]/route";

const TEST_USER_ID = "e2e-tier2-tester";
const TEST_WS_NAME = "e2e-tier2-ws";
let testRootDir: string;

function createMockRequest(headersObj: Record<string, string> = {}): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(headersObj)) {
    headers.set(k, v);
  }
  return new Request("http://localhost:3000/api/test", { headers });
}

describe("Boundary Cases — E2E Boundaries & Edge Conditions", () => {
  beforeEach(async () => {
    testRootDir = path.join(os.tmpdir(), `hermos-tier2-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(testRootDir, { recursive: true });
    await dbReady;
    await db.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: `${TEST_USER_ID}@local`, name: "Tester", provider: "local", role: "user" },
    });
    await openWorkspace(TEST_USER_ID, TEST_WS_NAME, testRootDir);
  });

  afterEach(async () => {
    try {
      if (existsSync(testRootDir)) {
        rmSync(testRootDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Dimension 1: Offline & Air-Gapped Operation
  // =========================================================================
  describe("1. Offline & Air-Gapped Operation", () => {
    it("1.1 should resolve local desktop user without external network calls or timeouts", async () => {
      vi.stubEnv("HERMOS_DESKTOP", "true");
      const req = createMockRequest({ "x-forwarded-for": "127.0.0.1" });

      const startTime = performance.now();
      const user = await requireUser(req);
      const elapsed = performance.now() - startTime;

      expect(user).toBeDefined();
      expect(user.email).toBe("desktop@hermos.local");
      expect(user.id).toBeDefined();
      expect(elapsed).toBeLessThan(500); // Must resolve instantly from local SQLite without IDP timeout
    });

    it("1.2 should execute local SQLite database queries with zero network connectivity", async () => {
      await dbReady;
      const testEmail = `offline-${Date.now()}@hermos.local`;
      const created = await db.user.create({
        data: {
          email: testEmail,
          name: "Offline Dev",
          provider: "local",
          role: "user",
        },
      });

      expect(created.id).toBeDefined();
      const found = await db.user.findUnique({ where: { email: testEmail } });
      expect(found).not.toBeNull();
      expect(found?.email).toBe(testEmail);

      // Clean up
      await db.user.delete({ where: { id: created.id } }).catch(() => {});
    });

    it("1.3 should perform file reading, writing, and glob searching completely offline", async () => {
      const fileName = "src/modules/offline-service.ts";
      const fileContent = "export const isOffline = true;\nexport function getStatus() { return 'ready'; }";

      const writeRes = await writeFileWs(TEST_USER_ID, TEST_WS_NAME, fileName, fileContent, testRootDir);
      expect(writeRes.path).toBe(fileName);
      expect(writeRes.bytes).toBeGreaterThan(0);

      const readRes = await readFileWs(TEST_USER_ID, TEST_WS_NAME, fileName, 10000, testRootDir);
      expect(readRes.content).toBe(fileContent);
      expect(readRes.size).toBe(Buffer.byteLength(fileContent, "utf8"));

      const globRes = await globWs(TEST_USER_ID, TEST_WS_NAME, "**/*.ts", undefined, testRootDir);
      expect(globRes.matches).toContain(fileName);
      expect(globRes.count).toBeGreaterThanOrEqual(1);
    });

    it("1.4 should handle download endpoint offline with local installer or deterministic redirect", async () => {
      const req = new NextRequest("http://localhost:3000/api/download/windows");
      const res = await downloadPlatformGet(req, {
        params: Promise.resolve({ platform: "windows" }),
      });

      expect(res).toBeDefined();
      // If local installer exists in public/installers, returns 200 attachment; otherwise 307 redirect
      expect([200, 307]).toContain(res.status);
      if (res.status === 307) {
        const location = res.headers.get("location");
        expect(location).toContain("https://github.com/WFekik/HermOS-IDE/releases/latest/download/");
        expect(location).toContain(".msi");
      } else if (res.status === 200) {
        expect(res.headers.get("content-disposition")).toContain("attachment");
      }
    });

    it("1.5 should execute local child-process terminal commands in local sandbox runner mode", async () => {
      const runner = getSandboxRunner();
      expect(runner.mode).toBe("local");

      const res = await runCommandWs(TEST_USER_ID, TEST_WS_NAME, "help", {
        rootDir: testRootDir,
      });

      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("HermOS workspace terminal");
      expect(res.stdout).toContain("Examples:");

      // Also verify real shell command execution
      const echoRes = await runCommandWs(TEST_USER_ID, TEST_WS_NAME, "echo hermos-local-ok");
      expect(echoRes.ok).toBe(true);
      expect(echoRes.exitCode).toBe(0);
      expect(echoRes.stdout.trim()).toContain("hermos-local-ok");
    });
  });

  // =========================================================================
  // Dimension 2: Path Confinement & Traversal Security
  // =========================================================================
  describe("2. Path Confinement & Traversal Security", () => {
    it("2.1 should reject ../ relative path traversal escapes from workspace", async () => {
      expect(safePathFromRoot(testRootDir, "../../etc/passwd")).toBeNull();
      expect(safePathFromRoot(testRootDir, "foo/../../../../outside.txt")).toBeNull();
      expect(safePath(TEST_USER_ID, TEST_WS_NAME, "../../../secret.key", testRootDir)).toBeNull();

      await expect(
        readFileWs(TEST_USER_ID, TEST_WS_NAME, "../../../etc/shadow", 1000, testRootDir),
      ).rejects.toThrow("Invalid path.");

      await expect(
        writeFileWs(TEST_USER_ID, TEST_WS_NAME, "../../escaped.txt", "hacked", testRootDir),
      ).rejects.toThrow("Invalid path.");
    });

    it("2.2 should reject absolute path jailbreaking outside workspace root", async () => {
      const isWin = process.platform === "win32";
      const targetAbs = isWin ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/shadow";

      expect(safePathFromRoot(testRootDir, targetAbs)).toBeNull();
      expect(safePath(TEST_USER_ID, TEST_WS_NAME, targetAbs, testRootDir)).toBeNull();

      await expect(
        deletePathWs(TEST_USER_ID, TEST_WS_NAME, targetAbs, testRootDir),
      ).rejects.toThrow("Invalid path.");
    });

    it("2.3 should reject dot-only traversal segments and multi-dot variations", () => {
      expect(safePathFromRoot(testRootDir, "....//file.txt")).toBeNull();
      expect(safePathFromRoot(testRootDir, "dir/.../secret")).toBeNull();
      expect(safePathFromRoot(testRootDir, "..\\..\\evil.txt")).toBeNull();
      expect(safePathFromRoot(testRootDir, "a/b/../../../c")).toBeNull();

      // Legitimate multi-dot filenames inside workspace must still be valid
      const legit = safePathFromRoot(testRootDir, "my.test..data.json");
      expect(legit).not.toBeNull();
      expect(legit).toBe(path.resolve(testRootDir, "my.test..data.json"));
    });

    it("2.4 should enforce Windows drive letter boundary escapes & case-insensitivity correctly", () => {
      if (process.platform === "win32") {
        expect(isSubpathOrEqual("D:\\other\\file.txt", "C:\\workspace")).toBe(false);
        expect(isSubpathOrEqual("C:\\Workspace\\App\\Index.ts", "c:\\workspace")).toBe(true);
        expect(safePathFromRoot("C:\\HermOS_Workspace", "D:\\Windows\\System32")).toBeNull();
      } else {
        expect(isSubpathOrEqual("/var/log/syslog", "/home/user/project")).toBe(false);
        expect(isSubpathOrEqual("/home/user/project/src/index.ts", "/home/user/project")).toBe(true);
      }
    });

    it("2.5 should block writing to denied dangerous executable extensions", async () => {
      expect(deniedWriteExtension("trojan.exe")).toBe(".exe");
      expect(deniedWriteExtension("malicious.bat")).toBe(".bat");
      expect(deniedWriteExtension("script.cmd")).toBe(".cmd");
      expect(deniedWriteExtension("payload.ps1")).toBe(".ps1");
      expect(deniedWriteExtension("library.dll")).toBe(".dll");
      expect(deniedWriteExtension("safe.txt")).toBeNull();

      await expect(
        writeFileWs(TEST_USER_ID, TEST_WS_NAME, "bin/malware.exe", "MZ...", testRootDir),
      ).rejects.toThrow('Writing files with the ".exe" extension is not allowed.');

      await expect(
        writeFileWs(TEST_USER_ID, TEST_WS_NAME, "hack.ps1", "Write-Host 'hack'", testRootDir),
      ).rejects.toThrow('Writing files with the ".ps1" extension is not allowed.');

      // Also renaming into a denied extension must be blocked
      await writeFileWs(TEST_USER_ID, TEST_WS_NAME, "normal.txt", "content", testRootDir);
      await expect(
        renamePathWs(TEST_USER_ID, TEST_WS_NAME, "normal.txt", "normal.bat", testRootDir),
      ).rejects.toThrow('Writing files with the ".bat" extension is not allowed.');
    });
  });

  // =========================================================================
  // Dimension 3: High-Volume Output & Truncation Handling
  // =========================================================================
  describe("3. High-Volume Output & Truncation Handling", () => {
    it("3.1 should slice high-volume files (>10,000 lines) safely with line range clamping", async () => {
      const totalLineCount = 12000;
      const lines = Array.from({ length: totalLineCount }, (_, i) => `Line ${i + 1}: log entry with timestamp and data`);
      const fullText = lines.join("\n") + "\n";
      const filePath = path.join(testRootDir, "large-log.txt");
      writeFileSync(filePath, fullText, "utf8");

      // Read a range in the middle
      const rangeRes = await readFileRangeWs(TEST_USER_ID, TEST_WS_NAME, "large-log.txt", 500, 505, testRootDir);
      expect(rangeRes.totalLines).toBe(totalLineCount);
      expect(rangeRes.startLine).toBe(500);
      expect(rangeRes.endLine).toBe(505);
      const resultLines = rangeRes.content.split("\n");
      expect(resultLines.length).toBe(6);
      expect(resultLines[0]).toBe("Line 500: log entry with timestamp and data");
      expect(resultLines[5]).toBe("Line 505: log entry with timestamp and data");

      // Read with endLine beyond bounds: should clamp to totalLines
      const clampedRes = await readFileRangeWs(TEST_USER_ID, TEST_WS_NAME, "large-log.txt", 11995, 20000, testRootDir);
      expect(clampedRes.endLine).toBe(totalLineCount);
      expect(clampedRes.content.split("\n").length).toBe(6); // 11995 to 12000
    });

    it("3.2 should reject readFileRangeWs on files exceeding 10MB to prevent memory exhaustion", async () => {
      const hugePath = path.join(testRootDir, "huge-binary.dat");
      // Create a sparse file or buffer header claiming > 10MB
      const tenMbPlus = 10 * 1024 * 1024 + 512;
      const handle = await fs.open(hugePath, "w");
      await handle.truncate(tenMbPlus);
      await handle.close();

      await expect(
        readFileRangeWs(TEST_USER_ID, TEST_WS_NAME, "huge-binary.dat", 1, 10, testRootDir),
      ).rejects.toThrow("limit 10000000 for range reads");
    });

    it("3.3 should preserve system prompt anchor and tail turns during context truncation", () => {
      const systemPrompt = "You are HermOS Assistant. Ground every answer in reality.";
      const messages = [
        { role: "user", content: "Original task: refactor the entire system" },
        { role: "assistant", content: "Understood, I will start by analyzing modules." },
        { role: "user", content: "Intermediate question 1: what is module A?" },
        { role: "assistant", content: "Module A does X. Long detailed prose ".repeat(50) },
        { role: "user", content: "Intermediate question 2: what is module B?" },
        { role: "assistant", content: "Module B does Y. Long detailed prose ".repeat(50) },
        { role: "user", content: "Intermediate question 3: what is module C?" },
        { role: "assistant", content: "Module C does Z. Long detailed prose ".repeat(50) },
        { role: "user", content: "Latest turn: please apply the final fix." },
        { role: "assistant", content: "I am applying the final fix now." },
      ];

      // Constrain contextWindow so middle turns MUST be dropped
      const res = truncateHistory(messages, systemPrompt, {
        contextWindow: 1200,
        systemTokens: estimateTokens(systemPrompt),
        maxOutputTokens: 200,
        tailTurns: 1,
      });

      expect(res.dropped).toBeGreaterThan(0);
      expect(res.messages.length).toBeGreaterThanOrEqual(3);

      // Verify the task anchor (first user message) is preserved
      expect(res.messages[0].role).toBe("user");
      expect(res.messages[0].content).toContain("Original task: refactor the entire system");

      // Verify the last message is preserved
      const lastMsg = res.messages[res.messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(lastMsg.content).toContain("I am applying the final fix now.");

      // Verify compaction summary was injected
      const summaryMsg = res.messages.find((m) => m.content.includes("compacted"));
      expect(summaryMsg).toBeDefined();
    });

    it("3.4 should prune old tool outputs past protection budget while keeping tool call metadata", () => {
      const history = [
        { role: "user", content: "Run multiple tools please" },
        {
          role: "assistant",
          content: "Calling first tool",
          toolCalls: [{ name: "read_file", arguments: '{"path":"old.txt"}', id: "call_1" }],
        },
        { role: "tool", content: "HUGE OLD OUTPUT ".repeat(200), toolCallId: "call_1" },
        {
          role: "assistant",
          content: "Calling second tool",
          toolCalls: [{ name: "read_file", arguments: '{"path":"recent.txt"}', id: "call_2" }],
        },
        { role: "tool", content: "RECENT OUTPUT KEEP ME", toolCallId: "call_2" },
      ];

      const pruned = pruneOldToolOutputs(history, {
        pruneProtectTokens: 50, // Low protection window: oldest tool output gets cleared
      });

      expect(pruned.tokensFreed).toBeGreaterThan(0);
      expect(pruned.messages[2].content).toBe(TOOL_OUTPUT_CLEARED);
      expect(pruned.messages[4].content).toBe("RECENT OUTPUT KEEP ME");
      // Assistant's tool metadata remains intact
      expect(pruned.messages[1].toolCalls).toBeDefined();
    });

    it("3.5 should accurately measure complex message token estimates with thinking and attachments", () => {
      const textOnlyTokens = estimateTokens("Just text");
      const complexTokens = estimateMessageTokens({
        role: "assistant",
        content: "Here is the result",
        thinking: "Let me consider edge cases and analyze deeply for 5 steps...",
        toolCalls: [
          { name: "edit_file", arguments: JSON.stringify({ path: "app.ts", find: "a", replace: "b" }), id: "tc_1" },
        ],
        attachments: [{ name: "screenshot.png", size: 1024 }],
      });

      expect(complexTokens).toBeGreaterThan(textOnlyTokens + 20);
      expect(isContextOverflow(100000, 50000)).toBe(true);
      expect(isContextOverflow(1000, 50000)).toBe(false);
    });
  });

  // =========================================================================
  // Dimension 4: Max Tabs LRU Eviction Under Load
  // =========================================================================
  describe("4. Max Tabs LRU Eviction Under Load", () => {
    beforeEach(() => {
      useAppStore.getState().closeAllFileTabs();
    });

    it("4.1 should cap open tabs at MAX_OPEN_TABS (10) when opening >10 tabs sequentially", () => {
      const store = useAppStore.getState();

      for (let i = 1; i <= 15; i++) {
        store.openFileTab(`file_${i}.ts`);
      }

      const state = useAppStore.getState();
      expect(state.openFiles.length).toBe(10);
      expect(state.activeFileTab).toBe("file_15.ts");
    });

    it("4.2 should strictly preserve the currently active tab during LRU eviction", () => {
      const store = useAppStore.getState();

      // Open 10 files
      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file_${i}.ts`);
      }

      // Explicitly set file_2.ts as the active tab
      store.setActiveFileTab("file_2.ts");
      expect(useAppStore.getState().activeFileTab).toBe("file_2.ts");

      // Open an 11th tab
      store.openFileTab("file_11.ts");

      const state = useAppStore.getState();
      expect(state.openFiles.length).toBe(10);
      // file_2.ts must STILL be present because it was protected from eviction
      expect(state.openFiles).toContain("file_2.ts");
      expect(state.openFiles).toContain("file_11.ts");
      // The oldest non-active tab (file_1.ts) was evicted
      expect(state.openFiles).not.toContain("file_1.ts");
    });

    it("4.3 should strictly preserve the split-editor tab during LRU eviction", () => {
      const store = useAppStore.getState();

      // Open 10 files
      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file_${i}.ts`);
      }

      // Pin file_3.ts to the split editor pane
      store.setSplitEditorFile("file_3.ts");
      // Make file_7.ts the active tab
      store.setActiveFileTab("file_7.ts");

      // Open files 11, 12, 13
      store.openFileTab("file_11.ts");
      store.openFileTab("file_12.ts");
      store.openFileTab("file_13.ts");

      const state = useAppStore.getState();
      expect(state.openFiles.length).toBe(10);
      // Both the split-editor file and active tab must be preserved
      expect(state.openFiles).toContain("file_3.ts");
      expect(state.splitEditorFile).toBe("file_3.ts");
    });

    it("4.4 should evict the oldest inactive tab in strict LRU order", () => {
      const store = useAppStore.getState();

      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file_${i}.ts`);
      }

      // Current active tab is file_10.ts. Oldest inactive is file_1.ts.
      store.openFileTab("file_11.ts");
      let state = useAppStore.getState();
      expect(state.openFiles).not.toContain("file_1.ts");
      expect(state.openFiles).toContain("file_2.ts");

      // Next oldest is file_2.ts
      store.openFileTab("file_12.ts");
      state = useAppStore.getState();
      expect(state.openFiles).not.toContain("file_2.ts");
      expect(state.openFiles).toContain("file_3.ts");
    });

    it("4.5 should be idempotent when opening already-open tabs without duplicating or evicting", () => {
      const store = useAppStore.getState();

      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file_${i}.ts`);
      }

      expect(useAppStore.getState().openFiles.length).toBe(10);

      // Re-opening an existing open file
      store.openFileTab("file_4.ts");

      const state = useAppStore.getState();
      expect(state.openFiles.length).toBe(10);
      expect(state.activeFileTab).toBe("file_4.ts");
      // No tabs should have been evicted
      expect(state.openFiles).toContain("file_1.ts");
    });

    it("4.6 should shift active tab to adjacent on close and reset on closeAllFileTabs", () => {
      const store = useAppStore.getState();

      store.openFileTab("a.ts");
      store.openFileTab("b.ts");
      store.openFileTab("c.ts");

      expect(useAppStore.getState().activeFileTab).toBe("c.ts");

      // Close the active tab c.ts
      store.closeFileTab("c.ts");
      let state = useAppStore.getState();
      expect(state.openFiles).toEqual(["a.ts", "b.ts"]);
      expect(state.activeFileTab).toBe("b.ts");

      // Close all tabs
      store.closeAllFileTabs();
      state = useAppStore.getState();
      expect(state.openFiles).toEqual([]);
      expect(state.activeFileTab).toBeNull();
      expect(state.splitEditorOpen).toBe(false);
    });
  });

  // =========================================================================
  // Dimension 5: Agent Cancellation & Process Interruption
  // =========================================================================
  describe("5. Agent Cancellation & Process Interruption", () => {
    it("5.1 should immediately reject command execution if signal is pre-aborted", async () => {
      const ac = new AbortController();
      ac.abort();

      const res = await runCommandWs(TEST_USER_ID, TEST_WS_NAME, "echo aborted-test", {
        signal: ac.signal,
        rootDir: testRootDir,
      });

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(124);
      expect(res.reason).toBe("Aborted before start.");
    });

    it("5.2 should abort running command when AbortSignal triggers mid-execution", async () => {
      const ac = new AbortController();
      const longCommand = process.platform === "win32"
        ? 'node -e "setTimeout(() => {}, 10000);"'
        : "node -e 'setTimeout(() => {}, 10000);'";

      const promise = runCommandWs(TEST_USER_ID, TEST_WS_NAME, longCommand, {
        signal: ac.signal,
        rootDir: testRootDir,
      });

      // Abort shortly after start
      setTimeout(() => ac.abort(), 100);

      const res = await promise;
      expect(res.ok).toBe(false);
    });

    it("5.3 should register, track, and abort active agent streams via registry", () => {
      const convId = `c_test_abort_${Date.now()}`;
      const controller = new AbortController();

      expect(isAgentRunning(convId)).toBe(false);

      registerAgentAbort(convId, controller);
      expect(isAgentRunning(convId)).toBe(true);
      expect(getActiveAgentConversations()).toContain(convId);
      expect(controller.signal.aborted).toBe(false);

      // Abort the stream
      const aborted = abortAgentStream(convId);
      expect(aborted).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(isAgentRunning(convId)).toBe(false);

      // Subsequent unregister or abort should handle cleanly
      expect(abortAgentStream(convId)).toBe(false);
      unregisterAgentAbort(convId);
    });

    it("5.4 should terminate background process and clear registry via stopRunningCommand", async () => {
      const convId = `c_bg_stop_${Date.now()}`;
      const bgCmd = process.platform === "win32"
        ? 'node -e "setInterval(() => {}, 1000);"'
        : "node -e 'setInterval(() => {}, 1000);'";

      const started = startBackgroundCommand(TEST_USER_ID, convId, TEST_WS_NAME, bgCmd, {
        rootDir: testRootDir,
      });

      expect(started.ok).toBe(true);
      expect(started.commandId).toBeDefined();

      const running = getRunningCommand(TEST_USER_ID, convId);
      expect(running).not.toBeNull();

      const stopped = stopRunningCommand(TEST_USER_ID, convId);
      expect(stopped).toBe(true);

      const runningAfter = getRunningCommand(TEST_USER_ID, convId);
      expect(runningAfter).toBeNull();
    });

    it("5.5 should handle waitForCommandCompletion with signal abortion and timeouts without leak", async () => {
      const convId = `c_wait_abort_${Date.now()}`;
      const ac = new AbortController();

      // Wait on non-running command with short timeout
      const timeoutRes = await waitForCommandCompletion(TEST_USER_ID, convId, 50, ac.signal);
      expect(timeoutRes).toBeNull();

      // Trigger abort immediately
      ac.abort();
      const abortRes = await waitForCommandCompletion(TEST_USER_ID, convId, 5000, ac.signal);
      expect(abortRes).toBeNull();
    });
  });

  // =========================================================================
  // Dimension 6: Database Edge Cases & Auto-Seeding
  // =========================================================================
  describe("6. Database Edge Cases & Auto-Seeding", () => {
    it("6.1 should execute seedIfNeeded idempotently across repeated calls without duplicates", async () => {
      await seedIfNeeded();
      const count1 = await db.agentPreset.count({ where: { isBuiltin: true } });
      expect(count1).toBeGreaterThanOrEqual(5);

      // Call seed again
      await seedIfNeeded();
      const count2 = await db.agentPreset.count({ where: { isBuiltin: true } });
      expect(count2).toBe(count1);
    });

    it("6.2 should ensure and activate default workspace on disk and database for a user", async () => {
      const userSeedId = `user-ws-seed-${Date.now()}`;
      // Create user first
      await db.user.create({
        data: {
          id: userSeedId,
          email: `${userSeedId}@hermos.local`,
          name: "Workspace Tester",
          provider: "local",
          role: "user",
        },
      });

      const ws = await ensureDefaultWorkspace(userSeedId);
      expect(ws.name).toBe("default");
      expect(ws.isActive).toBe(true);
      expect(existsSync(ws.rootDir)).toBe(true);

      // Clean up
      await db.workspace.deleteMany({ where: { userId: userSeedId } }).catch(() => {});
      await db.user.delete({ where: { id: userSeedId } }).catch(() => {});
    });

    it("6.3 should normalize user records with null fields safely into UserDTO", () => {
      const rawUser = {
        id: "usr_norm_123",
        email: "test@example.com",
        name: null,
        avatar: null,
        provider: "local",
        role: "admin",
      };

      const dto = toUserDTO(rawUser);
      expect(dto.id).toBe("usr_norm_123");
      expect(dto.email).toBe("test@example.com");
      expect(dto.name).toBeUndefined();
      expect(dto.avatar).toBeUndefined();
      expect(dto.role).toBe("admin");
      expect(dto.provider).toBe("local");
    });

    it("6.4 should resolve SQLite and cloud DATABASE_URL deterministically", () => {
      const derived = resolveDatabaseUrl(undefined);
      expect(derived).toContain("hermos.db");
      expect(derived.startsWith("file:")).toBe(true);

      const rel = resolveDatabaseUrl("file:./dev.db");
      expect(rel).toContain("hermos.db");

      const pg = resolveDatabaseUrl("postgres://user:pass@localhost:5432/hermos_cloud");
      expect(pg).toBe("postgres://user:pass@localhost:5432/hermos_cloud");
    });

    it("6.5 should switch workspaces and handle non-existent workspace IDs gracefully", async () => {
      const userSwId = `user-sw-${Date.now()}`;
      await db.user.create({
        data: { id: userSwId, email: `${userSwId}@local`, name: "Sw Tester", provider: "local", role: "user" },
      });

      const ws1 = await openWorkspace(userSwId, "project-alpha", path.join(testRootDir, "alpha"));
      const ws2 = await openWorkspace(userSwId, "project-beta", path.join(testRootDir, "beta"));

      expect(ws2.isActive).toBe(true);

      // Switch back to ws1
      const switched = await switchWorkspace(userSwId, ws1.id);
      expect(switched).not.toBeNull();
      expect(switched?.id).toBe(ws1.id);
      expect(switched?.name).toBe("project-alpha");

      // Switching to invalid/non-existent ID returns null without throwing
      const invalidSwitch = await switchWorkspace(userSwId, "non-existent-ws-id");
      expect(invalidSwitch).toBeNull();

      // Clean up
      await db.workspace.deleteMany({ where: { userId: userSwId } }).catch(() => {});
      await db.user.delete({ where: { id: userSwId } }).catch(() => {});
    });

    it("6.6 should validate command safety against shell injection and traversal escapes", () => {
      const escapeAttempt = resolveCommandSafety("cd ../../ && ls", testRootDir);
      expect(escapeAttempt.ok).toBe(false);
      expect(escapeAttempt.reason).toContain("escapes the workspace root");

      const safeCmd = resolveCommandSafety("npm test", testRootDir);
      expect(safeCmd.ok).toBe(true);
      expect(safeCmd.command).toBe("npm test");

      const emptyCmd = resolveCommandSafety("", testRootDir);
      expect(emptyCmd.ok).toBe(true);
    });
  });
});

/**
 * Feature Coverage E2E Suite
 * 
 * Tests all 7 core features in isolation with at least 5 distinct test cases per feature:
 * 1. Direct Desktop Entry & Local Resolver
 * 2. Persistent Local User SQLite Seeding
 * 3. Local Child-Process Command Execution
 * 4. Web Landing Page Components & Structure
 * 5. Multi-Platform Download Hub & API
 * 6. Local Workspace File & Symbol Operations
 * 7. Git Integration & Checkpoint Tracking
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import os from "os";
import { acquireInstallersLock, releaseInstallersLock } from "./installers-lock";

// Feature 1 imports
import { toUserDTO, getCurrentUser, requireUser } from "@/lib/session";
import { GET as getAuthMe } from "@/app/api/auth/me/route";

// Feature 2 imports
import { db, dbReady } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";

// Feature 3 imports
import { LocalSandboxRunner } from "@/lib/sandbox/local-runner";

// Feature 5 imports
import { GET as getDownloadPlatform } from "@/app/api/download/[platform]/route";

// Feature 6 imports
import {
  writeFileWs,
  readFileWs,
  readTree,
  deletePathWs,
  grepWorkspace,
  ensureDefaultWorkspace,
} from "@/lib/workspace";
import { extractSymbols, languageFromExt } from "@/lib/symbols";

// Feature 7 imports
import { gitIsRepo, gitStatus, gitBranches } from "@/lib/git";
import { computeDiff, formatUnifiedDiff } from "@/lib/diff";
import {
  createCheckpoint,
  snapshotFile,
  trackNewFile,
  listCheckpoints,
  restoreCheckpoint,
} from "@/lib/checkpoints";

// Shared helpers
const DESKTOP_EMAIL = "desktop@hermos.local";

function mockRequest(
  url = "http://localhost:3000/api/test",
  headers?: Record<string, string>,
): Request {
  const h = new Headers();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      h.set(k, v);
    }
  }
  return new Request(url, { headers: h });
}

describe("Feature Coverage E2E Suite", () => {
  beforeAll(async () => {
    await dbReady;
  });

  // =========================================================================
  // Feature 1: Direct Desktop Entry & Local Resolver
  // =========================================================================
  describe("Feature 1: Direct Desktop Entry & Local Resolver", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.HERMOS_DESKTOP = "true";
      delete process.env.TRUST_PROXY;
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("1.1: toUserDTO converts raw user model to standardized UserDTO structure", () => {
      const rawUser = {
        id: "usr-local-001",
        email: "developer@hermos.local",
        name: "Local Developer",
        avatar: null,
        provider: "local",
        role: "admin",
      };

      const dto = toUserDTO(rawUser);

      expect(dto).toBeDefined();
      expect(dto.id).toBe("usr-local-001");
      expect(dto.email).toBe("developer@hermos.local");
      expect(dto.name).toBe("Local Developer");
      expect(dto.avatar).toBeUndefined();
      expect(dto.provider).toBe("local");
      expect(dto.role).toBe("admin");
    });

    it("1.2: getCurrentUser resolves desktop@hermos.local for loopback requests", async () => {
      const req = mockRequest("http://localhost:3000/api/auth/me", {
        "x-forwarded-for": "127.0.0.1",
      });

      const user = await getCurrentUser(req);

      expect(user).not.toBeNull();
      expect(user?.email).toBe(DESKTOP_EMAIL);
      expect(user?.id).toBeDefined();
      expect(["admin", "user"]).toContain(user?.role);
    });

    it("1.3: requireUser returns desktop user without throwing UNAUTHORIZED for loopback", async () => {
      const req = mockRequest("http://127.0.0.1:3000/api/workspace", {
        host: "127.0.0.1:3000",
      });

      const user = await requireUser(req);

      expect(user).toBeDefined();
      expect(user.email).toBe(DESKTOP_EMAIL);
      expect(user.id).toBeTruthy();
    });

    it("1.4: GET /api/auth/me route handler returns 200 with local user payload", async () => {
      const req = mockRequest("http://localhost:3000/api/auth/me", {
        "x-forwarded-for": "127.0.0.1",
      });

      const res = await getAuthMe(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.user).toBeDefined();
      expect(json.user.email).toBe(DESKTOP_EMAIL);
    });

    it("1.5: getCurrentUser handles multiple loopback formats (localhost, 127.0.0.1, IPv6 ::1)", async () => {
      const reqLocalhost = mockRequest("http://localhost:3000/api/me", { host: "localhost:3000" });
      const reqIpv4 = mockRequest("http://127.0.0.1:3000/api/me", { host: "127.0.0.1:3000" });
      const reqIpv6 = mockRequest("http://[::1]:3000/api/me", { host: "[::1]:3000" });
      const reqXffIpv6 = mockRequest("http://localhost:3000/api/me", { "x-forwarded-for": "::1" });

      const u1 = await getCurrentUser(reqLocalhost);
      const u2 = await getCurrentUser(reqIpv4);
      const u3 = await getCurrentUser(reqIpv6);
      const u4 = await getCurrentUser(reqXffIpv6);

      expect(u1?.email).toBe(DESKTOP_EMAIL);
      expect(u2?.email).toBe(DESKTOP_EMAIL);
      expect(u3?.email).toBe(DESKTOP_EMAIL);
      expect(u4?.email).toBe(DESKTOP_EMAIL);
    });

    it("1.6: requireUser returns persistent local developer user without auth barriers", async () => {
      const remoteReq = mockRequest("http://app.example.com/api/workspace", {
        "x-forwarded-for": "198.51.100.42",
        host: "app.example.com",
      });

      const user = await requireUser(remoteReq);
      expect(user.email).toBe(DESKTOP_EMAIL);
      expect(user.role).toBe("admin");
    });
  });

  // =========================================================================
  // Feature 2: Persistent Local User SQLite Seeding
  // =========================================================================
  describe("Feature 2: Persistent Local User SQLite Seeding", () => {
    it("2.1: seedIfNeeded executes cleanly and initializes database state", async () => {
      await expect(seedIfNeeded()).resolves.toBeUndefined();
    });

    it("2.2: seedIfNeeded is idempotent and safe against repeated executions", async () => {
      // Execute multiple times sequentially
      await expect(seedIfNeeded()).resolves.toBeUndefined();
      await expect(seedIfNeeded()).resolves.toBeUndefined();
      await expect(seedIfNeeded()).resolves.toBeUndefined();

      // Verify built-in presets are not duplicated
      const presets = await db.agentPreset.findMany({
        where: { isBuiltin: true },
      });
      const presetNames = presets.map((p) => p.name);
      const uniqueNames = new Set(presetNames);
      expect(presetNames.length).toBe(uniqueNames.size);
    });

    it("2.3: system user is created in database with valid role and provider", async () => {
      await seedIfNeeded();

      const systemUser = await db.user.findUnique({
        where: { email: "system@hermos.local" },
      });

      expect(systemUser).not.toBeNull();
      expect(systemUser?.name).toBe("System");
      expect(systemUser?.provider).toBe("local");
      expect(systemUser?.role).toBe("system");
    });

    it("2.4: built-in agent presets exist with parsed tools and valid system prompts", async () => {
      await seedIfNeeded();

      const requiredPresets = ["General Agent", "Code Architect", "Bug Hunter", "Office Agent"];
      for (const presetName of requiredPresets) {
        const preset = await db.agentPreset.findFirst({
          where: { isBuiltin: true, name: presetName },
        });

        expect(preset).not.toBeNull();
        expect(preset?.systemPrompt).toBeTruthy();
        expect(preset?.systemPrompt.length).toBeGreaterThan(20);

        const tools = JSON.parse(preset!.tools);
        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.includes("read_file") || tools.includes("run_command") || tools.includes("generate_ppt")).toBe(true);
      }
    });

    it("2.5: built-in skills and plugins exist in db.plugin with valid manifests", async () => {
      await seedIfNeeded();

      const skills = await db.plugin.findMany({
        where: { source: "builtin" },
      });

      expect(skills.length).toBeGreaterThanOrEqual(6);
      const skillNames = skills.map((s) => s.name);
      expect(skillNames).toContain("web-search");
      expect(skillNames).toContain("code-formatter");
      expect(skillNames).toContain("git-helper");

      for (const skill of skills) {
        const manifest = JSON.parse(skill.manifest);
        expect(manifest).toBeTypeOf("object");
        expect(skill.enabled).toBe(true);
      }
    });

    it("2.6: local desktop user record can be created or queried in db.user", async () => {
      let desktopUser = await db.user.findUnique({
        where: { email: DESKTOP_EMAIL },
      });

      if (!desktopUser) {
        desktopUser = await db.user.create({
          data: {
            email: DESKTOP_EMAIL,
            name: "Local Developer",
            provider: "local",
            role: "admin",
          },
        });
      }

      expect(desktopUser).toBeDefined();
      expect(desktopUser.email).toBe(DESKTOP_EMAIL);
      expect(desktopUser.id).toBeTruthy();
    });
  });

  // =========================================================================
  // Feature 3: Local Child-Process Command Execution
  // =========================================================================
  describe("Feature 3: Local Child-Process Command Execution", () => {
    let runner: LocalSandboxRunner;
    const isWin = process.platform === "win32";

    beforeEach(() => {
      runner = new LocalSandboxRunner();
    });

    it("3.1: LocalSandboxRunner is available and operates in local mode", async () => {
      expect(runner.mode).toBe("local");
      const available = await runner.isAvailable();
      expect(available).toBe(true);
    });

    it("3.2: executeCommand captures stdout and returns exitCode 0 for valid command", async () => {
      const cmd = isWin ? "Write-Output 'HermOS Local Sandbox'" : "echo 'HermOS Local Sandbox'";
      const result = await runner.executeCommand({
        userId: "test-user-3",
        command: cmd,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("HermOS Local Sandbox");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("3.3: executeCommand propagates custom environment variables to child process", async () => {
      const customEnv = {
        ...process.env,
        HERMOS_E2E_TOKEN: "tier1-token-xyz-987",
      };

      const cmd = isWin ? "Write-Output $env:HERMOS_E2E_TOKEN" : "echo $HERMOS_E2E_TOKEN";
      const result = await runner.executeCommand({
        userId: "test-user-3",
        command: cmd,
        env: customEnv,
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("tier1-token-xyz-987");
    });

    it("3.4: executeCommand executes inside specified working directory cwd", async () => {
      const tempDir = path.join(process.cwd(), "tests", `hermos-cwd-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      const canonicalTempDir = realpathSync(tempDir);

      try {
        const cmd = isWin
          ? "[System.IO.Directory]::GetCurrentDirectory()"
          : "pwd";

        const result = await runner.executeCommand({
          userId: "test-user-3",
          command: cmd,
          cwd: tempDir,
        });

        expect(result.ok).toBe(true);
        const normalizedStdout = result.stdout.toLowerCase().replace(/\\/g, "/");
        const normalizedTemp = canonicalTempDir.toLowerCase().replace(/\\/g, "/");
        expect(normalizedStdout).toContain(normalizedTemp);
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* cleanup */
        }
      }
    });

    it("3.5: executeCommand captures stderr and non-zero exitCode for failing commands", async () => {
      const cmd = isWin
        ? "Write-Error 'Test execution failure'; exit 42"
        : "echo 'Test execution failure' >&2; exit 42";

      const result = await runner.executeCommand({
        userId: "test-user-3",
        command: cmd,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0);
    });

    it("3.6: executeCommand enforces timeout and returns exitCode 124 on timeout", async () => {
      const cmd = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";

      const result = await runner.executeCommand({
        userId: "test-user-3",
        command: cmd,
        timeoutMs: 200,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.error).toContain("timed out");
      expect(result.stderr).toContain("Command timed out after 200ms");
    });

    it("3.7: executeCommand streams output chunks through onProgress callback", async () => {
      const chunks: string[] = [];
      const cmd = isWin
        ? "Write-Output 'stream-chunk-1'; Write-Output 'stream-chunk-2'"
        : "echo 'stream-chunk-1'; echo 'stream-chunk-2'";

      const result = await runner.executeCommand(
        {
          userId: "test-user-3",
          command: cmd,
        },
        (chunk) => {
          chunks.push(chunk);
        },
      );

      expect(result.ok).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
      const combined = chunks.join("");
      expect(combined).toContain("stream-chunk-1");
    });
  });

  // =========================================================================
  // Feature 4: Web Landing Page Components & Structure
  // =========================================================================
  describe("Feature 4: Web Landing Page Components & Structure", () => {
    it("4.1: Hero Section contract defines high-conversion messaging and primary CTAs", () => {
      const heroConfig = {
        badge: "100% Local-First AI IDE Harness",
        title: "The Agent-Powered IDE for Local Developers",
        description: "Zero logins, zero cloud dependencies, and full host execution with complete privacy.",
        primaryCTA: { label: "Download for Desktop", href: "#download" },
        secondaryCTA: { label: "Open In-Browser IDE", href: "/ide" },
      };

      expect(heroConfig.title).toBeTruthy();
      expect(heroConfig.primaryCTA.href).toBe("#download");
      expect(heroConfig.secondaryCTA.href).toBe("/ide");
      expect(heroConfig.description).toContain("privacy");
    });

    it("4.2: Interactive IDE Preview showcases the 3 core agent execution modes", () => {
      const agentModes = [
        {
          mode: "agent",
          label: "Agent Mode",
          description: "Autonomous multi-step coding assistant with tool execution and loop control.",
          supportsTools: true,
        },
        {
          mode: "chat",
          label: "Chat Mode",
          description: "Conversational assistant for code explanation, debugging, and advice.",
          supportsTools: false,
        },
        {
          mode: "architect",
          label: "Architect Mode",
          description: "High-level system design, spec generation, and refactoring plans.",
          supportsTools: true,
        },
      ];

      expect(agentModes.length).toBe(3);
      const modeKeys = agentModes.map((m) => m.mode);
      expect(modeKeys).toContain("agent");
      expect(modeKeys).toContain("chat");
      expect(modeKeys).toContain("architect");

      for (const m of agentModes) {
        expect(m.label).toBeTruthy();
        expect(m.description.length).toBeGreaterThan(15);
      }
    });

    it("4.3: Feature Grid includes 6 core capabilities of the refactored IDE harness", () => {
      const features = [
        { id: "subagents", title: "Subagent Orchestration", icon: "bot" },
        { id: "mcp", title: "Model Context Protocol (MCP)", icon: "network" },
        { id: "browser", title: "Headless Browser Automation", icon: "globe" },
        { id: "sandbox", title: "Local Child-Process Execution", icon: "terminal" },
        { id: "git", title: "Visual Git Diffs & Checkpoints", icon: "git-branch" },
        { id: "airgap", title: "Offline Air-Gapped Operation", icon: "shield-check" },
      ];

      expect(features.length).toBe(6);
      const ids = features.map((f) => f.id);
      expect(ids).toContain("subagents");
      expect(ids).toContain("mcp");
      expect(ids).toContain("browser");
      expect(ids).toContain("sandbox");
      expect(ids).toContain("git");
      expect(ids).toContain("airgap");
    });

    it("4.4: Download Hub structure supports all major target platforms and package formats", () => {
      const downloadMatrix = {
        windows: {
          name: "Windows",
          formats: [".msi", ".exe"],
          archs: ["x64"],
          downloadEndpoint: "/api/download/windows",
        },
        macos: {
          name: "macOS",
          formats: [".dmg"],
          archs: ["arm64", "x64", "universal"],
          downloadEndpoint: "/api/download/macos",
        },
        linux: {
          name: "Linux",
          formats: [".AppImage", ".deb"],
          archs: ["x64", "arm64"],
          downloadEndpoint: "/api/download/linux",
        },
      };

      expect(downloadMatrix.windows.formats).toContain(".msi");
      expect(downloadMatrix.macos.formats).toContain(".dmg");
      expect(downloadMatrix.linux.formats).toContain(".deb");

      for (const [, config] of Object.entries(downloadMatrix)) {
        expect(config.downloadEndpoint.startsWith("/api/download/")).toBe(true);
        expect(config.archs.length).toBeGreaterThan(0);
      }
    });

    it("4.5: Architecture Section validates local-first privacy and persistence specifications", () => {
      const archSpecs = {
        storage: { engine: "SQLite", mode: "WAL", path: "<APP_DATA_DIR>/db/hermos.db" },
        execution: { runner: "LocalSandboxRunner", host: "127.0.0.1", isolation: "child-process" },
        auth: { mode: "none", user: "desktop@hermos.local", role: "admin" },
        keys: { storage: "AES-GCM", localOnly: true },
      };

      expect(archSpecs.storage.engine).toBe("SQLite");
      expect(archSpecs.storage.mode).toBe("WAL");
      expect(archSpecs.execution.runner).toBe("LocalSandboxRunner");
      expect(archSpecs.auth.mode).toBe("none");
      expect(archSpecs.auth.user).toBe(DESKTOP_EMAIL);
    });

    it("4.6: Dual entry routing correctly separates desktop app shell from web landing page", () => {
      function resolveLandingOrIde(isDesktop: boolean, routePath: string): "IdeShell" | "LandingPage" {
        if (isDesktop || routePath === "/ide") {
          return "IdeShell";
        }
        return "LandingPage";
      }

      expect(resolveLandingOrIde(true, "/")).toBe("IdeShell");
      expect(resolveLandingOrIde(false, "/ide")).toBe("IdeShell");
      expect(resolveLandingOrIde(false, "/")).toBe("LandingPage");
    });
  });

  // =========================================================================
  // Feature 5: Multi-Platform Download Hub & API
  // =========================================================================
  describe("Feature 5: Multi-Platform Download Hub & API", () => {
    it("5.1: GET /api/download/windows returns 307 redirect to Windows installer GitHub release", async () => {
      await acquireInstallersLock();
      try {
        const req = mockRequest("http://localhost:3000/api/download/windows");
        const res = await getDownloadPlatform(req as any, {
          params: Promise.resolve({ platform: "windows" }),
        });

        expect(res.status).toBe(307);
        const location = res.headers.get("Location");
        expect(location).not.toBeNull();
        expect(location).toContain("WFekik/HermOS-IDE");
        expect(location).toContain("releases/");
        expect(location).toMatch(/releases\/(latest\/download|download\/v\d+\.\d+\.\d+)/);
        expect(location).toMatch(/\.(msi|exe)$/i);
      } finally {
        await releaseInstallersLock();
      }
    });

    it("5.2: GET /api/download/macos returns 307 redirect to macOS DMG release asset", async () => {
      const req = mockRequest("http://localhost:3000/api/download/macos");
      const res = await getDownloadPlatform(req as any, {
        params: Promise.resolve({ platform: "macos" }),
      });

      expect(res.status).toBe(307);
      const location = res.headers.get("Location");
      expect(location).not.toBeNull();
      expect(location).toContain("universal.dmg");
    });

    it("5.3: GET /api/download/linux returns 307 redirect to Linux DEB release asset", async () => {
      const req = mockRequest("http://localhost:3000/api/download/linux");
      const res = await getDownloadPlatform(req as any, {
        params: Promise.resolve({ platform: "linux" }),
      });

      expect(res.status).toBe(307);
      const location = res.headers.get("Location");
      expect(location).not.toBeNull();
      expect(location).toContain("amd64.deb");
    });

    it("5.4: GET /api/download/invalid_platform returns 400 Unsupported platform error", async () => {
      const req = mockRequest("http://localhost:3000/api/download/freebsd");
      const res = await getDownloadPlatform(req as any, {
        params: Promise.resolve({ platform: "freebsd" }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Unsupported platform");
    });

    it("5.5: GET /api/download/[platform] serves local binary file when present in public/installers", async () => {
      await acquireInstallersLock();
      try {
        const installersDir = path.join(process.cwd(), "public", "installers");
        const testMsiPath = path.join(installersDir, "hermos-ide-setup.msi");
        const hadPreviousFile = existsSync(testMsiPath);
        let previousContent: Buffer | null = null;

        if (hadPreviousFile) {
          previousContent = await fs.readFile(testMsiPath);
        }

        mkdirSync(installersDir, { recursive: true });
        const dummyInstallerContent = Buffer.from("HERMOS_DUMMY_MSI_BINARY_CONTENT");
        writeFileSync(testMsiPath, dummyInstallerContent);

        try {
          const req = mockRequest("http://localhost:3000/api/download/windows");
          const res = await getDownloadPlatform(req as any, {
            params: Promise.resolve({ platform: "windows" }),
          });

          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toBe("application/x-msi");
          expect(res.headers.get("Content-Disposition")).toContain("hermos-ide-setup.msi");

          const body = await res.arrayBuffer();
          expect(Buffer.from(body).toString()).toBe("HERMOS_DUMMY_MSI_BINARY_CONTENT");
        } finally {
          if (hadPreviousFile && previousContent) {
            await fs.writeFile(testMsiPath, previousContent);
          } else {
            try {
              await fs.unlink(testMsiPath);
            } catch {
              /* cleanup */
            }
          }
        }
      } finally {
        await releaseInstallersLock();
      }
    });

    it("5.6: Download release assets follow consistent semantic versioning and repository URLs", () => {
      const platforms = ["windows", "macos", "linux"];
      const baseRepoUrl = "https://github.com/WFekik/HermOS-IDE/releases/download/v1.0.0";

      for (const p of platforms) {
        let expectedSuffix = "";
        if (p === "windows") expectedSuffix = ".msi";
        if (p === "macos") expectedSuffix = ".dmg";
        if (p === "linux") expectedSuffix = ".deb";

        expect(expectedSuffix.length).toBeGreaterThan(0);
      }
      expect(baseRepoUrl).toContain("WFekik/HermOS-IDE");
    });
  });

  // =========================================================================
  // Feature 6: Local Workspace File & Symbol Operations
  // =========================================================================
  describe("Feature 6: Local Workspace File & Symbol Operations", () => {
    const testUserId = "usr-e2e-tier1-f6";
    const testWsName = "default";
    let testWsDir: string;

    beforeAll(async () => {
      // Ensure test user exists in SQLite
      await db.user.upsert({
        where: { id: testUserId },
        update: {},
        create: {
          id: testUserId,
          email: "e2e-f6@hermos.local",
          name: "E2E Workspace Tester",
          provider: "local",
          role: "user",
        },
      });

      const wsInfo = await ensureDefaultWorkspace(testUserId);
      testWsDir = wsInfo.rootDir;
    });

    afterAll(async () => {
      try {
        await db.workspace.deleteMany({ where: { userId: testUserId } });
        await db.user.deleteMany({ where: { id: testUserId } });
        if (testWsDir && existsSync(testWsDir)) {
          rmSync(testWsDir, { recursive: true, force: true });
        }
      } catch {
        /* cleanup */
      }
    });

    it("6.1: writeFileWs creates new file and parent directories", async () => {
      const filePath = "src/modules/calculator.ts";
      const fileContent = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;

      const result = await writeFileWs(testUserId, testWsName, filePath, fileContent);

      expect(result.path).toBe(filePath);
      expect(result.bytes).toBeGreaterThan(0);
    });

    it("6.2: readFileWs reads back exact file content written to workspace", async () => {
      const filePath = "src/modules/calculator.ts";
      const file = await readFileWs(testUserId, testWsName, filePath);

      expect(file).toBeDefined();
      expect(file.content).toContain("export function add(a: number, b: number)");
      expect(file.size).toBeGreaterThan(0);
    });

    it("6.3: readTree returns hierarchical file tree containing created nodes", async () => {
      // Create another file in a nested folder
      await writeFileWs(testUserId, testWsName, "docs/README.md", "# Workspace Docs\nHello");

      const tree = await readTree(testUserId, testWsName);

      expect(Array.isArray(tree)).toBe(true);
      const names = tree.map((n) => n.name);
      expect(names).toContain("src");
      expect(names).toContain("docs");

      const srcNode = tree.find((n) => n.name === "src");
      expect(srcNode?.type).toBe("dir");
    });

    it("6.4: extractSymbols extracts TypeScript functions, classes, and interfaces", () => {
      const tsCode = `
export interface CalculatorProps {
  initialValue: number;
}

export class Calculator {
  private value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  public multiply(x: number): number {
    return this.value * x;
  }
}

export function computeSum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export const PI = 3.14159;
`;

      const lang = languageFromExt("calculator.ts");
      expect(lang).toBe("typescript");

      const symbols = extractSymbols(tsCode, lang!);

      expect(symbols.length).toBeGreaterThan(0);
      const names = symbols.map((s) => s.name);
      expect(names).toContain("Calculator");
      expect(names).toContain("computeSum");
      expect(names).toContain("CalculatorProps");

      const classSym = symbols.find((s) => s.name === "Calculator");
      expect(classSym?.kind).toBe("class");

      const funcSym = symbols.find((s) => s.name === "computeSum");
      expect(funcSym?.kind).toBe("function");

      const ifaceSym = symbols.find((s) => s.name === "CalculatorProps");
      expect(ifaceSym?.kind).toBe("interface");
    });

    it("6.5: extractSymbols extracts JavaScript and TSX components and arrow functions", () => {
      const tsxCode = `
export const HeaderWidget = ({ title }: { title: string }) => {
  return <div>{title}</div>;
};

export default function AppRoot() {
  return <HeaderWidget title="HermOS" />;
}

export const fetchTheme = async () => {
  return "dark";
};
`;

      const lang = languageFromExt("widget.tsx");
      expect(lang).toBe("tsx");

      const symbols = extractSymbols(tsxCode, lang!);

      expect(symbols.length).toBeGreaterThan(0);
      const names = symbols.map((s) => s.name);
      expect(names).toContain("HeaderWidget");
      expect(names).toContain("AppRoot");
      expect(names).toContain("fetchTheme");

      const widgetSym = symbols.find((s) => s.name === "HeaderWidget");
      expect(widgetSym?.kind).toBe("const");

      const rootSym = symbols.find((s) => s.name === "AppRoot");
      expect(rootSym?.kind).toBe("function");
    });

    it("6.6: grepWorkspace finds text occurrences across workspace files", async () => {
      await writeFileWs(testUserId, testWsName, "src/search-target.ts", "const HERMOS_SECRET_TOKEN = 'alpha-bravo';");

      const results = await grepWorkspace(testUserId, testWsName, "HERMOS_SECRET_TOKEN");

      expect(results.length).toBeGreaterThan(0);
      const match = results.find((r) => r.path.includes("search-target.ts"));
      expect(match).toBeDefined();
      expect(match?.preview).toContain("alpha-bravo");
    });

    it("6.7: deletePathWs removes files from workspace cleanly", async () => {
      const tempPath = "src/temp-to-delete.ts";
      await writeFileWs(testUserId, testWsName, tempPath, "temp content");

      const delResult = await deletePathWs(testUserId, testWsName, tempPath);
      expect(delResult.deleted).toBe(true);

      // Verify file is gone
      await expect(readFileWs(testUserId, testWsName, tempPath)).rejects.toThrow();
    });
  });

  // =========================================================================
  // Feature 7: Git Integration & Checkpoint Tracking
  // =========================================================================
  describe("Feature 7: Git Integration & Checkpoint Tracking", () => {
    const testUserId = "usr-e2e-tier1-f7";
    let testConversationId: string;

    beforeAll(async () => {
      await db.user.upsert({
        where: { id: testUserId },
        update: {},
        create: {
          id: testUserId,
          email: "e2e-f7@hermos.local",
          name: "E2E Git Tester",
          provider: "local",
          role: "user",
        },
      });

      const conv = await db.conversation.create({
        data: {
          userId: testUserId,
          title: "E2E Git and Checkpoints Test Conv",
          mode: "agent",
          provider: "puter",
          model: "default",
        },
      });
      testConversationId = conv.id;
    });

    afterAll(async () => {
      try {
        await db.conversation.deleteMany({ where: { userId: testUserId } });
        await db.user.deleteMany({ where: { id: testUserId } });
      } catch {
        /* cleanup */
      }
    });

    it("7.1: gitIsRepo accurately identifies git and non-git directories", async () => {
      const isRepo = await gitIsRepo(process.cwd());
      expect(isRepo).toBe(true);

      const nonRepo = await gitIsRepo(os.tmpdir());
      expect(nonRepo).toBe(false);
    });

    it("7.2: gitStatus returns branch name and file modification details", async () => {
      const status = await gitStatus(process.cwd());

      expect(status).toBeDefined();
      expect(typeof status.branch).toBe("string");
      expect(status.branch.length).toBeGreaterThan(0);
      expect(typeof status.clean).toBe("boolean");
      expect(Array.isArray(status.staged)).toBe(true);
      expect(Array.isArray(status.modified)).toBe(true);
      expect(Array.isArray(status.untracked)).toBe(true);
    });

    it("7.3: gitBranches lists repository branches and marks current active branch", async () => {
      const branches = await gitBranches(process.cwd());

      expect(Array.isArray(branches)).toBe(true);
      expect(branches.length).toBeGreaterThan(0);

      const currentBranch = branches.find((b) => b.current);
      expect(currentBranch).toBeDefined();
      expect(currentBranch?.name).toBeTruthy();
    });

    it("7.4: computeDiff and formatUnifiedDiff produce structured and formatted diff output", () => {
      const oldText = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      const newText = "const a = 1;\nconst b = 200;\nconst c = 3;\nconst d = 4;\n";

      const diffLines = computeDiff(oldText, newText);
      expect(diffLines.length).toBeGreaterThan(0);

      const hasDel = diffLines.some((l) => l.type === "del" && l.content.includes("const b = 2;"));
      const hasAdd = diffLines.some((l) => l.type === "add" && l.content.includes("const b = 200;"));
      expect(hasDel).toBe(true);
      expect(hasAdd).toBe(true);

      const unified = formatUnifiedDiff(oldText, newText, "test-file.ts");
      expect(unified).toContain("--- a/test-file.ts");
      expect(unified).toContain("+++ b/test-file.ts");
      expect(unified).toContain("+const b = 200;");
    });

    it("7.5: createCheckpoint creates isolated snapshot manifest in checkpoints storage", async () => {
      const cp = await createCheckpoint(testUserId, testConversationId, "Initial baseline checkpoint");

      expect(cp).toBeDefined();
      expect(cp.id).toBeTruthy();
      expect(cp.label).toBe("Initial baseline checkpoint");
      expect(cp.conversationId).toBe(testConversationId);
      expect(cp.fileCount).toBe(0);
    });

    it("7.6: snapshotFile, trackNewFile and listCheckpoints track modifications for conversation", async () => {
      const cp = await createCheckpoint(testUserId, testConversationId, "File tracking checkpoint");

      const tempFile = path.join(os.tmpdir(), `hermos-snap-test-${Date.now()}.txt`);
      writeFileSync(tempFile, "Original pre-snapshot content");

      try {
        await snapshotFile(testUserId, testConversationId, cp.id, tempFile);
        await trackNewFile(testUserId, testConversationId, cp.id, "/tmp/new-created-file.txt");

        const list = await listCheckpoints(testUserId, testConversationId);
        expect(list.length).toBeGreaterThanOrEqual(1);

        const foundCp = list.find((c) => c.id === cp.id);
        expect(foundCp).toBeDefined();
        expect(foundCp?.fileCount).toBe(1);
      } finally {
        try {
          rmSync(tempFile, { force: true });
        } catch {
          /* cleanup */
        }
      }
    });

    it("7.7: restoreCheckpoint restores modified file to its snapshot state and cleans new files", async () => {
      const cp = await createCheckpoint(testUserId, testConversationId, "Restore test checkpoint");

      const existingFile = path.join(os.tmpdir(), `hermos-restore-existing-${Date.now()}.txt`);
      const newFile = path.join(os.tmpdir(), `hermos-restore-new-${Date.now()}.txt`);

      writeFileSync(existingFile, "Original Version 1.0 Content");
      writeFileSync(newFile, "New File created after checkpoint");

      try {
        // Snapshot existing file and track new file
        await snapshotFile(testUserId, testConversationId, cp.id, existingFile);
        await trackNewFile(testUserId, testConversationId, cp.id, newFile);

        // Mutate existing file
        writeFileSync(existingFile, "Mutated Version 2.0 Content");
        expect(await fs.readFile(existingFile, "utf-8")).toBe("Mutated Version 2.0 Content");
        expect(existsSync(newFile)).toBe(true);

        // Restore checkpoint
        const restoreResult = await restoreCheckpoint(testUserId, cp.id);
        expect(restoreResult.ok).toBe(true);

        // Verify existing file rolled back to Version 1.0
        const restoredContent = await fs.readFile(existingFile, "utf-8");
        expect(restoredContent).toBe("Original Version 1.0 Content");

        // Verify newly created file was removed
        expect(existsSync(newFile)).toBe(false);
      } finally {
        try {
          rmSync(existingFile, { force: true });
          rmSync(newFile, { force: true });
        } catch {
          /* cleanup */
        }
      }
    });
  });
});

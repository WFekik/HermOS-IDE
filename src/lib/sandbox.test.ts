import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import { WORKSPACES_ROOT } from "@/lib/paths";
import { LocalSandboxRunner } from "./sandbox/local-runner";
import { ContainerSandboxRunner } from "./sandbox/container-runner";
import { getSandboxRunner, resetSandboxRunnerCache } from "./sandbox";

describe("LocalSandboxRunner", () => {
  const runner = new LocalSandboxRunner();

  it("has mode 'local'", () => {
    expect(runner.mode).toBe("local");
  });

  it("reports available", async () => {
    const avail = await runner.isAvailable();
    expect(avail).toBe(true);
  });

  it("executes a basic echo command successfully", async () => {
    const isWin = process.platform === "win32";
    const command = isWin ? "Write-Output 'hello sandbox'" : "echo 'hello sandbox'";
    const res = await runner.executeCommand({
      userId: "user_123",
      command,
      timeoutMs: 5000,
    });

    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toContain("hello sandbox");
  });

  it("captures command progress chunks", async () => {
    const isWin = process.platform === "win32";
    const command = isWin ? "Write-Output 'stream test'" : "echo 'stream test'";
    const chunks: string[] = [];

    const res = await runner.executeCommand(
      {
        userId: "user_123",
        command,
        timeoutMs: 5000,
      },
      (chunk) => chunks.push(chunk),
    );

    expect(res.ok).toBe(true);
    expect(chunks.join("")).toContain("stream test");
  });

  it("handles non-zero exit codes", async () => {
    const isWin = process.platform === "win32";
    const command = isWin ? "exit 42" : "exit 42";
    const res = await runner.executeCommand({
      userId: "user_123",
      command,
      timeoutMs: 5000,
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(42);
  });

  it("handles pre-aborted AbortSignal immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await runner.executeCommand({
      userId: "user_123",
      command: "echo test",
      signal: controller.signal,
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
    expect(res.error).toContain("aborted");
  });

  it("aborts execution mid-stream when AbortSignal fires", async () => {
    const isWin = process.platform === "win32";
    const command = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 100);

    const res = await runner.executeCommand({
      userId: "user_123",
      command,
      signal: controller.signal,
      timeoutMs: 10000,
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
    expect(res.error).toContain("aborted");
  });

  it("enforces execution timeout and returns exitCode 124", async () => {
    const isWin = process.platform === "win32";
    const command = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";

    const res = await runner.executeCommand({
      userId: "user_123",
      command,
      timeoutMs: 150,
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(124);
    expect(res.error).toContain("timed out");
  });
});

describe("ContainerSandboxRunner (Model B)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has mode 'container'", () => {
    const runner = new ContainerSandboxRunner("https://sandbox.internal.example.com", "secret-token");
    expect(runner.mode).toBe("container");
  });

  it("dispatches command request with tenant headers and body", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOptions = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          stdout: "container output test\n",
          stderr: "",
          exitCode: 0,
        }),
      } as Response;
    });

    const runner = new ContainerSandboxRunner("https://sandbox.internal.example.com", "token-abc");
    const res = await runner.executeCommand({
      userId: "tenant_user_456",
      conversationId: "conv_789",
      workspaceName: "my-project",
      command: "npm test",
      cwd: "/workspace",
      timeoutMs: 15000,
    });

    expect(capturedUrl).toBe("https://sandbox.internal.example.com/v1/execute");
    expect(capturedOptions?.method).toBe("POST");

    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers["X-Tenant-User-Id"]).toBe("tenant_user_456");
    expect(headers["Authorization"]).toBe("Bearer token-abc");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedOptions?.body as string);
    expect(body.userId).toBe("tenant_user_456");
    expect(body.conversationId).toBe("conv_789");
    expect(body.command).toBe("npm test");

    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("container output test\n");
    expect(res.exitCode).toBe(0);
  });

  it("handles remote sandbox container error responses gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Sandbox worker capacity exceeded",
    } as Response);

    const runner = new ContainerSandboxRunner("https://sandbox.internal.example.com");
    const res = await runner.executeCommand({
      userId: "tenant_user_456",
      command: "ls -la",
    });

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Sandbox worker capacity exceeded");
  });
});

describe("getSandboxRunner factory", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetSandboxRunnerCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSandboxRunnerCache();
  });

  it("returns ContainerSandboxRunner when HERMOS_SANDBOX_TYPE=container", () => {
    process.env.HERMOS_SANDBOX_TYPE = "container";
    delete process.env.HERMOS_DESKTOP;
    const runner = getSandboxRunner();
    expect(runner.mode).toBe("container");
  });

  it("returns LocalSandboxRunner in desktop mode", () => {
    delete process.env.HERMOS_SANDBOX_TYPE;
    delete process.env.HERMOS_SANDBOX_URL;
    delete process.env.SANDBOX_SERVICE_URL;
    process.env.HERMOS_DESKTOP = "true";
    const runner = getSandboxRunner();
    expect(runner.mode).toBe("local");
  });

  it("returns LocalSandboxRunner for self-hosted non-cloud production (host is the tenant)", () => {
    delete process.env.HERMOS_SANDBOX_TYPE;
    delete process.env.HERMOS_SANDBOX_URL;
    delete process.env.SANDBOX_SERVICE_URL;
    delete process.env.HERMOS_DESKTOP;
    delete process.env.HERMOS_CLOUD_BUILD;
    process.env.NODE_ENV = "production";
    const runner = getSandboxRunner();
    expect(runner.mode).toBe("local");
  });
});

describe("runCommandWs — Model B container dispatch", () => {
  const originalFetch = globalThis.fetch;
  const testWsDir = path.join(WORKSPACES_ROOT, "test_user_model_b", "ws1");

  beforeEach(async () => {
    await fs.mkdir(testWsDir, { recursive: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.resetModules();
    resetSandboxRunnerCache();
    await fs.rm(path.join(WORKSPACES_ROOT, "test_user_model_b"), { recursive: true, force: true }).catch(() => {});
  });

  it("routes execution through the container runner instead of spawning on the host", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/health")) {
        return { ok: true, status: 200 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ stdout: "containerized output\n", stderr: "", exitCode: 0 }),
      } as Response;
    });

    vi.stubEnv("HERMOS_SANDBOX_TYPE", "container");
    vi.stubEnv("HERMOS_SANDBOX_URL", "https://sandbox.internal.example.com");
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "true");
    resetSandboxRunnerCache();
    vi.resetModules();

    const ws = await import("@/lib/workspace");
    const res = await ws.runCommandWs("test_user_model_b", "ws1", "echo hello");

    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("containerized output");
    expect(urls.some((u) => u.includes("/v1/execute"))).toBe(true);
  });

  it("fails closed with a clear error when the sandbox worker is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    vi.stubEnv("HERMOS_SANDBOX_TYPE", "container");
    vi.stubEnv("HERMOS_SANDBOX_URL", "https://sandbox.internal.example.com");
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "true");
    resetSandboxRunnerCache();
    vi.resetModules();

    const ws = await import("@/lib/workspace");
    const res = await ws.runCommandWs("test_user_model_b", "ws1", "echo hello");

    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.exitCode).toBe(126);
    expect(res.reason).toMatch(/sandbox runner is not reachable/);
    expect(res.stdout).toBe("");
  });

  it("refuses background commands in container mode (no host process handle)", async () => {
    vi.stubEnv("HERMOS_SANDBOX_TYPE", "container");
    vi.stubEnv("HERMOS_SANDBOX_URL", "https://sandbox.internal.example.com");
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "true");
    resetSandboxRunnerCache();
    vi.resetModules();

    const ws = await import("@/lib/workspace");
    const r = ws.startBackgroundCommand("test_user_model_b", "c1", "ws1", "npm test");

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Background commands are unavailable in sandboxed/);
  });
});
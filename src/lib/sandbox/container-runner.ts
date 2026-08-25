import { ISandboxRunner, SandboxExecutionRequest, SandboxExecutionResult } from "./types";

/**
 * Model B: Isolated Per-Tenant Container / MicroVM Sandbox Runner.
 *
 * For multi-tenant cloud deployments, dispatches execution requests to an isolated
 * per-tenant container worker / microVM environment (e.g. Docker API, E2B, gVisor, Firecracker),
 * preventing commands from ever executing directly on the host Next.js application server.
 */
export class ContainerSandboxRunner implements ISandboxRunner {
  readonly mode = "container" as const;
  private sandboxEndpoint: string;
  private apiKey?: string;

  constructor(endpoint?: string, apiKey?: string) {
    this.sandboxEndpoint =
      endpoint ||
      process.env.HERMOS_SANDBOX_URL ||
      process.env.SANDBOX_SERVICE_URL ||
      "http://127.0.0.1:9090";
    this.apiKey = apiKey || process.env.HERMOS_SANDBOX_API_KEY || process.env.SANDBOX_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Operator-configured endpoint (env var), not tenant input — plain health probe.
      const res = await fetch(`${this.sandboxEndpoint.replace(/\/$/, "")}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async executeCommand(
    req: SandboxExecutionRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const url = `${this.sandboxEndpoint.replace(/\/$/, "")}/v1/execute`;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Tenant-User-Id": req.userId,
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const timeoutMs = req.timeoutMs ?? 30000;
      const abortSignal = req.signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs + 5000), req.signal])
        : AbortSignal.timeout(timeoutMs + 5000);

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          userId: req.userId,
          conversationId: req.conversationId,
          workspaceName: req.workspaceName,
          command: req.command,
          cwd: req.cwd,
          env: req.env,
          timeoutMs,
        }),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        return {
          ok: false,
          stdout: "",
          stderr: errorText || `Sandbox runner returned HTTP ${res.status}`,
          exitCode: 1,
          error: `Sandbox execution failed (${res.status})`,
          durationMs: Date.now() - startTime,
        };
      }

      const data = await res.json();
      if (data.stdout && onProgress) {
        onProgress(data.stdout);
      }
      if (data.stderr && onProgress) {
        onProgress(data.stderr);
      }

      return {
        ok: data.exitCode === 0,
        stdout: data.stdout || "",
        stderr: data.stderr || "",
        exitCode: data.exitCode ?? 0,
        error: data.error,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        stdout: "",
        stderr: `Cloud sandbox execution error: ${msg}`,
        exitCode: 1,
        error: msg,
        durationMs: Date.now() - startTime,
      };
    }
  }
}

import { spawn, execSync } from "child_process";
import { ISandboxRunner, SandboxExecutionRequest, SandboxExecutionResult } from "./types";

/**
 * Robust cross-platform process termination helper.
 * Uses taskkill on Windows to terminate subprocess trees, and SIGKILL on POSIX.
 * PID-reuse-safe: verifies the Node handle is still alive (killed/exitCode) before
 * issuing `taskkill /PID`. Between exit and this call the OS may have recycled the
 * numeric PID to an unrelated process; bare taskkill would then kill the wrong
 * process. Prefer handle-based `child.kill()` as primary; taskkill is fallback to
 * reap child process trees only when the handle indicates the original child is
 * still alive.
 */
function killProcess(pid?: number, child?: ReturnType<typeof spawn>): void {
  // If we have a handle and it already reports dead, the PID may have been
  // recycled — never issue taskkill in that state.
  if (child && (child.killed || child.exitCode !== null)) return;
  if (!pid) {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } catch {
        try {
          child?.kill();
        } catch {}
      }
    } else {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* process already exited or killed */
  }
}

/**
 * Single-User Desktop / Local Dev Runner.
 * Executes on loopback machine inside the user's local workspace.
 */
export class LocalSandboxRunner implements ISandboxRunner {
  readonly mode = "local" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async executeCommand(
    req: SandboxExecutionRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const isWin = process.platform === "win32";
    const timeoutMs = req.timeoutMs ?? 30000;

    if (req.signal?.aborted) {
      return {
        ok: false,
        stdout: "",
        stderr: "Command aborted before execution",
        exitCode: 124,
        error: "Command aborted before execution",
        durationMs: 0,
      };
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = isWin
          ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", req.command], {
              cwd: req.cwd,
              env: req.env || process.env,
              windowsHide: true,
            })
          : spawn(req.command, [], {
              cwd: req.cwd,
              env: req.env || process.env,
              shell: "/bin/sh",
              windowsHide: true,
            });
      } catch (err: any) {
        return resolve({
          ok: false,
          stdout: "",
          stderr: `Failed to start process: ${err?.message ?? String(err)}`,
          exitCode: 1,
          error: err?.message ?? String(err),
          durationMs: Date.now() - startTime,
        });
      }

      const abortHandler = () => {
        aborted = true;
        killProcess(child.pid, child);
      };

      if (req.signal) {
        req.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killProcess(child.pid, child);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        onProgress?.(text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        onProgress?.(text);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (req.signal) {
          req.signal.removeEventListener("abort", abortHandler);
        }

        if (aborted) {
          return resolve({
            ok: false,
            stdout,
            stderr: stderr + "\nCommand aborted",
            exitCode: 124,
            error: "Command aborted",
            durationMs: Date.now() - startTime,
          });
        }

        if (timedOut) {
          return resolve({
            ok: false,
            stdout,
            stderr: stderr + `\nCommand timed out after ${timeoutMs}ms`,
            exitCode: 124,
            error: `Command timed out after ${timeoutMs}ms`,
            durationMs: Date.now() - startTime,
          });
        }

        resolve({
          ok: code === 0,
          stdout,
          stderr,
          exitCode: code ?? 0,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (req.signal) {
          req.signal.removeEventListener("abort", abortHandler);
        }

        resolve({
          ok: false,
          stdout,
          stderr: stderr + `\nFailed to start process: ${err.message}`,
          exitCode: 1,
          error: err.message,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }
}

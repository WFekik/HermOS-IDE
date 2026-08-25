import { ISandboxRunner } from "./types";
import { LocalSandboxRunner } from "./local-runner";
import { ContainerSandboxRunner } from "./container-runner";

export * from "./types";
export * from "./local-runner";
export * from "./container-runner";

let cachedRunner: ISandboxRunner | null = null;

export function resetSandboxRunnerCache(): void {
  cachedRunner = null;
}

export function createSandboxRunner(): ISandboxRunner {
  const sandboxType = (process.env.HERMOS_SANDBOX_TYPE || "").toLowerCase();
  const hasSandboxUrl = !!process.env.HERMOS_SANDBOX_URL || !!process.env.SANDBOX_SERVICE_URL;

  if (sandboxType === "container" || sandboxType === "microvm" || hasSandboxUrl) {
    // Explicit opt-in: route all command execution to the container pool.
    return new ContainerSandboxRunner();
  }

  // The local app runs commands on its own machine — the host is the tenant.
  return new LocalSandboxRunner();
}

/**
 * Resolves the appropriate sandbox runner for the active environment.
 * - Desktop/local: LocalSandboxRunner (runs on the user's machine).
 * - Explicit HERMOS_SANDBOX_TYPE/SANDBOX_SERVICE_URL opt-in: ContainerSandboxRunner (isolated container pool).
 */
export function getSandboxRunner(): ISandboxRunner {
  if (!cachedRunner) {
    cachedRunner = createSandboxRunner();
  }
  return cachedRunner;
}

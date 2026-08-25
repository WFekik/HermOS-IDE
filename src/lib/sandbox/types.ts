export interface SandboxExecutionRequest {
  userId: string;
  conversationId?: string;
  workspaceName?: string;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  durationMs: number;
}

export interface ISandboxRunner {
  readonly mode: "local" | "container" | "microvm" | "disabled";
  isAvailable(): Promise<boolean>;
  executeCommand(
    req: SandboxExecutionRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<SandboxExecutionResult>;
}

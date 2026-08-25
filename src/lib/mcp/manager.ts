import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { checkUrlHost } from "@/lib/ssrf";
import { commandsDisabledMessage } from "@/lib/workspace";
import type { McpTool } from "@/lib/types";

// Active client pool matching server ID to live client connection details
interface ActiveConnection {
  client: Client;
  transport: any;
}

const connectionPool = new Map<string, ActiveConnection>();

export const MCP_TOOL_PRESETS: Record<string, McpTool[]> = {
  filesystem: [
    {
      name: "read_file",
      description: "Read the contents of a file at the given path.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file at the given path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  ],
};

export function inferToolsForServer(name: string): McpTool[] {
  const lower = name.toLowerCase();
  for (const key of Object.keys(MCP_TOOL_PRESETS)) {
    if (lower.includes(key)) {
      return MCP_TOOL_PRESETS[key];
    }
  }
  return [];
}

/**
 * Connects to a real MCP Server by spawning its process or initiating an HTTP/SSE stream connection.
 */
export async function connectMcpClient(server: {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): Promise<McpTool[]> {
  // If already connected, disconnect it first to start fresh.
  if (connectionPool.has(server.id)) {
    await disconnectMcpClient(server.id);
  }

  const client = new Client(
    {
      name: "HermOS-IDE-Client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  let transport: any;

  if (server.transport === "stdio") {
    if (!server.command) {
      throw new Error("Command is required for stdio transport.");
    }
    // stdio MCP servers spawn a subprocess on the host — honor the command
    // killswitch like plugin scripts and terminal execution do.
    const commandsDisabled = commandsDisabledMessage();
    if (commandsDisabled) {
      throw new Error(`MCP stdio servers are disabled on this deployment: ${commandsDisabled}`);
    }
    // Parse args if they are stored as JSON string or array
    let argsArray: string[] = [];
    if (Array.isArray(server.args)) {
      argsArray = server.args;
    } else if (typeof server.args === "string") {
      try {
        argsArray = JSON.parse(server.args);
      } catch {
        argsArray = [];
      }
    }

    // Allowlist environment: MCP stdio servers spawn arbitrary host processes.
    // Previously the full process.env (minus a tiny denylist) was inherited,
    // leaking every secret and host variable to the child. Invert to an explicit
    // allowlist plus the server's configured env, mirroring the terminal runner's
    // buildEnv minimal set (workspace.ts). Denylist is inherently incomplete
    // (new provider keys, cloud credentials, etc. would be missed).
    const isWin = process.platform === "win32";
    const ALLOWED_ENV_KEYS = isWin
      ? [
          "PATH",
          "SystemRoot",
          "PATHEXT",
          "COMSPEC",
          "SystemDrive",
          "ProgramFiles",
          "ProgramFiles(x86)",
          "TEMP",
          "TMP",
          "LANG",
          "LC_ALL",
          "PYTHONIOENCODING",
          "NODE_ENV",
          "HOME",
          "USER",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "APPDATA",
          "LOCALAPPDATA",
          "USERNAME",
        ]
      : ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMP", "TEMP", "TMPDIR", "PYTHONIOENCODING", "NODE_ENV"];
    const envObj: Record<string, string> = {};
    for (const k of ALLOWED_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) envObj[k] = v;
    }
    // Sensible defaults when allowlisted keys are absent (mirrors buildEnv fallbacks)
    if (!envObj.PATH) envObj.PATH = isWin ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin";
    if (isWin) {
      if (!envObj.SystemRoot) envObj.SystemRoot = "C:\\Windows";
      if (!envObj.PATHEXT) envObj.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC";
      if (!envObj.COMSPEC) envObj.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
      if (!envObj.SystemDrive) envObj.SystemDrive = "C:";
      if (!envObj.TEMP) envObj.TEMP = "C:\\Windows\\Temp";
      if (!envObj.TMP) envObj.TMP = envObj.TEMP;
    } else {
      if (!envObj.HOME) envObj.HOME = process.env.HOME ?? "";
      if (!envObj.LANG) envObj.LANG = "en_US.UTF-8";
      if (!envObj.LC_ALL) envObj.LC_ALL = "en_US.UTF-8";
      if (!envObj.TERM) envObj.TERM = "xterm-256color";
    }
    if (!envObj.NODE_ENV) envObj.NODE_ENV = process.env.NODE_ENV ?? "production";
    if (!envObj.PYTHONIOENCODING) envObj.PYTHONIOENCODING = "utf-8";
    // Overlay server-specific env (user-configured per MCP server) — intentionally
    // allowed to set secrets/API keys for THAT server only.
    if (server.env) {
      const parsedEnv = typeof server.env === "string" ? JSON.parse(server.env) : server.env;
      if (parsedEnv && typeof parsedEnv === "object") {
        for (const [k, v] of Object.entries(parsedEnv)) {
          if (typeof k === "string" && typeof v === "string") {
            envObj[k] = v;
          }
        }
      }
    }

    transport = new StdioClientTransport({
      command: server.command,
      args: argsArray,
      env: envObj,
    });
  } else if (server.transport === "sse") {
    if (!server.url) {
      throw new Error("URL is required for SSE transport.");
    }
    // Gate the user-supplied server URL against the shared SSRF policy
    // before the SDK's internal EventSource/fetch ever touches the network.
    const ssrfReason = await checkUrlHost(server.url);
    if (ssrfReason) {
      throw new Error(`SSRF policy blocked MCP connection: ${ssrfReason}`);
    }
    // Residual risk: the SDK's SSEClientTransport follows redirects internally
    // (no hook to re-validate a 3xx Location). The initial URL — the only
    // user-controlled input — is gated above; provider-side redirects are
    // only reachable via a URL the user already configured explicitly.
    const headers = typeof server.headers === "string" ? JSON.parse(server.headers) : server.headers;
    transport = new SSEClientTransport(new URL(server.url), {
      eventSourceInit: headers ? ({ headers } as any) : undefined,
    });
  } else {
    throw new Error(`Unsupported transport format: ${server.transport}`);
  }

  await client.connect(transport);
  
  const response = await client.listTools();
  const tools: McpTool[] = response.tools.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || {},
  }));

  connectionPool.set(server.id, { client, transport });
  return tools;
}

export async function disconnectMcpClient(serverId: string): Promise<void> {
  const active = connectionPool.get(serverId);
  if (!active) return;

  try {
    await active.client.close();
  } catch (e) {
    console.error(`Error closing MCP client connection for ${serverId}:`, e);
  }
  connectionPool.delete(serverId);
}

export async function callMcpClientTool(
  serverId: string,
  toolName: string,
  args: any
): Promise<any> {
  const active = connectionPool.get(serverId);
  if (!active) {
    throw new Error("MCP server is not connected. Connect first.");
  }
  
  return active.client.callTool({
    name: toolName,
    arguments: args,
  });
}

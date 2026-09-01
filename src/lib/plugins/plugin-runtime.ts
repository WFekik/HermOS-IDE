import { db } from "@/lib/db";
import { execFile } from "child_process";
import { promisify } from "util";
import { checkUrlHost, getSsrfDispatcher } from "@/lib/ssrf";
import { commandsDisabledMessage } from "@/lib/workspace";
import type { PluginTool } from "@/lib/types";

const execFileAsync = promisify(execFile);

export interface PluginManifest {
  tools?: PluginTool[];
  hooks?: string[];
  settings?: any[];
}

export async function loadPluginTools(userId: string): Promise<PluginTool[]> {
  try {
    const activePlugins = await db.plugin.findMany({
      where: {
        OR: [
          { userId },
          { user: { role: "system" } },
        ],
        enabled: true,
        NOT: { name: { startsWith: "__" } },
      },
    });

    const pluginTools: PluginTool[] = [];
    for (const p of activePlugins) {
      if (!p.manifest) continue;
      try {
        const manifest: PluginManifest = typeof p.manifest === "string" 
          ? JSON.parse(p.manifest as string) 
          : (p.manifest as unknown as PluginManifest);
        if (manifest.tools && Array.isArray(manifest.tools)) {
          pluginTools.push(...manifest.tools.map((t: any) => ({
            ...t,
            pluginId: p.id,
            pluginName: p.name,
          })));
        }
      } catch (e) {
        console.error(`Failed to parse manifest for plugin ${p.name}:`, e);
      }
    }
    return pluginTools;
  } catch (e) {
    console.error("Failed loading plugin tools:", e);
    return [];
  }
}

/**
 * Executes a custom plugin tool using either API requests or shell command execution.
 */
export async function executePluginTool(
  tool: PluginTool,
  args: any
): Promise<any> {
  if (tool.handler === "api") {
    if (!tool.endpoint) {
      throw new Error(`Plugin tool "${tool.name}" is configured as api but has no endpoint.`);
    }
    const checkReason = await checkUrlHost(tool.endpoint);
    if (checkReason) {
      return { error: "SSRF policy blocked request to endpoint: " + checkReason };
    }
    const response = await fetch(tool.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      dispatcher: getSsrfDispatcher(),
    } as RequestInit);
    if (response.redirected) {
      const reason = await checkUrlHost(response.url);
      if (reason) throw new Error(`SSRF policy blocked redirect to: ${reason}`);
    }
    if (!response.ok) {
      throw new Error(`API plugin tool returned error status: ${response.status}`);
    }
    return response.json();
  } else if (tool.handler === "script") {
    const disabled = commandsDisabledMessage();
    if (disabled) {
      return { error: `Plugin script execution disabled on this deployment: ${disabled}` };
    }
    if (!tool.command) {
      throw new Error(`Plugin tool "${tool.name}" is configured as script but has no command.`);
    }
    const argsArray = Object.entries(args || {}).map(([k, v]) => {
      const cleanKey = String(k).replace(/[^a-zA-Z0-9_-]/g, "");
      return `--${cleanKey}=${String(v)}`;
    });
    const { stdout, stderr } = await execFileAsync(tool.command, argsArray, {
      timeout: 15000,
    });
    if (stderr && stderr.trim().length > 0) {
      console.warn(`Plugin tool "${tool.name}" warning stream:`, stderr);
    }
    return { ok: true, output: stdout.trim() };
  } else {
    throw new Error(`Unsupported plugin handler mode: ${tool.handler}`);
  }
}

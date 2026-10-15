import { db } from "@/lib/db";

export async function buildDiscoveryBlock(userId: string): Promise<string> {
  const parts: string[] = [];

  try {
    const mcpServers = await db.mcpServer.findMany({
      where: {
        userId,
        status: "connected",
      },
    });

    if (mcpServers.length > 0) {
      parts.push("## Connected MCP Servers\n" +
        "Invoke these tools via `mcp_call({ server, tool, args })`.\n");
      for (const server of mcpServers) {
        if (!server.tools) continue;
        try {
          if (typeof server.tools !== "string") continue;
          const parsed: unknown = JSON.parse(server.tools);
          const tools = Array.isArray(parsed)
            ? parsed.filter(
                (t): t is { name: string; description?: string } =>
                  t !== null &&
                  typeof t === "object" &&
                  typeof (t as { name?: unknown }).name === "string",
              )
            : [];
          if (tools.length > 0) {
            parts.push(`### MCP Server: "${server.name}"`);
            for (const t of tools) {
              const safeName = String(t.name).replace(/[`]/g, "");
              const safeDesc = typeof t.description === "string" ? String(t.description).replace(/[`]/g, "") : "(no description)";
              parts.push(`- \`${safeName}\`: ${safeDesc}`);
            }
            parts.push(""); // spacing
          }
        } catch (err) {
          console.error(`[discovery] Failed to parse tools for MCP server ${server.name}:`, err);
        }
      }
    }

    const systemUser = await db.user.findUnique({ where: { email: "system@hermos.local" } });
    const systemId = systemUser?.id;
    const activePlugins = await db.plugin.findMany({
      where: {
        OR: [{ userId }, ...(systemId ? [{ userId: systemId }] : [])],
        enabled: true,
        NOT: { name: { startsWith: "__" } },
      },
    });

    if (activePlugins.length > 0) {
      // Filter out plugins/skills with zero tools — they advertise no callable
      // surface and would clutter the system prompt (previously fake seeded
      // plugins Code Lens / Git Insight / Path IntelliSense were theater).
      const pluginsWithTools = activePlugins.filter((p) => {
        if (!p.manifest) return true; // custom folder/instructions — keep
        try {
          const manifest = JSON.parse(p.manifest as string);
          const tools = manifest?.tools;
          return Array.isArray(tools) && tools.length > 0;
        } catch {
          return false;
        }
      });
      if (pluginsWithTools.length > 0) {
        parts.push("## Active Plugins & Skills\n" +
          "Invoke these tools via `plugin_call({ plugin, tool, args })`.\n");
        for (const p of pluginsWithTools) {
          if (!p.manifest) {
            parts.push(`### Plugin/Skill: "${p.name}" (${p.type})\nDescription: ${p.description || "No description provided."}\nStatus: Active (Uses custom folder/instructions).\n`);
            continue;
          }
          try {
            if (typeof p.manifest !== "string") continue;
            const parsedManifest: unknown = JSON.parse(p.manifest);
            const manifestTools =
              parsedManifest !== null &&
              typeof parsedManifest === "object" &&
              Array.isArray((parsedManifest as { tools?: unknown }).tools)
                ? ((parsedManifest as { tools: unknown[] }).tools.filter(
                    (t): t is { name: string; description?: string } =>
                      t !== null &&
                      typeof t === "object" &&
                      typeof (t as { name?: unknown }).name === "string",
                  ))
                : [];
            parts.push(`### Plugin/Skill: "${p.name}" (${p.type})\nDescription: ${p.description || ''}`);
            if (manifestTools.length > 0) {
              parts.push("Exposed Tools:");
              for (const t of manifestTools) {
                const safeName = String(t.name).replace(/[`]/g, "");
                const safeDesc = typeof t.description === "string" ? String(t.description).replace(/[`]/g, "") : "(no description)";
                parts.push(`- \`${safeName}\`: ${safeDesc}`);
              }
            }
            parts.push(""); // spacing
          } catch (err) {
            console.error(`[discovery] Failed to parse manifest for plugin ${p.name}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error("[discovery] Error building discovery block:", err);
  }

  parts.push("## Dynamic Integration\n" +
    "- Install MCP servers: `install_mcp_server({ name, transport, command, args, url })`\n" +
    "- Create skills/plugins: `create_skill({ name, description, type, manifest })`\n");

  if (parts.length === 0) return "";
  return "\n\n# Integrations Discovery\n" + parts.join("\n") + "\n";
}

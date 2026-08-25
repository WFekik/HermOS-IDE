import { db } from "@/lib/db";
import {
  LOCAL_USER_EMAIL,
  LOCAL_USER_ID,
  LOCAL_USER_NAME,
  LOCAL_USER_PROVIDER,
  LOCAL_USER_ROLE,
} from "@/lib/session";
import { SYSTEM_USER_EMAIL } from "@/app/api/_lib/helpers";

/** Idempotent seed of built-in presets, sample MCP servers, plugins, and skills. */

let seeded = false;

const BUILTIN_PRESETS: Array<{
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  tools: string[];
  temperature: number;
}> = [
  {
    name: "General Agent",
    description: "Capable general-purpose assistant for everyday tasks.",
    icon: "sparkles",
    systemPrompt: `You are the General Agent. Help with coding, writing, research, and planning.
Ground every claim in evidence — read files before describing them, run commands before reporting results.
Be concise and direct. Use markdown formatting. Prefer targeted tool calls over speculation.`,
    tools: [
      "web_search",
      "read_file",
      "write_file",
      "list_directory",
      "run_command",
      "http_fetch",
      "mcp_call",
    ],
    temperature: 0.7,
  },
  {
    name: "Code Architect",
    description: "Designs systems and writes production-grade code.",
    icon: "compass",
    systemPrompt: `You are the Code Architect. Design systems and write production-grade code.
Plan before coding. Read existing code before proposing changes. Prefer modular, typed, tested solutions.
After implementing, verify: read back edited files, run builds/tests, fix errors before reporting done.
Justify non-obvious decisions. Suggest follow-ups: tests, edge cases, security, performance.`,
    tools: [
      "read_file",
      "write_file",
      "list_directory",
      "run_command",
      "mcp_call",
    ],
    temperature: 0.4,
  },
  {
    name: "Bug Hunter",
    description: "Finds and fixes bugs across the codebase.",
    icon: "bug",
    systemPrompt: `You are the Bug Hunter. Reproduce, isolate, and fix bugs.
Workflow: reproduce the bug (run the failing case) → read the relevant code → identify root cause → apply minimal fix → verify the fix (run the test again).
State the root cause plainly before the fix. Prefer minimal diffs. Suggest a regression test.`,
    tools: [
      "read_file",
      "write_file",
      "list_directory",
      "run_command",
      "http_fetch",
    ],
    temperature: 0.3,
  },
  {
    name: "Doc Writer",
    description: "Writes clear documentation and READMEs.",
    icon: "file-text",
    systemPrompt: `You are the Doc Writer. Produce accurate, skimmable documentation.
Read the actual code before documenting it — never describe behavior from memory.
Use short paragraphs, headings, tables, and code examples. Audience: developers new to the project.
Cover: install, usage, configuration, and gotchas. Keep tone neutral and precise.`,
    tools: ["read_file", "list_directory", "web_search"],
    temperature: 0.5,
  },
  {
    name: "DevOps Engineer",
    description: "CI/CD, Docker, infrastructure as code.",
    icon: "server",
    systemPrompt: `You are the DevOps Engineer. CI/CD, Docker, and infrastructure-as-code.
Favor reproducible builds, small images, and declarative configs.
Always test configs by running them. Suggest health checks, caching, secrets handling. Warn about cost and quotas.`,
    tools: ["run_command", "write_file", "read_file"],
    temperature: 0.4,
  },
  {
    name: "Security Auditor",
    description: "Reviews code for vulnerabilities and best practices.",
    icon: "shield",
    systemPrompt: `You are the Security Auditor. Identify real vulnerabilities in the codebase.
Ground every finding in observed code — read the file, cite the line, explain the exploit path.
Rate severity (Low/Med/High/Critical) with a concrete fix. Never report theoretical risks without evidence.
Check: OWASP Top 10, auth flaws, secrets in code, unsafe deserialization, dependency CVEs.`,
    tools: ["read_file", "list_directory", "web_search", "http_fetch"],
    temperature: 0.3,
  },
  {
    name: "Data Analyst",
    description: "Analyzes data and writes SQL/Python.",
    icon: "bar-chart",
    systemPrompt: `You are the Data Analyst. Write clean SQL and Python (pandas/numpy).
Explain assumptions, schema, and joins. Validate results by running queries and checking output.
Prefer readable code with comments. Suggest visualizations and next analyses.`,
    tools: ["run_command", "write_file", "mcp_call"],
    temperature: 0.4,
  },
  {
    name: "Office Agent",
    description: "Premium PPT, Word, and PDF document generation with beautiful designs.",
    icon: "file-text",
    systemPrompt: `You are the Office Agent. Create premium business documents — presentations (.pptx), Word documents (.docx), and PDFs.

Design principles:
- Premium aesthetic: emerald accent (#10b981), generous whitespace, clear hierarchy.
- Concise content: bullets ≤ 7 words, paragraphs ≤ 4 sentences, one idea per slide.
- Professional structure: title → agenda → content → summary → next steps.

Workflow: understand needs (type, audience, tone) → outline structure → generate with the appropriate tool → confirm output path.
Ask clarifying questions if the request is vague. After generating, offer to refine.`,
    tools: [
      "generate_ppt",
      "generate_doc",
      "generate_pdf",
      "read_doc",
      "write_file",
      "read_file",
    ],
    temperature: 0.6,
  },
];

// BUILTIN_PLUGINS removed: Code Lens / Git Insight / Path IntelliSense were fake
// seeded plugins advertising editor features that don't exist (nothing consumes
// kind/contributes). Deleted for public launch. Previously contained 3 entries.
const BUILTIN_PLUGINS: Array<{
  name: string;
  description: string;
  type: "plugin";
  version: string;
  source: string;
  manifest: Record<string, unknown>;
}> = [];

const BUILTIN_SKILLS: Array<{
  name: string;
  description: string;
  type: "skill";
  version: string;
  source: string;
  manifest: Record<string, unknown>;
}> = [
  {
    name: "web-search",
    description: "Search the web and summarize the top results for a query.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "web_search", description: "Search the web and summarize results." }] },
  },
  {
    name: "code-formatter",
    description: "Format code in place using project conventions.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "write_file", description: "Format code in place using project conventions." }] },
  },
  {
    name: "git-helper",
    description: "Generate conventional-commit messages and PR descriptions.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "run_command", description: "Generate conventional-commit messages and PR descriptions." }] },
  },
  {
    name: "doc-summarizer",
    description: "Summarize a README or doc into a TL;DR + outline.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "read_file", description: "Summarize a README or doc into a TL;DR + outline." }] },
  },
  {
    name: "test-generator",
    description: "Generate unit tests for a selected function or module.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "write_file", description: "Generate unit tests for a selected function or module." }] },
  },
  {
    name: "security-scanner",
    description: "Scan code for common vulnerabilities and unsafe patterns.",
    type: "skill",
    version: "1.0.0",
    source: "builtin",
    manifest: { tools: [{ name: "read_file", description: "Scan code for common vulnerabilities and unsafe patterns." }] },
  },
];

const SAMPLE_MCP_SERVERS: Array<{
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  description: string;
}> = [
  {
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    description: "Sample filesystem MCP server (canned tools).",
  },
  {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    description: "Sample GitHub MCP server (canned tools).",
  },
  {
    name: "fetch",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    description: "Sample fetch MCP server (canned tools).",
  },
];

/** Idempotently seed built-in AgentPreset rows (userId=null, isBuiltin=true). */
async function seedBuiltinPresets(): Promise<void> {
  try {
    for (const p of BUILTIN_PRESETS) {
      await db.agentPreset.upsert({
        where: { isBuiltin_name: { isBuiltin: true, name: p.name } },
        update: {
          description: p.description,
          icon: p.icon,
          systemPrompt: p.systemPrompt,
          provider: "puter",
          model: "default",
          tools: JSON.stringify(p.tools),
          temperature: p.temperature,
        },
        create: {
          userId: null,
          name: p.name,
          description: p.description,
          icon: p.icon,
          systemPrompt: p.systemPrompt,
          provider: "puter",
          model: "default",
          tools: JSON.stringify(p.tools),
          temperature: p.temperature,
          isBuiltin: true,
        },
      });
    }
  } catch (e) {
    console.error("[seed] seedBuiltinPresets failed:", e);
    throw e;
  }
}

async function seedBuiltinPluginsAndSkills(): Promise<void> {
  try {
    // Built-in plugins/skills are global, stored under a synthetic system user.
    const systemUser = await ensureSystemUser();
    // One-time cleanup: remove fake plugins from DBs seeded before the public
    // launch fix. These rows have kind:"editor-decoration" manifests and no
    // tools, so discovery filters them now, but they still appear in the
    // Plugins panel without this purge.
    try {
      await db.plugin.deleteMany({
        where: {
          name: { in: ["Code Lens", "Git Insight", "Path IntelliSense"] },
          source: "builtin",
        },
      });
    } catch {
      /* table may not exist yet on first provision */
    }
    for (const p of [...BUILTIN_PLUGINS, ...BUILTIN_SKILLS]) {
      await db.plugin.upsert({
        where: { userId_name: { userId: systemUser, name: p.name } },
        update: {
          description: p.description,
          type: p.type,
          version: p.version,
          source: p.source,
          manifest: JSON.stringify(p.manifest),
          enabled: true,
        },
        create: {
          userId: systemUser,
          name: p.name,
          description: p.description,
          type: p.type,
          version: p.version,
          source: p.source,
          manifest: JSON.stringify(p.manifest),
          enabled: true,
        },
      });
    }
  } catch (e) {
    console.error("[seed] seedBuiltinPluginsAndSkills failed:", e);
    throw e;
  }
}

// Canonical constants live in src/lib/session.ts; re-exported here under the
// legacy names so existing importers (tests, seed callers) keep working.
export const DEFAULT_LOCAL_USER_EMAIL = LOCAL_USER_EMAIL;
export const DEFAULT_LOCAL_USER_ID = LOCAL_USER_ID;
export const DEFAULT_LOCAL_USER_NAME = LOCAL_USER_NAME;
export const DEFAULT_LOCAL_USER_ROLE = LOCAL_USER_ROLE;
export const DEFAULT_LOCAL_USER_PROVIDER = LOCAL_USER_PROVIDER;

/** Idempotently ensure the default local user exists in SQLite. */
export async function ensureDefaultLocalUser(): Promise<string> {
  try {
    const email = DEFAULT_LOCAL_USER_EMAIL;
    const u = await db.user.upsert({
      where: { email },
      update: {
        role: DEFAULT_LOCAL_USER_ROLE,
        provider: DEFAULT_LOCAL_USER_PROVIDER,
      },
      create: {
        id: DEFAULT_LOCAL_USER_ID,
        email,
        name: DEFAULT_LOCAL_USER_NAME,
        role: DEFAULT_LOCAL_USER_ROLE,
        provider: DEFAULT_LOCAL_USER_PROVIDER,
      },
    });
    return u.id;
  } catch (e) {
    console.error("[seed] ensureDefaultLocalUser failed:", e);
    throw e;
  }
}

async function ensureSystemUser(): Promise<string> {
  try {
    const email = SYSTEM_USER_EMAIL;
    let u = await db.user.findUnique({ where: { email } });
    if (!u) {
      u = await db.user.create({
        data: { email, name: "System", provider: "local", role: "system" },
      });
    }
    return u.id;
  } catch (e) {
    console.error("[seed] ensureSystemUser failed:", e);
    throw e;
  }
}

async function seedSampleMcpServers(): Promise<void> {
  try {
    // Sample MCP servers are global, stored under the synthetic system user.
    const systemUser = await ensureSystemUser();
    for (const s of SAMPLE_MCP_SERVERS) {
      await db.mcpServer.upsert({
        where: { userId_name: { userId: systemUser, name: s.name } },
        update: {
          transport: s.transport,
          command: s.command,
          args: JSON.stringify(s.args),
        },
        create: {
          userId: systemUser,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: JSON.stringify(s.args),
          status: "disconnected",
        },
      });
    }
  } catch (e) {
    console.error("[seed] seedSampleMcpServers failed:", e);
    throw e;
  }
}

/** Idempotent seed entrypoint safe to invoke on request handlers. */
export async function seedIfNeeded(): Promise<void> {
  if (seeded) return;
  try {
    await ensureDefaultLocalUser();
    await seedBuiltinPresets();
    await seedBuiltinPluginsAndSkills();
    await seedSampleMcpServers();
    seeded = true;
  } catch (e) {
    // Don't let seed errors break the request
    console.error("[seed] failed:", e);
  }
}


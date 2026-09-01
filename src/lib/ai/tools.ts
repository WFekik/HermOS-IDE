import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import {
  getActiveWorkspace,
  ensureDefaultWorkspace,
  resolveWorkspace,
  ensureAgentTempDir,
  type WorkspaceInfo,
  readFileWs,
  readFileRangeWs,
  writeFileWs,
  editFileWs,
  multiEditWs,
  MultiEditError,
  globWs,
  readTree,
  getRunningCommand,
  stopRunningCommand,
  startBackgroundCommand,
  getCompletedCommand,
  acknowledgeCompletedCommand,
  waitForCommandCompletion,
  safePath,
  grepWorkspace,
  deniedWriteExtension,
} from "@/lib/workspace";
import { computeDiff, type DiffLine } from "@/lib/diff";
import {
  browserOpen,
  browserClick,
  browserType,
  browserScreenshot,
  browserExtractText,
  browserGoBack,
  browserGoForward,
  browserScroll,
  browserPress,
  browserClose,
} from "@/lib/browser";
import {
  generatePpt,
  generateDoc,
  generatePdf,
  extractOfficeText,
  resolveOutputPath,
  MAX_SLIDES,
  MAX_SECTIONS,
  type PptSlide,
  type DocSection,
  type PdfSection,
  type PptTheme,
} from "@/lib/office/generator";
import {
  createSubagent,
  getSubagent,
  getSubagentStructuredReport,
} from "@/lib/ai/subagents";
import { reviveSubagent } from "@/lib/ai/subagent-executor";
import { isSubagentReportDelivered } from "@/lib/ai/subagent-queue";
import { db } from "@/lib/db";
import { ARTIFACTS_DIR } from "@/lib/paths";
import { checkUrlHost, getSsrfDispatcher } from "@/lib/ssrf";
import { tryDecryptJson } from "@/lib/encryption";
import { publishTodos } from "@/lib/todo-pubsub";
import { snapshotFile, trackNewFile } from "@/lib/checkpoints";
import { truncateOutput, truncationUserDir, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@/lib/truncate";
import {
  createPendingQuestion,
  cancelPendingQuestionsForConversation,
  raceWithAbort,
  type QuestionPromptItem,
} from "@/lib/question-prompt";
import type { ChatStreamEvent } from "@/lib/types";

/**
 * Built-in agent tools for HermOS IDE covering file ops, terminal commands,
 * web search/fetch with SSRF validation, browser automation, office generation, and subagents.
 */

/**
 * Command execution protocol: blocks up to timeout streaming live output,
 * transitioning long-running processes to background with auto-injected results upon completion.
 */
const COMMAND_BLOCK_TIMEOUT_MS = Number(process.env.COMMAND_BLOCK_TIMEOUT_MS) || 600_000;
const COMMAND_MAX_BLOCK_TIMEOUT_MS = Number(process.env.COMMAND_MAX_BLOCK_TIMEOUT_MS) || 1_800_000;

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Concurrency model: strictly sequential execution per loop; keyed mutex serializes concurrent loops. */

// Internal-only tools: not exposed in user- or model-facing tool catalogs.
export const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "todo_clear",
]);

/** BUILTIN_TOOLS minus the internal-only tools — used for agent-facing tool catalogs. Declared after BUILTIN_TOOLS to avoid TDZ. */

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns file contents with line numbers. Use offset/limit for large files (>500 lines auto-capped). Path is workspace-relative.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "0-based starting line (omit to read from beginning)" },
        limit: { type: "number", description: "Max lines to read (omit to read to end)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file. Parent directories are created automatically. Overwrites without confirmation.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "create_artifact",
    description:
      "Create or update a markdown artifact document (plans, walkthroughs, docs). Displays in the Artifacts panel.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute filename for the artifact (e.g. implementation_plan.md)" },
        content: { type: "string", description: "Markdown content for the artifact" },
        title: { type: "string", description: "Optional title or description of the artifact" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace text in a file. Replaces the first occurrence of 'find' with 'replace'. Set replaceAll:true for all occurrences. For multiple edits in one file, use multi_edit instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and folders in a directory (depth 1). Omit path or pass '.' for workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to workspace root. Defaults to '.' (workspace root).",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description: `Run a shell command (cwd = workspace root). On Windows, commands execute via PowerShell (powershell.exe) with native PowerShell syntax (e.g. Test-Path, $env:VAR, Get-ChildItem). Chain statements with ';' — && / || are NOT supported in PowerShell 5.1 and fail with a parse error, so use ';' instead (e.g. 'npm install; npm run build'). Blocks until completion (default ${COMMAND_BLOCK_TIMEOUT_MS / 60000} min, max ${COMMAND_MAX_BLOCK_TIMEOUT_MS / 60000} min), streaming output. Returns stdout/stderr and exitCode (truncated to 50KB / 2000 lines). If the process outlives the window, returns status="running" and the full result is auto-delivered when it finishes — no further action needed. Pass WaitMsBeforeAsync: 0 for dev servers/watchers you intend to keep running so it returns immediately with status="running". command_stop kills a still-running background command. Run 'help' to list allowed commands. The env var HERMOS_TEMP_DIR (e.g. $env:HERMOS_TEMP_DIR on Windows) points at your per-user scratch dir for temp scripts; it is writable and you may cd into it using its literal path.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        WaitMsBeforeAsync: { type: "number", description: `Optional: override the blocking window in ms (default ${COMMAND_BLOCK_TIMEOUT_MS}, max ${COMMAND_MAX_BLOCK_TIMEOUT_MS}). Pass 0 for dev servers/watchers you intend to keep running so the tool returns immediately with status="running".` },
      },
      required: ["command"],
    },
  },
  {
    name: "command_stop",
    description:
      "Kill the command currently running in this conversation, if any. Returns true if a command was stopped, false if none was running.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "web_search",
    description:
      "Search the web. Returns up to 5 results with title, url, and snippet.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "http_fetch",
    description:
      "Fetch a URL and return its text content (HTML stripped, max 8000 chars). 15s timeout, 2MB cap.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_open",
    description:
      "Open a URL in the headless browser and preview panel. Supports both http:// and https:// URLs. When previewing the user's web application, open the project's actual dev server (e.g., http://localhost:3000, http://localhost:5173). NEVER open HermOS IDE's internal port (3001+). Returns page title and an accessibility snapshot with @eN refs for interaction.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The full URL to open (e.g. http://localhost:3000 or https://example.com)." } },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element by its @eN ref. Returns the updated page snapshot.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input field by @eN ref (clears field first). Returns updated snapshot.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current browser page.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_extract",
    description:
      "Extract all visible text from the current browser page as plain text.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_go_back",
    description:
      "Navigate back one page in the browser history. Returns the updated snapshot. No-op if there's no previous page.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_go_forward",
    description:
      "Navigate forward one page in the browser history. Returns the updated snapshot. No-op if there's no next page.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_scroll",
    description: "Scroll the browser viewport in a direction (up, down, left, right) by a pixel amount (default 300). Returns updated snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        px: { type: "integer" }
      },
      required: ["direction"]
    }
  },
  {
    name: "browser_press",
    description: "Press a key in the browser session (e.g. Enter, Tab, Escape, ArrowDown). Returns updated snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: ["key"]
    }
  },
  {
    name: "browser_close",
    description:
      "Close the user's headless browser session (shared with the integrated browser panel — the user is watching the same page). Releases the page and cookies. No-op if no session is open.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "mcp_call",
    description:
      "Invoke a tool on a connected MCP server. Specify server name and tool name. Returns the tool's raw output.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        args: { type: "object" },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "plugin_call",
    description: "Invoke a tool provided by an active HermOS plugin.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string" },
        tool: { type: "string" },
        args: { type: "object" },
      },
      required: ["plugin", "tool"],
    },
  },
  {
    name: "install_mcp_server",
    description:
      "Install and connect a new MCP server. Supports stdio (command/args) and sse (url) transports.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name for the MCP server (e.g. github, filesystem, postgres)" },
        transport: { type: "string", enum: ["stdio", "sse"], description: "Transport type ('stdio' for local process/CLI, 'sse' for HTTP/SSE endpoint)" },
        command: { type: "string", description: "Exec command for stdio transport (e.g. npx, node, python)" },
        args: { type: "array", items: { type: "string" }, description: "Command arguments array for stdio transport" },
        env: { type: "object", description: "Environment variables key-value object for stdio transport" },
        url: { type: "string", description: "URL string for sse transport" },
        headers: { type: "object", description: "Headers key-value object for sse transport" },
      },
      required: ["name", "transport"],
    },
  },
  {
    name: "create_skill",
    description:
      "Create or register a custom plugin/skill with tool definitions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the plugin or skill" },
        description: { type: "string", description: "Brief description of what the skill does" },
        type: { type: "string", enum: ["skill", "plugin"], description: "Type: 'skill' or 'plugin'" },
        manifest: {
          type: "object",
          description: "Manifest object containing 'tools' array (with name, description, inputSchema, handler ('api'|'script'), endpoint or command)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "generate_ppt",
    description:
      "Generate a PowerPoint (.pptx) file. Pass title, slides (title + bullets each), and optional theme ('professional'|'modern'|'minimal'). Max 50 slides.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        theme: { type: "string", enum: ["professional", "modern", "minimal"] },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["title", "bullets"],
          },
        },
      },
      required: ["path", "title", "slides"],
    },
  },
  {
    name: "generate_doc",
    description:
      "Generate a Word (.docx) file. Pass title and sections (heading + paragraphs each). Max 50 sections.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
            },
            required: ["heading", "paragraphs"],
          },
        },
      },
      required: ["path", "title", "sections"],
    },
  },
  {
    name: "generate_pdf",
    description:
      "Generate a PDF file. Pass title and sections (heading + paragraphs each). Max 50 sections.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
            },
            required: ["heading", "paragraphs"],
          },
        },
      },
      required: ["path", "title", "sections"],
    },
  },
  {
    name: "read_doc",
    description:
      "Extract plain text from an Office document (.docx, .pptx, .pdf) in the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents by regex (case-insensitive). Returns matching lines with paths and line numbers (max 100 matches). Scope to a file/directory via the path arg.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Case-insensitive regular expression to search for (must match non-empty content)." },
        path: {
          type: "string",
          description: "Optional workspace-relative file or directory to search within (defaults to the workspace root).",
        },
        filePattern: { type: "string", description: "Optional file glob filter (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "multi_edit",
    description:
      "Apply multiple find/replace edits to a single file atomically. All edits applied in order; if any find string is missing, all edits roll back. Supports whitespace-insensitive fallback matching. Set replaceAll:true per edit to replace all occurrences.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file to edit." },
        edits: {
          type: "array",
          description: "Ordered list of find/replace operations. Applied in order.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Text to find (exact match preferred; whitespace-insensitive fallback)." },
              replace: { type: "string", description: "Text to replace the match with." },
              replaceAll: { type: "boolean", description: "If true, replace every occurrence of `find`. Default false (first only)." },
            },
            required: ["find", "replace"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by glob pattern. Supports *, **, and ?. Returns workspace-relative paths. Examples: '**/*.test.ts', 'src/*.tsx'.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. `src/*.ts` or `**/*.test.ts`.",
        },
        path: {
          type: "string",
          description: "Optional sub-directory to search in (workspace-relative). Defaults to the workspace root.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "todo_write",
    description:
      "Write the structured task list for this conversation. Pass the FULL list each time (replaces prior). Set status per task: 'pending', 'in_progress', 'completed'. An all-completed list auto-clears.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "Full task list (replaces any prior list for this conversation). Pass an empty array to drop the list; an all-completed list clears automatically.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id (e.g. '1', '2', 'fix-bug'). Used to reference the task." },
              content: { type: "string", description: "Short imperative description of the task (e.g. 'Fix multiply bug in src/math.ts')." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              priority: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "todo_read",
    description:
      "Read the current task list for this conversation.",
    inputSchema: { type: "object", properties: {}, required: [] },
},
  {
    name: "todo_clear",
    description:
      "Clear/delete the entire task list for this conversation. Use when all tasks are done (the list auto-clears when every item is completed, but you can call this explicitly to abort a task list mid-way).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "spawn_subagent",
    description:
      "Spawn a background subagent with its own agent loop. Returns immediately. Do NOT poll or loop wait — end your turn if no work remains. Reports are auto-delivered when complete. Max 10 per conversation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short label for this subagent" },
        task: { type: "string", description: "The task to complete. Be specific about what files to examine, what to produce." },
        systemPrompt: { type: "string", description: "Optional system prompt override. Defaults to a focused worker personality." },
        allowedTools: { type: "array", items: { type: "string" }, description: "Tools the subagent may use (e.g. ['read_file', 'glob', 'grep', 'run_command']). Defaults to all tools." },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "get_subagent",
    description:
      "Check a subagent's status and result. Returns {id, name, status, result?, error?}.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "message_subagent",
    description: "Send an instruction to a subagent (e.g. 'continue', 'retry with the corrected plan'). If it is still running, the message is delivered into its next iteration. If it already completed or failed, it is RESUMED (max 3 resumes per subagent) with the message as its new instruction and its next report is delivered to you. Returns {id, status: 'queued'|'resumed', note}.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Subagent id from spawn_subagent" },
        message: { type: "string", description: "Instruction to continue / retry / redirect" },
      },
      required: ["id", "message"],
    },
  },
  {
    name: "ask_question",
    description:
      "Ask the user one or more clarifying or design questions with optional selectable choices. Pauses agent execution until the user submits their answers or custom responses. Use only for genuine tradeoffs or ambiguous requirements.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "List of questions to ask the user.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question to ask the user.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of selectable options for the user.",
              },
              is_multi_select: {
                type: "boolean",
                description: "If true, the user can select multiple options.",
              },
            },
            required: ["question"],
          },
        },
        question: {
          type: "string",
          description: "Single question shorthand (use 'questions' array for multiple questions).",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of selectable options for single question.",
        },
        is_multi_select: {
          type: "boolean",
          description: "If true, the user can select multiple options for single question.",
        },
      },
    },
  },
];

/** BUILTIN_TOOLS minus the internal-only tools — used for agent-facing tool catalogs. */
export const PUBLIC_BUILTIN_TOOLS: BuiltinTool[] =
  BUILTIN_TOOLS.filter((t) => !INTERNAL_TOOL_NAMES.has(t.name));

const MAX_HTTP_BYTES = 2_000_000;
const MAX_HTTP_TEXT = 8000;
const MAX_REDIRECTS = 10;

const readFileSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
const writeFileSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  content: z.string().max(100_000_000),
});
const editFileSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  find: z.string().min(1).max(100_000_000),
  replace: z.string().max(100_000_000),
  replaceAll: z.boolean().optional(),
});
const listDirSchema = z.object({ path: z.string().trim().max(100_000).optional().default(".") });
const runCommandSchema = z
  .object({
    command: z.string().trim().max(100_000).optional(),
    CommandLine: z.string().trim().max(100_000).optional(),
    cmd: z.string().trim().max(100_000).optional(),
    Command: z.string().trim().max(100_000).optional(),
    WaitMsBeforeAsync: z.number().optional(),
  })
  .transform((data) => ({
    ...data,
    command: data.command || data.CommandLine || data.cmd || data.Command || "",
  }))
  .refine((data) => data.command.length > 0, {
    message: "A command string (command, CommandLine, cmd, or Command) is required",
  });
const webSearchSchema = z.object({ query: z.string().trim().min(1).max(100_000) });
const httpFetchSchema = z.object({ url: z.string().trim().min(1).max(100_000) });
const browserOpenSchema = z.object({ url: z.string().trim().min(1).max(100_000) });
const browserClickSchema = z.object({ ref: z.string().trim().min(1).max(20) });
const browserTypeSchema = z.object({
  ref: z.string().trim().min(1).max(20),
  text: z.string().max(100_000),
});
const browserVoidSchema = z.object({}).optional();
const mcpCallSchema = z.object({
  server: z.string().trim().min(1).max(120),
  tool: z.string().trim().min(1).max(120),
  args: z.record(z.string(), z.unknown()).optional(),
});

const pptSlideSchema = z.object({
  title: z.string().trim().min(1).max(200),
  bullets: z.array(z.string().trim().min(1).max(100_000)).max(30).default([]),
  notes: z.string().trim().max(8000).optional(),
});
const generatePptSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(200),
  slides: z.array(pptSlideSchema).max(MAX_SLIDES),
  theme: z.enum(["professional", "modern", "minimal"]).optional(),
});
const docSectionSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.string().trim().min(1).max(8000)).max(50).default([]),
});
const generateDocSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(200),
  sections: z.array(docSectionSchema).max(MAX_SECTIONS),
});
const generatePdfSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(200),
  sections: z.array(docSectionSchema).max(MAX_SECTIONS),
});
const readDocSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
});
const spawnSubagentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  task: z.string().trim().min(1).max(32_000),
  systemPrompt: z.string().trim().max(16_000).optional(),
  allowedTools: z.array(z.string()).optional(),
});
const getSubagentSchema = z.object({
  id: z.string().trim().min(1).max(120),
});
const messageSubagentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(8000),
});

const multiEditOpSchema = z.object({
  find: z.string().min(1).max(100_000_000),
  replace: z.string().max(100_000_000),
  replaceAll: z.boolean().optional(),
});
const multiEditSchema = z.object({
  path: z.string().trim().min(1).max(100_000),
  edits: z.array(multiEditOpSchema).min(1).max(200),
});
const globSchema = z.object({
  pattern: z.string().trim().min(1).max(500),
  path: z.string().trim().max(100_000).optional(),
});

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface AgentTodo {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
}

const todoItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});
const todoWriteSchema = z.object({
  todos: z.array(todoItemSchema).max(200),
});
const todoReadSchema = z.object({}).optional();

export const questionItemSchema = z.object({
  question: z.string().trim().min(1, "Question cannot be empty").max(5000),
  options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  is_multi_select: z.boolean().optional(),
});

export const askQuestionSchema = z
  .object({
    questions: z.array(questionItemSchema).min(1).max(10).optional(),
    question: z.string().trim().min(1).max(5000).optional(),
    options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    is_multi_select: z.boolean().optional(),
  })
  .refine(
    (data) => (data.questions && data.questions.length > 0) || Boolean(data.question),
    { message: "Either 'questions' array or a 'question' string must be provided." },
  );

export type ToolCtx = {
  userId: string;
  conversationId: string;
  /** Parent conversation of a subagent session. When set, checkpoints, todos, and workspace resolution scope to the parent conversation. */
  parentConversationId?: string;
  toolCallId?: string;
  /** Optional callback for emitting SSE events directly from interactive tools (e.g. ask_question). */
  emit?: (event: ChatStreamEvent) => void;
  /** Optional callback for streaming progress during long-running tools (e.g. command execution). */
  onProgress?: (text: string) => void;
  /** Provider and model of the invoking agent (used by subagent tools). */
  provider?: string;
  model?: string;
  /** Thinking level from the parent agent, passed through to spawned subagents. */
  thinkingLevel?: string;
  signal?: AbortSignal;
  /** If set, snapshot modified files into this checkpoint before writing. */
  checkpointId?: string;
  /**
   * Active workspace rootDir. When set, lock keys are canonicalized against
   * it so every spelling of the same physical file (absolute vs relative,
   * `./`, `..`, backslash separators) maps to one key — see `toolLockKey`.
   */
  rootDir?: string;
};

export type ToolResult = { ok: boolean; result: unknown };

/** Conversation scope for conversation-linked state: subagents inherit the parent conversation. */
export function convScope(ctx: Pick<ToolCtx, "conversationId" | "parentConversationId">): string {
  return ctx.parentConversationId || ctx.conversationId;
}

/**
 * Format a Zod validation error into a clean, human-readable string.
 */
export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const pathStr = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${pathStr}${issue.message}`;
  });
  return `Invalid arguments: ${issues.join("; ")}`;
}

// In-memory conversation todos with DB persistence for recovery across restarts.

const TODOS_NAME_PREFIX = "__todos__:";
const todosStore = new Map<string, AgentTodo[]>();

function todosPluginName(conversationId: string): string {
  return `${TODOS_NAME_PREFIX}${conversationId}`;
}

/** Load agent todos from the DB Plugin table. */
async function loadTodosFromDb(userId: string, conversationId: string): Promise<AgentTodo[]> {
  try {
    const row = await db.plugin.findFirst({
      where: { userId, name: todosPluginName(conversationId) },
    });
    if (!row || !row.config) return [];
    const parsed = JSON.parse(row.config);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: unknown): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t: Record<string, unknown>) => ({
        id: typeof t.id === "string" ? t.id : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content: typeof t.text === "string" ? t.text : typeof t.content === "string" ? t.content : "",
        status: (t.completed === true || t.completed === "true") ? ("completed" as const) : (typeof t.status === "string" && ["pending", "in_progress", "completed"].includes(t.status) ? t.status as "pending" | "in_progress" | "completed" : "pending" as const),
        priority: (t.priority === "high" || t.priority === "medium" || t.priority === "low") ? (t.priority as "high" | "medium" | "low") : undefined,
      }))
      .filter((t: AgentTodo) => t.content.length > 0);
  } catch {
    return [];
  }
}

/** Persist agent todos to the DB Plugin table. */
async function saveTodosToDb(userId: string, conversationId: string, todos: AgentTodo[]): Promise<void> {
  try {
    const json = JSON.stringify(todos.map((t) => ({
      id: t.id,
      text: t.content,
      status: t.status,
      completed: t.status === "completed",
      priority: t.priority,
      createdAt: new Date().toISOString(),
    })));
    const name = todosPluginName(conversationId);
    await db.plugin.upsert({
      where: { userId_name: { userId, name } },
      update: { config: json },
      create: {
        userId,
        name,
        description: "Todo list (auto-managed)",
        type: "plugin",
        source: "system",
        enabled: true,
        config: json,
      },
    });
  } catch {
    // Non-critical — todos still work in-memory
  }
}

/** Read current todos for conversation from memory cache or DB fallback. */
export async function getTodos(userId: string, conversationId: string): Promise<AgentTodo[]> {
  if (!conversationId) return [];
  const mem = todosStore.get(conversationId);
  if (mem) return mem.map((t) => ({ ...t }));
  const dbTodos = await loadTodosFromDb(userId, conversationId);
  if (dbTodos.length > 0) {
    todosStore.set(conversationId, dbTodos);
  }
  return dbTodos.map((t) => ({ ...t }));
}

/** Replace todo list for a conversation across in-memory cache and DB. */
export async function setTodos(userId: string, conversationId: string, todos: AgentTodo[]): Promise<AgentTodo[]> {
  if (!conversationId) return [];
  const stored = todos.map((t) => ({ ...t }));
  todosStore.set(conversationId, stored);
  await saveTodosToDb(userId, conversationId, stored);
  // Broadcast update via SSE stream to active UI subscribers.
  try {
    publishTodos(
      userId,
      conversationId,
      stored.map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        priority: t.priority ?? "medium",
      })),
    );
  } catch {
    // never let pubsub failures break the tool
  }
  return stored.map((t) => ({ ...t }));
}

/** Delete agent todos from the DB Plugin table. */
async function deleteTodosFromDb(userId: string, conversationId: string): Promise<void> {
  try {
    const name = todosPluginName(conversationId);
    await db.plugin.deleteMany({ where: { userId, name } });
  } catch {
    // Non-critical
  }
}

/** Drop the todo list for a conversation in memory and DB, broadcasting an empty update. */
export async function clearTodos(userId: string, conversationId: string): Promise<void> {
  if (!conversationId) return;
  todosStore.delete(conversationId);
  await deleteTodosFromDb(userId, conversationId);
  try {
    publishTodos(userId, conversationId, []);
  } catch {
    // never let pubsub failures break cleanup
  }
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function realWebSearch(query: string): Promise<SearchHit[]> {
  return duckDuckGoSearch(query);
}

async function duckDuckGoSearch(query: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`DuckDuckGo returned ${resp.status}`);
    }
    const html = await resp.text();
    return parseDuckDuckGoHtml(html).slice(0, 5);
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // DuckDuckGo HTML result blocks look like:
  //   <a class="result__a" href="...">Title</a>
  //   <a class="result__snippet" ...>Snippet</a>
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]).trim());
  }
  let i = 0;
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1];
    // DuckDuckGo wraps URLs in a redirect like //duckduckgo.com/l/?uddg=<encoded>
    const uddg = href.match(/uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep raw */
      }
    }
    const title = stripHtml(m[2]).trim();
    if (!title || !href) continue;
    hits.push({
      title: title.slice(0, 300),
      url: href,
      snippet: (snippets[i] || "").slice(0, 600),
    });
    i++;
    if (hits.length >= 5) break;
  }
  return hits;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function realHttpFetch(
  url: string,
): Promise<{ url: string; status: number; contentType: string; text: string }> {
  // SSRF guard: scheme + host policy, re-checked on every redirect hop.
  const blocked = await checkUrlHost(url);
  if (blocked) throw new Error(blocked);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let current = url;
    let hops = 0;
    for (;;) {
      const hopBlocked = await checkUrlHost(current);
      if (hopBlocked) throw new Error(hopBlocked);
      const resp = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        dispatcher: getSsrfDispatcher(),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      } as RequestInit);
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!location) throw new Error("Redirect without a Location header.");
        if (++hops > MAX_REDIRECTS) throw new Error("Too many redirects.");
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new Error("Invalid redirect location.");
        }
        continue;
      }
      const contentType = resp.headers.get("content-type") || "application/octet-stream";
      // Stream-capable size check: read up to MAX_HTTP_BYTES+1 to detect overflow.
      const buf = await readBounded(resp, MAX_HTTP_BYTES + 1);
      if (buf.length > MAX_HTTP_BYTES) {
        throw new Error(`Response too large (>${MAX_HTTP_BYTES} bytes).`);
      }
      const raw = buf.toString("utf8");
      let text = raw;
      if (contentType.includes("html")) {
        text = htmlToText(raw);
      }
      if (text.length > MAX_HTTP_TEXT) {
        text = text.slice(0, MAX_HTTP_TEXT) + "\n…[content truncated]";
      }
      return { url: current, status: resp.status, contentType, text };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(resp: Response, max: number): Promise<Buffer> {
  if (!resp.body) {
    const text = await resp.text();
    return Buffer.from(text.slice(0, max), "utf8");
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) {
      chunks.push(value.slice(0, max - (total - value.length)));
      break;
    }
    chunks.push(value);
  }
  try {
    reader.releaseLock();
  } catch {
    /* ignore */
  }
  return Buffer.concat(chunks);
}

function htmlToText(html: string): string {
  let s = html;
  // Drop scripts and styles entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Turn block-level tags into newlines.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|br|ul|ol)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip the rest of the tags.
  s = s.replace(/<[^>]*>/g, " ");
  // Decode entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

async function realMcpCall(serverName: string, tool: string, args?: unknown, userId?: string): Promise<unknown> {
  const whereClause: any = {
    name: {
      equals: serverName,
    },
  };
  if (userId) {
    const systemUser = await db.user.findUnique({ where: { email: "system@hermos.local" } });
    whereClause.OR = [
      { userId },
      ...(systemUser ? [{ userId: systemUser.id }] : []),
    ];
  }

  const mcpServer = await db.mcpServer.findFirst({
    where: whereClause,
  });

  if (!mcpServer) {
    throw new Error(`MCP server "${serverName}" is not registered.`);
  }

  if (mcpServer.status !== "connected") {
    throw new Error(`MCP server "${serverName}" is not connected (status: ${mcpServer.status}).`);
  }

  // Execute using real MCP connection pool
  const { callMcpClientTool, connectMcpClient } = await import("@/lib/mcp/manager");
  try {
    const result = await callMcpClientTool(mcpServer.id, tool, args || {});
    return {
      ok: true,
      server: serverName,
      tool,
      args,
      result: result.content || result,
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    if (err?.message?.includes("not connected")) {
      try {
        const parsedArgs = typeof mcpServer.args === "string" ? JSON.parse(mcpServer.args) : mcpServer.args;
        const parsedEnv = tryDecryptJson(mcpServer.env);
        const parsedHeaders = tryDecryptJson(mcpServer.headers);
        
        await connectMcpClient({
          id: mcpServer.id,
          name: mcpServer.name,
          transport: mcpServer.transport as any,
          command: mcpServer.command || undefined,
          args: parsedArgs || undefined,
          env: parsedEnv || undefined,
          url: mcpServer.url || undefined,
          headers: parsedHeaders || undefined,
        });

        const retryResult = await callMcpClientTool(mcpServer.id, tool, args || {});
        return {
          ok: true,
          server: serverName,
          tool,
          args,
          result: retryResult.content || retryResult,
          timestamp: new Date().toISOString(),
        };
      } catch (reconnectErr: any) {
        throw new Error(`MCP server connection lost and auto-reconnect failed: ${reconnectErr?.message || String(reconnectErr)}`);
      }
    }
    throw err;
  }
}

async function snapshotBeforeEdit(ctx: ToolCtx, rootDir: string, filePath: string): Promise<void> {
  if (!ctx.checkpointId) return;
  try {
    const absPath = path.resolve(rootDir, filePath);
    await snapshotFile(ctx.userId, convScope(ctx), ctx.checkpointId, absPath);
  } catch (err) {
    console.warn(`[checkpoints] snapshotBeforeEdit failed for ${filePath}:`, err);
  }
}

/** Resolve active or conversation-linked workspace for per-project isolation. */
export async function resolveWs(userId: string, conversationId?: string): Promise<WorkspaceInfo> {
  // Honor conversation-linked workspace if set for per-project isolation.
  if (conversationId) {
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true },
    });
    if (conv?.workspaceId) {
      const ws = await resolveWorkspace(userId, conv.workspaceId);
      if (ws) return ws;
    }
  }
  return await getActiveWorkspace(userId) ?? await ensureDefaultWorkspace(userId);
}

/** An agent-supplied path resolved to an on-disk location. */
export interface AgentPathTarget {
  /** Root the resolved path is confined to (workspace root or artifact dir). */
  rootDir: string;
  /** Path relative to `rootDir` — safe to hand to the workspace I/O helpers. */
  rel: string;
  /** True when the target lives in the user's artifact directory. */
  isArtifact: boolean;
}

/** Resolve agent paths across artifacts, temp scratch, truncation cache, and workspace root. */
export async function resolveAgentPath(
  userId: string,
  ws: Pick<WorkspaceInfo, "name" | "rootDir">,
  conversationId: string | undefined,
  input: string,
): Promise<{ rootDir: string; rel: string; isArtifact: boolean; isTemp: boolean; isTruncation: boolean } | null> {
  const artifactUserDir = path.join(ARTIFACTS_DIR, userId);
  const tempDir = ensureAgentTempDir(userId);
  const truncationDir = truncationUserDir(userId);

  if (path.isAbsolute(input)) {
    const artifactAbs = safePath(userId, ws.name, input, artifactUserDir);
    if (artifactAbs) {
      return { rootDir: artifactUserDir, rel: path.relative(artifactUserDir, artifactAbs), isArtifact: true, isTemp: false, isTruncation: false };
    }
    const truncAbs = safePath(userId, ws.name, input, truncationDir);
    if (truncAbs) {
      return { rootDir: truncationDir, rel: path.relative(truncationDir, truncAbs), isArtifact: false, isTemp: false, isTruncation: true };
    }
    const tempAbs = safePath(userId, ws.name, input, tempDir);
    if (tempAbs) {
      return { rootDir: tempDir, rel: path.relative(tempDir, tempAbs), isArtifact: false, isTemp: true, isTruncation: false };
    }
    const wsAbs = safePath(userId, ws.name, input, ws.rootDir);
    if (wsAbs) {
      return { rootDir: ws.rootDir, rel: path.relative(ws.rootDir, wsAbs), isArtifact: false, isTemp: false, isTruncation: false };
    }
    return null;
  }

  // Relative path — resolve within the workspace first.
  const wsAbs = safePath(userId, ws.name, input, ws.rootDir);
  if (wsAbs && existsSync(wsAbs)) {
    return { rootDir: ws.rootDir, rel: input, isArtifact: false, isTemp: false, isTruncation: false };
  }

  // Bare filename fallback to conversation artifact if no matching workspace file exists.
  if (!/[\\/]/.test(input)) {
    const convId = conversationId || "default";
    const convDir = path.join(/* turbopackIgnore: true */ artifactUserDir, convId);
    const convAbs = safePath(userId, ws.name, input, convDir);
    if (convAbs && existsSync(convAbs)) {
      return { rootDir: convDir, rel: input, isArtifact: true, isTemp: false, isTruncation: false };
    }
  }

  // Fall back to the workspace target (letting the normal read/write error
  // surface) or null if the path escapes every allowed root.
  if (wsAbs) return { rootDir: ws.rootDir, rel: input, isArtifact: false, isTemp: false, isTruncation: false };
  return null;
}

/** Refuse mutations of the read-only truncation cache. */
export function truncationWriteGuard(
  target: { isTruncation: boolean } | null,
): ToolResult | null {
  if (target?.isTruncation) {
    return { ok: false, result: { error: "The truncation cache is read-only — read it with read_file or grep." } };
  }
  return null;
}

/** Check if target is a workspace file eligible for snapshots and checkpoint tracking. */
function isWorkspaceTarget(target: { isArtifact: boolean; isTemp: boolean; isTruncation: boolean }): boolean {
  return !target.isArtifact && !target.isTemp && !target.isTruncation;
}

/** Cap stored content for diffs/tool results with a visible truncation notice. */
const MAX_CONTENT_CHARS = process.env.MAX_READ_FILE_CHARS
  ? parseInt(process.env.MAX_READ_FILE_CHARS, 10)
  : 100_000;

function capContent(s: string): string {
  if (s.length <= MAX_CONTENT_CHARS) return s;
  return s.slice(0, MAX_CONTENT_CHARS) + `\n\n[... truncated at ${MAX_CONTENT_CHARS.toLocaleString()} chars — use read_file with offset/limit to see more ...]`;
}

const MAX_DIFF_LINES = 500;

function capDiffLines(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [
    ...lines.slice(0, MAX_DIFF_LINES),
    { type: "context", oldNum: null, newNum: null, content: `[... ${lines.length - MAX_DIFF_LINES} more diff lines truncated ...]\n` },
  ];
}

/** Fine-grained lock registry for serializing same-resource critical sections across concurrent loops. */
const lockChains = new Map<string, Promise<unknown>>();

/** Execute async callback within a keyed mutex chain to guarantee non-overlapping execution. */
export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  lockChains.set(key, tail);
  void tail.then(() => {
    if (lockChains.get(key) === tail) lockChains.delete(key);
  });
  return run;
}

/** Normalize resource path for lock keys, resolving dot segments and Windows case. */
function normalizeLockPath(p: string): string {
  const stack: string[] = [];
  for (const part of p.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  return process.platform === "win32" ? joined.toLowerCase() : joined;
}

/** Canonicalize resource path relative to workspace root for lock key consistency. */
function lockPathKey(p: string, rootDir?: string): string {
  const canonical = rootDir
    ? path.relative(rootDir, path.resolve(rootDir, p))
    : p;
  return normalizeLockPath(canonical);
}

/** Compute lock key for tool invocation; returns null for stateless operations. */
export function toolLockKey(
  name: string,
  args: unknown,
  ctx?: Pick<ToolCtx, "userId" | "rootDir">,
): string | null {
  const uid = ctx?.userId ?? "anonymous";
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "multi_edit":
    case "read_doc":
    case "create_artifact":
    case "generate_ppt":
    case "generate_doc":
    case "generate_pdf": {
      const p = str(a.path) ?? str(a.targetFile) ?? str(a.TargetFile);
      return p ? `fs:${uid}:${lockPathKey(p, ctx?.rootDir)}` : `fs:${uid}:*`;
    }
    case "list_directory":
    case "glob":
    case "grep": {
      const p = str(a.path) ?? str(a.pattern);
      return p ? `fs:${uid}:${lockPathKey(p, ctx?.rootDir)}` : `fs:${uid}:*`;
    }
    case "create_skill":
    case "install_mcp_server": {
      const n = str(a.name);
      return n ? `meta:${uid}:${n}` : `meta:${uid}:*`;
    }
    // Shared per-user state that read-modify-writes must not interleave.
    case "todo_write":
    case "todo_read":
    case "todo_clear":
      return `todo:${uid}`;
    // Subagent lifecycle writes the shared session registry (spawns must not
    // interleave with reap bookkeeping).
    case "spawn_subagent":
    case "get_subagent":
    case "message_subagent":
      return `subagent:${uid}`;
    // Unknown side effects — strictly serial per user.
    case "mcp_call":
    case "plugin_call":
      return `global:${uid}`;
    case "run_command":
    case "command_stop":
      return `cmd:${uid}`;
    default:
      if (name.startsWith("browser_")) return `browser:${uid}`;
      return null; // stateless — no lock
  }
}

export async function runTool(
  name: string,
  args: unknown,
  ctx?: ToolCtx,
): Promise<ToolResult> {
  const key = toolLockKey(name, args, ctx);
  if (key == null) return runToolImpl(name, args, ctx);
  return withPathLock(key, () => runToolImpl(name, args, ctx));
}

async function runToolImpl(
  name: string,
  args: unknown,
  ctx?: ToolCtx,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const parsed = readFileSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        const target = await resolveAgentPath(ctx.userId, ws, convScope(ctx), parsed.data.path);
        if (!target) return { ok: false, result: { error: "Invalid path." } };
        const { path, offset, limit } = parsed.data;
        try {
          let r;
          if (offset !== undefined || limit !== undefined) {
            const startLine = (offset !== undefined ? offset : 0) + 1;
            const endLine = limit !== undefined ? startLine + Math.max(1, limit) - 1 : undefined;
            r = await readFileRangeWs(ctx.userId, ws.name, target.rel, startLine, endLine, target.rootDir);
          } else {
            r = await readFileWs(ctx.userId, ws.name, target.rel, undefined, target.rootDir);
          }

          const truncated = await truncateOutput(r.content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }, undefined, ctx.userId);
          r.content = truncated.content;

          const lines =
            r.content.length === 0
              ? 0
              : (r.content.match(/\n/g)?.length ?? 0) + 1;
          return { ok: true, result: { ...r, isArtifact: target.isArtifact, lines, truncated: truncated.truncated, truncationPath: truncated.outputPath } };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "read failed" } };
        }
      }
      case "write_file": {
        const parsed = writeFileSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        const target = await resolveAgentPath(ctx.userId, ws, convScope(ctx), parsed.data.path);
        if (!target) return { ok: false, result: { error: "Invalid path." } };
        const twGuard = truncationWriteGuard(target);
        if (twGuard) return twGuard;
        if (target.isArtifact && deniedWriteExtension(target.rel)) {
          return { ok: false, result: { error: `Writing artifacts with the "${path.extname(target.rel).slice(1)}" extension is not allowed.` } };
        }
        try {
          // Capture prior content for diffs on overwrite; for new files set created: true.
          let oldContent: string | undefined;
          let created = false;
          try {
            const existing = await readFileWs(ctx.userId, ws.name, target.rel, undefined, target.rootDir);
            oldContent = existing.content;
          } catch {
            // File does not exist (or unreadable) — treat as a new file.
            created = true;
          }
          if (!created && isWorkspaceTarget(target)) await snapshotBeforeEdit(ctx, target.rootDir, target.rel);
          const r = await writeFileWs(ctx.userId, ws.name, target.rel, parsed.data.content, target.rootDir);
          if (created && isWorkspaceTarget(target)) {
            const absCreated = path.resolve(target.rootDir, target.rel);
            await trackNewFile(ctx.userId, convScope(ctx), ctx.checkpointId!, absCreated);
          }
          const newContent = capContent(parsed.data.content);
          if (created) {
            return {
              ok: true,
              result: {
                path: parsed.data.path,
                bytes: r.bytes,
                created: true,
                isArtifact: target.isArtifact,
                newContent,
              },
            };
          }
          // Overwrite: include old + new + diff.
          const cappedOld = oldContent !== undefined ? capContent(oldContent) : undefined;
          const diff =
            cappedOld !== undefined
              ? capDiffLines(computeDiff(cappedOld, newContent))
              : undefined;
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              bytes: r.bytes,
              created: false,
              isArtifact: target.isArtifact,
              oldContent: cappedOld,
              newContent,
              diff,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "write failed" } };
        }
      }
      case "create_artifact": {
        const a = (args ?? {}) as Record<string, any>;
        const rawPath = String(a.path ?? a.targetFile ?? a.TargetFile ?? "");
        const content = String(a.content ?? "");
        if (!rawPath) return { ok: false, result: { error: "path is required for create_artifact" } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };

        const filename = path.basename(rawPath);
        // Same executable-extension policy write_file enforces.
        const deniedExt = deniedWriteExtension(filename);
        if (deniedExt) {
          return { ok: false, result: { error: `Writing artifacts with the "${deniedExt.replace(/^\./, "")}" extension is not allowed.` } };
        }
        const convId = convScope(ctx) || "global";
        const artifactDir = path.join(/* turbopackIgnore: true */ ARTIFACTS_DIR, ctx.userId, convId);

        try {
          await fs.mkdir(/* turbopackIgnore: true */ artifactDir, { recursive: true });
          const absPath = path.join(/* turbopackIgnore: true */ artifactDir, filename);
          await fs.writeFile(absPath, content, "utf8");
          const bytes = Buffer.byteLength(content, "utf8");
          return {
            ok: true,
            result: {
              path: absPath,
              bytes,
              created: true,
              isArtifact: true,
              newContent: capContent(content),
              message: `Created artifact ${filename}`,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "artifact creation failed" } };
        }
      }
      case "edit_file": {
        const parsed = editFileSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        const target = await resolveAgentPath(ctx.userId, ws, convScope(ctx), parsed.data.path);
        if (!target) return { ok: false, result: { error: "Invalid path." } };
        const twGuard = truncationWriteGuard(target);
        if (twGuard) return twGuard;
        try {
          // Read file before editing to capture oldContent for diffing.
          let oldContent: string;
          try {
            const before = await readFileWs(ctx.userId, ws.name, target.rel, undefined, target.rootDir);
            oldContent = before.content;
          } catch (e) {
            return {
              ok: false,
              result: {
                error: `Failed to read file before edit: ${e instanceof Error ? e.message : "read failed"}`,
                path: parsed.data.path,
                find: parsed.data.find,
                replace: parsed.data.replace,
                replaceAll: parsed.data.replaceAll ?? false,
              },
            };
          }
          if (isWorkspaceTarget(target)) await snapshotBeforeEdit(ctx, target.rootDir, target.rel);
          const r = await editFileWs(
            ctx.userId,
            ws.name,
            target.rel,
            parsed.data.find,
            parsed.data.replace,
            parsed.data.replaceAll ?? false,
            target.rootDir,
          );
          // Read the file AFTER editing to capture newContent.
          let newContent: string;
          try {
            const after = await readFileWs(ctx.userId, ws.name, target.rel, undefined, target.rootDir);
            newContent = after.content;
          } catch {
            // Fallback: reconstruct newContent from find/replace args if unreadable after edit.
            newContent = parsed.data.replaceAll
              ? oldContent.split(parsed.data.find).join(parsed.data.replace)
              : oldContent.replace(parsed.data.find, parsed.data.replace);
          }
          const cappedOld = capContent(oldContent);
          const cappedNew = capContent(newContent);
          const diff = capDiffLines(computeDiff(cappedOld, cappedNew));
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              occurrences: r.occurrences,
              isArtifact: target.isArtifact,
              oldContent: cappedOld,
              newContent: cappedNew,
              diff,
            },
          };
        } catch (e) {
          return {
            ok: false,
            result: {
              error: e instanceof Error ? e.message : "edit failed",
              path: parsed.data.path,
              find: parsed.data.find,
              replace: parsed.data.replace,
              replaceAll: parsed.data.replaceAll ?? false,
            },
          };
        }
      }
      case "list_directory": {
        const parsed = listDirSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        try {
          const dirPath = parsed.data.path?.trim() || ".";
          // Scope directory listing to target path, returning null on traversal escapes.
          const target = safePath(ctx.userId, ws.name, dirPath, ws.rootDir);
          if (!target) {
            return { ok: false, result: { error: `Invalid path: ${dirPath}` } };
          }
          const tree = await readTree(ctx.userId, ws.name, 1, target);
          let files = 0;
          let dirs = 0;
          for (const n of tree) {
            if (n.type === "dir") dirs++;
            else files++;
          }
          const result = { path: dirPath, entries: tree, files, dirs };
          return { ok: true, result };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "list failed" } };
        }
      }
      case "run_command": {
        const parsed = runCommandSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        const cmd = parsed.data.command;

        acknowledgeCompletedCommand(ctx.userId, ctx.conversationId);

        const result = startBackgroundCommand(ctx.userId, ctx.conversationId, ws.name, cmd, {
          onProgress: ctx.onProgress,
          rootDir: ws.rootDir,
        });

        if (!result.ok) {
          return { ok: false, result: { error: result.error ?? "Failed to start command" } };
        }

        // Block until process completes (up to timeout) while streaming live output.
        const waitDuration = Math.min(
          parsed.data.WaitMsBeforeAsync ?? COMMAND_BLOCK_TIMEOUT_MS,
          COMMAND_MAX_BLOCK_TIMEOUT_MS,
        );
        // Wait for this specific command execution ID to prevent alias collisions.
        const waitExecId = result.commandId.includes(":")
          ? result.commandId.split(":").slice(2).join(":")
          : result.commandId;
        const completed = await waitForCommandCompletion(
          ctx.userId,
          ctx.conversationId,
          waitDuration,
          ctx.signal,
          waitExecId,
        );

        if (ctx.signal?.aborted) {
          stopRunningCommand(ctx.userId, ctx.conversationId);
          return { ok: false, result: { error: "Command execution aborted." } };
        }

        if (completed) {
          acknowledgeCompletedCommand(ctx.userId, ctx.conversationId, waitExecId);
          const cmdOk = completed.exitCode === 0 || completed.exitCode == null;
          return {
            ok: cmdOk,
            result: {
              status: cmdOk ? "completed" : "failed",
              command: completed.command,
              stdout: completed.stdout,
              stderr: completed.stderr,
              exitCode: completed.exitCode ?? 0,
            },
          };
        }

        // Process still running after block timeout — returns running state with partial output.
        const running = getRunningCommand(ctx.userId, ctx.conversationId);
        return {
          ok: true,
          result: {
            status: "running",
            started: true,
            commandId: result.commandId,
            command: cmd,
            running: true,
            stdout: running?.stdout ?? "",
            stderr: running?.stderr ?? "",
            note: `Command is still running in background after ${Math.round(waitDuration / 1000)}s. It continues in the background and its full output is delivered automatically when it finishes; use command_stop to kill it.`,
          },
        };
      }
      case "command_stop": {
        if (!ctx?.userId || !ctx?.conversationId) {
          return { ok: false, result: { error: "No user/conversation context." } };
        }
        const stopped = stopRunningCommand(ctx.userId, ctx.conversationId);
        acknowledgeCompletedCommand(ctx.userId, ctx.conversationId);
        return { ok: true, result: { stopped } };
      }
      case "web_search": {
        const parsed = webSearchSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        try {
          const results = await realWebSearch(parsed.data.query);
          // Echo search query in result payload for UI headers.
          return { ok: true, result: { query: parsed.data.query, results, count: results.length } };
        } catch (e) {
          return {
            ok: false,
            result: {
              error: e instanceof Error ? e.message : "Web search failed.",
              query: parsed.data.query,
              results: [],
              count: 0,
            },
          };
        }
      }
      case "http_fetch": {
        const parsed = httpFetchSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        try {
          const r = await realHttpFetch(parsed.data.url);
          // Include content alias for text field compatibility.
          return { ok: true, result: { ...r, content: r.text } };
        } catch (e) {
          return {
            ok: false,
            result: { error: e instanceof Error ? e.message : "HTTP fetch failed." },
          };
        }
      }
      case "browser_open": {
        const parsed = browserOpenSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        const targetUrl = parsed.data.url;
        // Key the session by userId ONLY — the integrated browser panel uses
        // the same key, so the user watches and drives the exact same page the
        // agent sees (per-conversation isolation would silently desync them;
        // concurrent browser tool calls are already serialized per-user via
        // toolLockKey below).
        const browserKey = ctx?.userId || "default";
        const r = await browserOpen(targetUrl, browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { session: r.session, title: r.title, snapshot: r.snapshot } };
      }
      case "browser_click": {
        const parsed = browserClickSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        const browserKey = ctx?.userId || "default";
        const r = await browserClick(parsed.data.ref, browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { snapshot: r.snapshot } };
      }
      case "browser_type": {
        const parsed = browserTypeSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        const browserKey = ctx?.userId || "default";
        const r = await browserType(parsed.data.ref, parsed.data.text, browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { snapshot: r.snapshot } };
      }
      case "browser_screenshot": {
        browserVoidSchema.safeParse(args);
        const browserKey = ctx?.userId || "default";
        const r = await browserScreenshot(browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { dataUrl: r.dataUrl } };
      }
      case "browser_scroll": {
        const parsed = z.object({
          direction: z.enum(["up", "down", "left", "right"]),
          px: z.number().int().optional(),
        }).safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        const browserKey = ctx?.userId || "default";
        const r = await browserScroll(parsed.data.direction, parsed.data.px, browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { snapshot: r.snapshot } };
      }
      case "browser_press": {
        const parsed = z.object({
          key: z.string(),
        }).safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        const browserKey = ctx?.userId || "default";
        const r = await browserPress(parsed.data.key, browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { snapshot: r.snapshot } };
      }
      case "browser_extract": {
        browserVoidSchema.safeParse(args);
        const browserKey = ctx?.userId || "default";
        const r = await browserExtractText(browserKey);
        if (!r.ok) return { ok: false, result: { error: r.error } };
        return { ok: true, result: { text: r.text } };
      }
      case "browser_go_back": {
        browserVoidSchema.safeParse(args);
        const browserKey = ctx?.userId || "default";
        const backR = await browserGoBack(browserKey);
        if (!backR.ok) return { ok: false, result: { error: backR.error } };
        return { ok: true, result: { snapshot: backR.snapshot } };
      }
      case "browser_go_forward": {
        browserVoidSchema.safeParse(args);
        const browserKey = ctx?.userId || "default";
        const fwdR = await browserGoForward(browserKey);
        if (!fwdR.ok) return { ok: false, result: { error: fwdR.error } };
        return { ok: true, result: { snapshot: fwdR.snapshot } };
      }
      case "browser_close": {
        browserVoidSchema.safeParse(args);
        const browserKey = ctx?.userId || "default";
        const closeR = await browserClose(browserKey);
        if (!closeR.ok) return { ok: false, result: { error: closeR.error } };
        return { ok: true, result: { closed: true } };
      }

      case "plugin_call": {
        const parsed = z.object({
          plugin: z.string(),
          tool: z.string(),
          args: z.record(z.string(), z.any()).optional(),
        }).safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        try {
          const { loadPluginTools, executePluginTool } = await import("@/lib/plugins/plugin-runtime");
          const pluginTools = await loadPluginTools(ctx.userId);
          const targetTool = pluginTools.find(
            (t) => t.pluginName?.toLowerCase() === parsed.data.plugin.toLowerCase() &&
                   t.name.toLowerCase() === parsed.data.tool.toLowerCase()
          );
          if (!targetTool) {
            return { ok: false, result: { error: `Plugin tool "${parsed.data.plugin}/${parsed.data.tool}" not found or plugin disabled.` } };
          }
          const res = await executePluginTool(targetTool, parsed.data.args || {});
          return { ok: true, result: { output: res } };
        } catch (e: any) {
          return { ok: false, result: { error: e?.message || String(e) } };
        }
      }
      case "mcp_call": {
        const parsed = mcpCallSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        try {
          const res = await realMcpCall(parsed.data.server, parsed.data.tool, parsed.data.args, ctx?.userId);
          return { ok: true, result: res as Record<string, unknown> };
        } catch (e: any) {
          return { ok: false, result: { error: e?.message || String(e) } };
        }
      }
      case "install_mcp_server": {
        const schema = z.object({
          name: z.string(),
          transport: z.enum(["stdio", "sse"]),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
        });
        const parsed = schema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        
        try {
          const existing = await db.mcpServer.findFirst({
            where: { userId: ctx.userId, name: parsed.data.name },
          });

          let serverObj;
          if (existing) {
            serverObj = await db.mcpServer.update({
              where: { id: existing.id },
              data: {
                transport: parsed.data.transport,
                command: parsed.data.command || null,
                args: parsed.data.args ? JSON.stringify(parsed.data.args) : null,
                env: parsed.data.env ? JSON.stringify(parsed.data.env) : null,
                url: parsed.data.url || null,
                headers: parsed.data.headers ? JSON.stringify(parsed.data.headers) : null,
              },
            });
          } else {
            serverObj = await db.mcpServer.create({
              data: {
                userId: ctx.userId,
                name: parsed.data.name,
                transport: parsed.data.transport,
                command: parsed.data.command || null,
                args: parsed.data.args ? JSON.stringify(parsed.data.args) : null,
                env: parsed.data.env ? JSON.stringify(parsed.data.env) : null,
                url: parsed.data.url || null,
                headers: parsed.data.headers ? JSON.stringify(parsed.data.headers) : null,
                status: "disconnected",
              },
            });
          }

          const { connectMcpClient } = await import("@/lib/mcp/manager");
          const discoveredTools = await connectMcpClient({
            id: serverObj.id,
            name: serverObj.name,
            transport: serverObj.transport as any,
            command: serverObj.command || undefined,
            args: parsed.data.args,
            env: parsed.data.env,
            url: serverObj.url || undefined,
            headers: parsed.data.headers,
          });

          await db.mcpServer.update({
            where: { id: serverObj.id },
            data: {
              status: "connected",
              tools: JSON.stringify(discoveredTools),
              lastError: null,
            },
          });

          return {
            ok: true,
            result: {
              installed: true,
              serverId: serverObj.id,
              name: serverObj.name,
              status: "connected",
              toolsCount: discoveredTools.length,
              tools: discoveredTools.map((t) => t.name),
            },
          };
        } catch (e: any) {
          return {
            ok: false,
            result: {
              error: `Failed to install or connect MCP server: ${e?.message || String(e)}`,
            },
          };
        }
      }
      case "create_skill": {
        const schema = z.object({
          name: z.string(),
          description: z.string().optional(),
          type: z.enum(["skill", "plugin"]).optional().default("skill"),
          manifest: z.record(z.string(), z.any()).optional(),
        });
        const parsed = schema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };

        // Privilege guard: manifests created VIA THE AGENT TOOL must never
        // register executable handlers. plugin-runtime executes tools with
        // handler === "script" via execFile (arbitrary command execution) —
        // only SSRF-gated "api" handlers are permitted here. Script-capable
        // skills can still be installed through the manual/plugin path.
        const manifestTools = parsed.data.manifest?.tools;
        if (Array.isArray(manifestTools)) {
          const offenders = manifestTools
            .filter((t: any) => t && typeof t === "object" && t.handler !== undefined && t.handler !== "api")
            .map((t: any) => String(t.name ?? t.handler));
          if (offenders.length > 0) {
            return {
              ok: false,
              result: {
                error: `Rejected: skill manifests cannot declare executable handlers (${offenders.join(", ")}). Only handler:"api" endpoints are allowed.`,
              },
            };
          }
        }

        try {
          const existing = await db.plugin.findFirst({
            where: { userId: ctx.userId, name: parsed.data.name },
          });

          const manifestStr = parsed.data.manifest ? JSON.stringify(parsed.data.manifest) : null;

          let pluginObj;
          if (existing) {
            pluginObj = await db.plugin.update({
              where: { id: existing.id },
              data: {
                description: parsed.data.description || existing.description,
                type: parsed.data.type,
                manifest: manifestStr || existing.manifest,
                enabled: true,
              },
            });
          } else {
            pluginObj = await db.plugin.create({
              data: {
                userId: ctx.userId,
                name: parsed.data.name,
                description: parsed.data.description || "Custom AI skill",
                type: parsed.data.type,
                manifest: manifestStr,
                enabled: true,
              },
            });
          }

          return {
            ok: true,
            result: {
              created: true,
              skillId: pluginObj.id,
              name: pluginObj.name,
              type: pluginObj.type,
              enabled: pluginObj.enabled,
            },
          };
        } catch (e: any) {
          return {
            ok: false,
            result: {
              error: `Failed to create skill: ${e?.message || String(e)}`,
            },
          };
        }
      }
      case "generate_ppt": {
        const parsed = generatePptSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        try {
          const outputPath = await resolveOutputPath(ctx.userId, ws.name, parsed.data.path, ws.rootDir);
          const slides: PptSlide[] = parsed.data.slides.map((s) => ({
            title: s.title,
            bullets: s.bullets,
            notes: s.notes,
          }));
          const theme: PptTheme = parsed.data.theme ?? "professional";
          const r = await generatePpt({
            title: parsed.data.title,
            slides,
            theme,
            outputPath,
          });
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              slides: r.slides,
              theme,
              bytes: (await fs.stat(outputPath).catch(() => ({ size: 0 }))).size,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "generate_ppt failed" } };
        }
      }
      case "generate_doc": {
        const parsed = generateDocSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        try {
          const outputPath = await resolveOutputPath(ctx.userId, ws.name, parsed.data.path, ws.rootDir);
          const sections: DocSection[] = parsed.data.sections.map((s) => ({
            heading: s.heading,
            paragraphs: s.paragraphs,
          }));
          const r = await generateDoc({
            title: parsed.data.title,
            sections,
            outputPath,
          });
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              sections: r.sections,
              bytes: (await fs.stat(outputPath).catch(() => ({ size: 0 }))).size,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "generate_doc failed" } };
        }
      }
      case "generate_pdf": {
        const parsed = generatePdfSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        try {
          const outputPath = await resolveOutputPath(ctx.userId, ws.name, parsed.data.path, ws.rootDir);
          const sections: PdfSection[] = parsed.data.sections.map((s) => ({
            heading: s.heading,
            paragraphs: s.paragraphs,
          }));
          const r = await generatePdf({
            title: parsed.data.title,
            sections,
            outputPath,
          });
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              sections: r.sections,
              bytes: (await fs.stat(outputPath).catch(() => ({ size: 0 }))).size,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "generate_pdf failed" } };
        }
      }
      case "read_doc": {
        const parsed = readDocSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        try {
          const abs = safePath(ctx.userId, ws.name, parsed.data.path, ws.rootDir);
          if (!abs) return { ok: false, result: { error: "Invalid path." } };
          const stat = await fs.stat(abs).catch(() => null);
          if (!stat || !stat.isFile()) {
            return { ok: false, result: { error: "File not found." } };
          }
          // No file size cap — let the agent extract text from any document.
          const r = await extractOfficeText(abs);
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              type: r.type,
              text: r.text,
              size: stat.size,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "read_doc failed" } };
        }
      }
      case "spawn_subagent": {
        const parsed = spawnSubagentSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId || !ctx.conversationId) {
          return { ok: false, result: { error: "No user/conversation context." } };
        }
        try {
          const sa = createSubagent(ctx.userId, ctx.conversationId, {
            name: parsed.data.name,
            task: parsed.data.task,
            systemPrompt: parsed.data.systemPrompt,
            allowedTools: parsed.data.allowedTools,
            provider: ctx.provider,
            model: ctx.model,
            checkpointId: ctx.checkpointId,
            thinkingLevel: ctx.thinkingLevel,
          });
          return {
            ok: true,
            result: {
              id: sa.id,
              subagentId: sa.id, // redundant alias for reliable extraction by SubagentBlock
              name: sa.name,
              status: sa.status,
              createdAt: sa.createdAt,
              note:
                "Subagent is running in the background. The moment it completes, its report is queued into your NEXT iteration — continue your own work and the result will be injected automatically. Do NOT spawn additional subagents for the same task.",
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "spawn_subagent failed" } };
        }
      }
      case "get_subagent": {
        const parsed = getSubagentSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        try {
          const sa = getSubagent(ctx.userId, parsed.data.id);
          if (!sa) {
            return { ok: false, result: { error: "Subagent not found (or does not belong to you)." } };
          }
          // Surface structured report (summary/findings/conclusion) rather than raw transcript dumps.
          const structured = sa.status === "completed" ? getSubagentStructuredReport(ctx.userId, sa.id) : null;
          // Avoid duplicate report echo if already delivered to conversation history.
          const reportDelivered =
            sa.status === "completed" &&
            !!ctx.conversationId &&
            isSubagentReportDelivered(ctx.userId, ctx.conversationId, sa.id);
          return {
            ok: true,
            result: {
              id: sa.id,
              name: sa.name,
              status: sa.status,
              report: reportDelivered ? undefined : (structured?.text ?? undefined),
              findings: reportDelivered ? undefined : structured?.findings,
              summary: reportDelivered
                ? `${sa.name} completed — its report is already in the transcript.`
                : sa.status === "completed"
                  ? (structured?.text
                      ? `Subagent finished successfully. Detailed Report:\n\n${structured.text}`
                      : `Subagent completed without producing a final answer. Use message_subagent(..., \"continue\") to resume it.${sa.error ? ` Error: ${sa.error}` : ""}`)
                  : `Subagent status: ${sa.status}. ${sa.error ? `Error: ${sa.error}` : ""}`,
              error: sa.error,
              createdAt: sa.createdAt,
              completedAt: sa.completedAt,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "get_subagent failed" } };
        }
      }
      case "message_subagent": {
        const parsed = messageSubagentSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        try {
          const out = reviveSubagent(ctx.userId, parsed.data.id, parsed.data.message);
          const name = getSubagent(ctx.userId, parsed.data.id)?.name ?? parsed.data.id;
          return out.ok
            ? { ok: true, result: { id: parsed.data.id, name, status: out.status, note: out.note } }
            : { ok: false, result: { error: out.error } };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "message_subagent failed" } };
        }
      }
      case "grep": {
        const grepSchema = z.object({
          pattern: z.string().trim().min(1).max(2000),
          path: z.string().trim().min(1).max(500).optional(),
          filePattern: z.string().trim().max(100).optional(),
        });
        const parsed = grepSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        try {
          const ws = await resolveWs(ctx.userId, convScope(ctx));
          const wsName = ws?.name ?? "project";
          let re: RegExp;
          try {
            re = new RegExp(parsed.data.pattern, "i");
          } catch (e) {
            return {
              ok: false,
              result: {
                error: `Invalid regex pattern: ${e instanceof Error ? e.message : "unknown error"}. Escape special characters (e.g. "catch \\\\{" or "foo\\\\.bar").`,
              },
            };
          }
          const matches = await (async () => {
            // Normalize search path across workspace, temp, and truncation cache roots.
            let subPath = parsed.data.path;
            let rootDir = ws?.rootDir;
            if (subPath && ws) {
              const target = await resolveAgentPath(ctx.userId, ws, ctx.conversationId, subPath);
              if (target) {
                rootDir = target.rootDir;
                subPath = target.rel;
              }
            }
            return grepWorkspace(ctx.userId, wsName, parsed.data.pattern, {
              maxResults: 100,
              filePattern: parsed.data.filePattern,
              subPath,
              rootDir,
              regex: re,
            });
          })();
          const result = { matches, count: matches.length };
          return { ok: true, result };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "grep failed" } };
        }
      }
      case "multi_edit": {
        const parsed = multiEditSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        const ws = await resolveWs(ctx.userId, convScope(ctx));
        const target = await resolveAgentPath(ctx.userId, ws, convScope(ctx), parsed.data.path);
        if (!target) return { ok: false, result: { error: "Invalid path." } };
        const twGuard = truncationWriteGuard(target);
        if (twGuard) return twGuard;
        try {
          if (isWorkspaceTarget(target)) await snapshotBeforeEdit(ctx, target.rootDir, target.rel);
          const r = await multiEditWs(ctx.userId, ws.name, target.rel, parsed.data.edits, target.rootDir);
          // Unified diff generation matching edit_file output format.
          const cappedOld = capContent(r.oldContent);
          const cappedNew = capContent(r.newContent);
          const diff = capDiffLines(computeDiff(cappedOld, cappedNew));
          return {
            ok: true,
            result: {
              path: parsed.data.path,
              isArtifact: target.isArtifact,
              editsApplied: r.occurrences.length,
              occurrences: r.occurrences,
              totalOccurrences: r.totalOccurrences,
              oldContent: cappedOld,
              newContent: cappedNew,
              diff,
            },
          };
        } catch (e) {
          // MultiEditError exposes the 1-based index of the failing chunk for diagnosis.
          if (e instanceof MultiEditError) {
            return {
              ok: false,
              result: {
                error: e.message,
                failedEditIndex: e.index,
                failedEditNumber: e.index + 1,
                path: parsed.data.path,
                // No edits were written to disk — atomicity guarantee.
                rolledBack: true,
              },
            };
          }
          return { ok: false, result: { error: e instanceof Error ? e.message : "multi_edit failed" } };
        }
      }
      case "glob": {
        const parsed = globSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx?.userId) return { ok: false, result: { error: "No user context." } };
        try {
          const ws = await resolveWs(ctx.userId, convScope(ctx));
          const wsName = ws?.name ?? "project";
          const r = await globWs(ctx.userId, wsName, parsed.data.pattern, parsed.data.path, ws?.rootDir);
          const result = { matches: r.matches, count: r.count, pattern: r.pattern, path: r.path };
          return { ok: true, result };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "glob failed" } };
        }
      }
      case "todo_write": {
        const parsed = todoWriteSchema.safeParse(args);
        if (!parsed.success) return { ok: false, result: { error: formatZodError(parsed.error) } };
        if (!ctx || !convScope(ctx)) {
          return { ok: false, result: { error: "No conversation context (cannot store todos without a conversationId)." } };
        }
        try {
          // Normalize, validate, and deduplicate todo items by ID.
          const seen = new Set<string>();
          const cleaned: AgentTodo[] = [];
          for (const t of parsed.data.todos) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            cleaned.push({
              id: t.id,
              content: t.content,
              status: t.status,
              priority: t.priority,
            });
          }
          await setTodos(ctx.userId, convScope(ctx), cleaned);
          // Compute summary task progress statistics.
          let inProgress = 0;
          let completed = 0;
          let pending = 0;
          for (const t of cleaned) {
            if (t.status === "in_progress") inProgress++;
            else if (t.status === "completed") completed++;
            else pending++;
          }
          // Auto-clear list once all tasks are completed.
          if (cleaned.length > 0 && completed === cleaned.length) {
            await clearTodos(ctx.userId, convScope(ctx));
          }
          return {
            ok: true,
            result: {
              count: cleaned.length,
              pending,
              inProgress,
              completed,
              todos: cleaned,
            },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "todo_write failed" } };
        }
      }
      case "todo_read": {
        todoReadSchema.safeParse(args);
        if (!ctx || !convScope(ctx)) {
          return { ok: false, result: { error: "No conversation context (no todos to read)." } };
        }
        try {
          const todos = await getTodos(ctx.userId, convScope(ctx));
          let inProgress = 0;
          let completed = 0;
          let pending = 0;
          for (const t of todos) {
            if (t.status === "in_progress") inProgress++;
            else if (t.status === "completed") completed++;
            else pending++;
          }
          return {
            ok: true,
            result: { todos, count: todos.length, pending, inProgress, completed },
          };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "todo_read failed" } };
        }
      }
      case "todo_clear": {
        if (!ctx || !convScope(ctx)) {
          return { ok: false, result: { error: "No conversation context." } };
        }
        try {
          await clearTodos(ctx.userId, convScope(ctx));
          return { ok: true, result: { cleared: true } };
        } catch (e) {
          return { ok: false, result: { error: e instanceof Error ? e.message : "todo_clear failed" } };
        }
      }
      case "ask_question": {
        const parsed = askQuestionSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, result: { error: formatZodError(parsed.error) } };
        }
        if (!ctx?.userId || !ctx?.conversationId) {
          return { ok: false, result: { error: "No user/conversation context for question prompt." } };
        }
        // Background subagents have no SSE emit channel, so the user can never
        // see or answer the question — fail fast instead of blocking for TTL.
        if (!ctx.emit) {
          return {
            ok: false,
            result: { error: "ask_question is not supported in background subagents." },
          };
        }

        const normalizedQuestions: QuestionPromptItem[] =
          parsed.data.questions && parsed.data.questions.length > 0
            ? parsed.data.questions.map((q) => ({
                question: q.question,
                options: q.options,
                isMultiSelect: q.is_multi_select,
              }))
            : [
                {
                  question: parsed.data.question!,
                  options: parsed.data.options,
                  isMultiSelect: parsed.data.is_multi_select,
                },
              ];

        const toolCallId = ctx.toolCallId ?? `tc_${Date.now()}`;
        const { id: questionId, promise } = createPendingQuestion({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          toolCallId,
          questions: normalizedQuestions,
        });

        ctx.emit({
          type: "tool_call_question",
          questionId,
          toolCallId,
          questions: normalizedQuestions,
          question: normalizedQuestions[0].question,
          options: normalizedQuestions[0].options,
          isMultiSelect: normalizedQuestions[0].isMultiSelect,
        });

        try {
          const answer = await raceWithAbort(promise, ctx.signal);
          return { ok: true, result: answer };
        } catch {
          cancelPendingQuestionsForConversation(ctx.conversationId);
          return {
            ok: false,
            result: { error: "Question prompt was cancelled or aborted." },
          };
        }
      }
      default:
        return { ok: false, result: { error: `Unknown tool: ${name}` } };
    }
  } catch (e) {
    return {
      ok: false,
      result: { error: e instanceof Error ? e.message : "Tool execution failed." },
    };
  }
}

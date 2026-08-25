import { z } from "zod";
import { THINKING_LEVEL_INPUTS, normalizeThinkingLevel } from "@/lib/reasoning";
import type { ThinkingLevelInput } from "@/lib/reasoning";
import { isValidRedactionRegex } from "@/lib/security-types";

const PROVIDER_IDS = [
  "puter",
  "openrouter",
  "openai",
  "anthropic",
  "groq",
  "nvidia",
  "mistral",
  "together",
  "gemini",
  "zen",
  "custom",
] as const;

const AGENT_MODES = ["agent", "chat", "architect"] as const;
const MCP_TRANSPORTS = ["stdio", "sse", "streamable-http"] as const;
const SHELLS = ["bash", "pwsh", "cmd", "zsh"] as const;

export const providerIdSchema = z.string().trim().min(1).max(100).refine(
  (val) => (PROVIDER_IDS as readonly string[]).includes(val) || val.startsWith("custom"),
  { message: "Invalid provider ID" }
);
export const agentModeSchema = z.enum(AGENT_MODES);
// streamable-http is accepted by the DB layer but NOT implemented by the MCP
// manager — reject it at save time with a clear message instead of failing an
// opaque "Unsupported transport format: streamable-http" at connect time.
export const mcpTransportSchema = z.enum(MCP_TRANSPORTS).refine(
  (val) => val !== "streamable-http",
  { message: "streamable-http transport is not supported yet — use stdio or sse." }
);
export const shellSchema = z.enum(SHELLS);

/**
 * Accepts canonical + legacy thinking levels and normalizes to canonical
 * (`disabled|default|enabled` map to `off|auto|auto`; unknown → `auto`).
 */
export const thinkingLevelSchema = z
  .enum(THINKING_LEVEL_INPUTS as unknown as [ThinkingLevelInput, ...ThinkingLevelInput[]])
  .transform(normalizeThinkingLevel);

const SAFE_STRING = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max);

const baseConversationFields = {
  title: z.string().trim().max(200).optional(),
  provider: providerIdSchema.optional(),
  model: z.string().trim().max(120).optional(),
  mode: agentModeSchema.optional(),
  systemPrompt: z.string().trim().max(20000).optional(),
  pinned: z.boolean().optional(),
} as const;

export const createConversationSchema = z.object({
  ...baseConversationFields,
  workspaceId: z.string().trim().min(1).max(64).optional(),
});

export const patchConversationSchema = z.object({
  ...baseConversationFields,
  workspaceId: z.string().trim().min(1).max(64).nullable().optional(),
});

export const chatRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
  // Generous upper bound so users can paste large specs/logs. The
  // server-side truncateHistory call handles context overflow; we don't
  // hard-stop the conversation here.
  message: z.string().trim().max(200000),
  provider: providerIdSchema,
  model: z.string().trim().min(1).max(120),
  mode: agentModeSchema.optional(),
  systemPrompt: z.string().trim().max(20000).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  mcpServerIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  enabledTools: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
  capabilities: z.array(z.string().trim().min(1).max(64)).max(40).optional(),
  temperature: z.number().min(0).max(2).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  editMessageId: z.string().trim().min(1).max(64).optional(),
  messageId: z.string().trim().min(1).max(64).optional(),
  maxIterations: z.number().int().min(1).max(500).optional(),
  autoWake: z.boolean().optional(),
  contextConfig:   z.object({
    pruneProtectTokens: z.number().int().min(1000).max(500000).optional(),
    compactionBuffer: z.number().int().min(1000).max(200000).optional(),
    outputTokenCap: z.number().int().min(1000).max(500000).optional(),
    tailTurns: z.number().int().min(1).max(10).optional(),
  }).optional(),
}).refine(
  (data) =>
    data.autoWake === true ||
    data.message.length >= 1 ||
    (data.attachmentIds && data.attachmentIds.length >= 1),
  { message: "Message is required when no attachments are provided", path: ["message"] },
).refine(
  (data) => noNulBytes(data.message),
  { message: "Message cannot contain NUL bytes", path: ["message"] },
);

/** Validation schema for queuing a user turn into an actively running agent loop. */
export const queueMessageSchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
  message: z.string().trim().max(200000),
  // Required: the client appends the message locally with this id so the
  // persisted row dedupes cleanly on refresh and the executor can track it.
  messageId: z.string().trim().uuid(),
  attachmentIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
}).refine(
  (data) => data.message.length >= 1 || (data.attachmentIds && data.attachmentIds.length >= 1),
  { message: "Message is required when no attachments are provided", path: ["message"] },
).refine(
  (data) => noNulBytes(data.message),
  { message: "Message cannot contain NUL bytes", path: ["message"] },
);

/** Validation schema for security settings with regex syntax validation. */
export const securitySettingsSchema = z
  .object({
    autoScrubSecrets: z.boolean().optional(),
    customRedactionRegex: z.string().trim().max(2048).optional(),
  })
  .strict()
  .refine((d) => isValidRedactionRegex(d.customRedactionRegex), {
    message: "customRedactionRegex is not a valid regular expression",
    path: ["customRedactionRegex"],
  });

/** MIME allowlist for chat attachments (images, documents, and code files). */
export const ALLOWED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  // Images — all common raster + SVG.
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
  "image/tiff",
  "image/x-icon",
  // Documents.
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  // Text & code.
  "text/plain",
  "text/markdown",
  "text/html",
  "text/css",
  "text/csv",
  "text/javascript",
  "text/typescript",
  "text/jsx",
  "text/tsx",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/x-sh",
  "application/typescript",
  "application/javascript",
  // Data.
  "application/zip",
  "application/x-tar",
  "application/gzip",
  // Catch-all for unknown but small text-like files (the upload endpoint
  // sniffs the first bytes and re-classifies plain-text-looking blobs).
  "application/octet-stream",
]);

/** Hard ceiling on a single attachment. Enforced both client- and server-side. */
export const MAX_ATTACHMENT_BYTES = 50 * 1000 * 1000; // 50 MB

/** Max number of attachments on a single chat request. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export function noNulBytes(content: string): boolean {
  return !content.includes("\u0000");
}

export function isAllowedAttachmentType(type: string): boolean {
  const lower = (type || "").toLowerCase().trim();
  if (!lower) return false;
  // Allow image/* and text/* families without enumerating every variant.
  if (lower.startsWith("image/")) return true;
  if (lower.startsWith("text/")) return true;
  return ALLOWED_ATTACHMENT_TYPES.has(lower);
}

export const saveKeySchema = z.object({
  provider: providerIdSchema,
  apiKey: z.string().trim().min(1).max(4096),
  baseUrl: z.string().trim().url().max(2048).optional(),
  models: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

export const createMcpServerSchema = z.object({
  name: SAFE_STRING(120),
  transport: mcpTransportSchema,
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().trim().max(500)).max(50).optional(),
  env: z.record(z.string(), z.string().trim().max(500)).optional(),
  url: z.string().trim().url().max(2048).optional(),
  headers: z.record(z.string(), z.string().trim().max(2000)).optional(),
});

export const terminalSchema = z.object({
  command: z.string().trim().min(1).max(1000),
  shell: shellSchema,
  cwd: z.string().trim().max(500).optional(),
});

export const createPluginSchema = z.object({
  name: SAFE_STRING(120),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(["plugin", "skill"]).optional(),
  source: z.string().trim().max(500).optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
});

export const togglePluginSchema = z.object({
  enabled: z.boolean(),
});

export const idParamSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

export const providerParamSchema = z.object({
  provider: providerIdSchema,
});

export const createPresetSchema = z.object({
  name: SAFE_STRING(120),
  description: z.string().trim().max(2000).optional(),
  systemPrompt: z.string().trim().min(1).max(20000),
  provider: providerIdSchema.optional(),
  model: z.string().trim().max(120).optional(),
  tools: z.array(z.string().trim().max(64)).max(40).optional(),
  temperature: z.number().min(0).max(2).optional(),
  icon: z.string().trim().max(64).optional(),
});

export const testProviderSchema = z.object({
  provider: providerIdSchema,
  apiKey: z.string().trim().max(4096).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type PatchConversationInput = z.infer<typeof patchConversationSchema>;
export type ChatInput = z.infer<typeof chatRequestSchema>;
export type SaveKeyInput = z.infer<typeof saveKeySchema>;
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type TerminalInput = z.infer<typeof terminalSchema>;
export type CreatePluginInput = z.infer<typeof createPluginSchema>;
export type CreatePresetInput = z.infer<typeof createPresetSchema>;
export type TestProviderInput = z.infer<typeof testProviderSchema>;

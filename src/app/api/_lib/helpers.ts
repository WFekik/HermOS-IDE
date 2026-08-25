import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeJsonParse } from "@/lib/utils";
import { normalizeThinkingLevel } from "@/lib/reasoning";
import { isAgentRunning } from "@/lib/agent-abort";
import type {
  AgentPresetDTO,
  ConversationDTO,
  McpServerDTO,
  MessageDTO,
  PluginDTO,
  ProviderId,
  ProviderKeyDTO,
  ToolCall,
  UserDTO,
} from "@/lib/types";

const SYSTEM_USER_EMAIL = "system@hermos.local";

export async function getSystemUserId(): Promise<string> {
  const u = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL } });
  if (u) return u.id;
  const created = await db.user.create({
    data: { email: SYSTEM_USER_EMAIL, name: "System", provider: "local", role: "system" },
  });
  return created.id;
}

export { SYSTEM_USER_EMAIL };

export function apiError(
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized", code: "UNAUTHORIZED" },
    { status: 401 },
  );
}

/**
 * Host / Origin policy (defense in depth for a local-first IDE served over
 * loopback HTTP that may be remotely exposed):
 *   - The PRIMARY control is the server binding itself (HOSTNAME=127.0.0.1 in
 *     the desktop shell and start-standalone.mjs); this policy is a second
 *     layer that rejects obviously wrong `Host` values.
 *   - SECURITY NOTE — Host header alone is INSUFFICIENT and trivially spoofable:
 *     `Host` is a client-supplied header. An attacker with TCP reachability to
 *     the listening socket (e.g. if the server were ever bound to 0.0.0.0 due
 *     to a misconfig, container default, or env override — `next dev` defaults
 *     to 0.0.0.0 unless `-H 127.0.0.1` is passed) can send `Host: localhost`
 *     and bypass a Host-only check while still reaching the privileged local
 *     API. That path is unauthenticated RCE because `requireUser()` unconditionally
 *     returns the local admin user (see session.ts) in desktop mode.
 *     Therefore this module ALSO enforces (a) at request time that the server
 *     is actually bound to loopback (HOSTNAME env) unless an explicit secret
 *     gate such as HERMOS_ALLOW_REMOTE or TRUST_PROXY is configured, and (b)
 *     where a trustworthy remote address is available (NextRequest.ip or
 *     TRUST_PROXY-gated X-Forwarded-For/X-Real-IP), verifies the remote IP
 *     itself is loopback. Host-only checks are retained as defense-in-depth
 *     but never as the sole gate.
 *   - `Host` header must be a loopback host: `127.0.0.1[:port]`,
 *     `localhost[:port]`, `[::1][:port]`, the Tauri WebView hosts
 *     (`tauri://localhost`, `tauri.localhost`) and any `.localhost` suffix.
 *     A missing `Host` header falls back to the URL host (Next.js synthesizes
 *     `req.url` from its own server context, so this is advisory, not a
 *     remote-attacker vector).
 *   - For mutating methods (POST/PUT/PATCH/DELETE), an `Origin`/`Referer` whose
 *     host is NOT loopback is refused 403. Desktop/local clients that send no
 *     Origin/Referer are accepted (warned once).
 *   - Returns an error message string, or null when the request passes.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let warnedNoOrigin = false;

export function isLoopbackHost(rawHost: string | null | undefined): boolean {
  let h = (rawHost ?? "").trim().toLowerCase();
  if (!h) return false;
  if (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "tauri://localhost" ||
    h === "tauri.localhost"
  ) {
    return true;
  }
  // Any RFC-6761 `.localhost` suffix is loopback-only by definition.
  if (h.endsWith(".localhost")) return true;
  const portMatch = /^(.+):\d+$/.exec(h);
  if (!portMatch) return false;
  h = portMatch[1];
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "tauri://localhost" ||
    h === "tauri.localhost" ||
    h.endsWith(".localhost")
  );
}

export function isLoopbackUrlOrigin(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const hostname = u.hostname.toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
    return true;
  }
  return hostname === "tauri.localhost" || hostname.endsWith(".localhost");
}

function extractUrlHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    return null;
  }
}

export function validateHostPolicy(req: Request): string | null {
  const host = req.headers.get("host");
  const urlHost = extractUrlHost(req.url);
  // Programmatic clients (tests, desktop shell, fetch) may omit the Host
  // header; the URL host is authoritative in that case. When both are
  // present they must both be loopback.
  const effective = host?.trim() ? host : urlHost;
  if (!effective) {
    return "Host header is required.";
  }
  if (!isLoopbackHost(effective)) {
    return "Host header is not allowed.";
  }
  if (host?.trim() && urlHost && !isLoopbackHost(urlHost)) {
    return "Host header is not allowed.";
  }
  if (MUTATING_METHODS.has(req.method.toUpperCase())) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    if (origin && !isLoopbackUrlOrigin(origin)) {
      return "Origin is not allowed.";
    }
    if (referer && !isLoopbackUrlOrigin(referer)) {
      return "Referer is not allowed.";
    }
    if (!origin && !referer && !warnedNoOrigin) {
      warnedNoOrigin = true;
      console.warn(
        "[api:host-check] Mutating request without Origin/Referer — accepted (desktop/local client).",
      );
    }
  }
  return null;
}

function isLoopbackBind(hostname: string | undefined): boolean {
  // When HOSTNAME is unset, Next may still be loopback-bound via CLI flag
  // (`next dev -H 127.0.0.1` per package.json dev script). Treat unset as
  // loopback to avoid breaking `npm run dev`; explicit non-loopback values
  // (0.0.0.0, ::, etc.) are still blocked by the caller when no opt-in gate.
  if (!hostname) return true;
  const h = hostname.trim().toLowerCase();
  // HOSTNAME is typically bare (no port) but tolerate :port for robustness
  return isLoopbackHost(h);
}

function getTrustworthyRemoteIp(req: Request): string | null {
  const anyReq = req as unknown as { ip?: string };
  if (typeof anyReq.ip === "string" && anyReq.ip.trim()) return anyReq.ip.trim();
  if (process.env.TRUST_PROXY === "true") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff && xff.trim()) return xff.split(",")[0].trim();
    const xri = req.headers.get("x-real-ip");
    if (xri && xri.trim()) return xri.trim();
  }
  return null;
}

function isLoopbackRemoteIp(ip: string): boolean {
  let h = ip.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Strip port if present (defensive, though remote IP should not include port)
  const portIdx = h.lastIndexOf(":");
  // Only strip if it looks like host:port and not an IPv6 literal (multiple colons)
  if (h.includes(":") && h.indexOf(":") === h.lastIndexOf(":") && /:\d+$/.test(h)) {
    h = h.slice(0, portIdx);
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  }
  if (h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "0:0:0:0:0:ffff:127.0.0.1" || h === "localhost" || h === "tauri.localhost") return true;
  if (h.endsWith(".localhost")) return true;
  return isLoopbackHost(h);
}

/** Returns a 403 NextResponse when the request violates the Host/Origin policy, else null. */
export function enforceLoopbackRequest(req: Request | null | undefined): NextResponse | null {
  if (!req) return null;
  // Runtime bind enforcement: the server MUST be bound to loopback in desktop mode.
  // next dev defaults to 0.0.0.0; start-standalone.mjs and Tauri set HOSTNAME=127.0.0.1.
  // If the operator deliberately binds to an external interface, they MUST opt-in via
  // HERMOS_ALLOW_REMOTE=true or TRUST_PROXY=true (behind a trusted proxy). Without
  // that, Host-header checks are trivially bypassable (attacker sends Host: localhost
  // over a remotely-reachable socket) and would expose unauthenticated RCE via
  // requireUser() -> local admin.
  const bindHost = process.env.HOSTNAME?.trim();
  if (bindHost && !isLoopbackBind(bindHost)) {
    const hasExplicitGate = process.env.HERMOS_ALLOW_REMOTE === "true" || process.env.TRUST_PROXY === "true";
    if (!hasExplicitGate) {
      const isAllInterfaces = bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "[::]" || bindHost === "0:0:0:0";
      const msg = isAllInterfaces
        ? "Server is bound to 0.0.0.0 (all interfaces) without an authentication gate — refusing request. Set HOSTNAME=127.0.0.1 for desktop loopback or configure HERMOS_ALLOW_REMOTE=true / TRUST_PROXY=true behind a trusted proxy."
        : `Server is bound to non-loopback interface "${bindHost}" without an authentication gate — refusing request. Set HOSTNAME=127.0.0.1 for desktop loopback or configure HERMOS_ALLOW_REMOTE=true / TRUST_PROXY=true.`;
      return apiError(msg, 403);
    }
  }
  const reason = validateHostPolicy(req);
  if (reason) return apiError(reason, 403);
  // IP-level defense-in-depth: Host is client-controlled and spoofable, so where a
  // trustworthy remote IP is available (NextRequest.ip or trusted X-Forwarded-For /
  // X-Real-IP when TRUST_PROXY=true) verify the peer itself is loopback.
  const remoteIp = getTrustworthyRemoteIp(req);
  if (remoteIp && !isLoopbackRemoteIp(remoteIp)) {
    return apiError(`Remote address is not loopback (${remoteIp}) — requests must originate from the local machine.`, 403);
  }
  return null;
}

/** Locate the Request/NextRequest among a route handler's variadic args. */
function findRequest(args: unknown[]): Request | null {
  for (const arg of args) {
    if (arg instanceof Request) return arg;
  }
  return null;
}

export function notFound(message = "Not found"): NextResponse {
  return NextResponse.json({ error: message, code: "NOT_FOUND" }, { status: 404 });
}

export function ok(data: unknown = { ok: true }, headers?: Record<string, string>): NextResponse {
  return headers ? NextResponse.json(data, { headers }) : NextResponse.json(data);
}

/** Wrap a handler that may throw "UNAUTHORIZED" and other errors. */
export function withErrorHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<Response | NextResponse>,
): (...args: T) => Promise<Response | NextResponse> {
  return async (...args: T) => {
    try {
      // Host/Origin + bind + IP policy gate — enforced here so every route that
      // flows through this wrapper is covered (auth, providers, mcp, agents, …).
      // Includes runtime check that the server is actually bound to loopback
      // (HOSTNAME) and, where trustworthy, that the remote IP itself is loopback.
      const blocked = enforceLoopbackRequest(findRequest(args));
      if (blocked) return blocked;
      return await fn(...args);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        return unauthorized();
      }
      const details = e instanceof Error ? e.message : "Internal server error";
      // Log server-side, return generic message to client
      console.error("[api:error]", details, e);
      return apiError("Internal server error", 500, { code: "INTERNAL" });
    }
  };
}

export interface GuardedRouteOptions<TBody> {
  schema?: { safeParse: (data: unknown) => { success: true; data: TBody } | { success: false; error: { issues: Array<{ message: string }> } } };
  rateLimit?: { keyPrefix: string; config: { capacity: number; refillPerSec: number } };
  requireAuth?: boolean;
}

/** Composable typed route handler encapsulating auth, rate-limiting, JSON parsing, and validation. */
export function createGuardedHandler<TBody = unknown>(
  options: GuardedRouteOptions<TBody>,
  handler: (ctx: { user: UserDTO; body: TBody; req: Request }) => Promise<Response | NextResponse>,
): (req: Request) => Promise<Response | NextResponse> {
  return withErrorHandler(async (req: Request) => {
    let user: UserDTO | undefined;
    if (options.requireAuth !== false) {
      const { requireUser } = await import("@/lib/session");
      user = await requireUser();
    }
    if (options.rateLimit && user) {
      const { withRateLimit } = await import("@/lib/rate-limit");
      const limited = await withRateLimit(req as any, `${options.rateLimit.keyPrefix}:${user.id}`, options.rateLimit.config);
      if (limited) return limited;
    }
    let parsedBody = undefined as unknown as TBody;
    if (options.schema) {
      const raw = await parseJson(req);
      if (!raw) return apiError("Invalid JSON body.", 400);
      const parsed = options.schema.safeParse(raw);
      if (!parsed.success) {
        return apiError(parsed.error.issues[0]?.message || "Validation failed.", 400);
      }
      parsedBody = parsed.data;
    }
    return handler({ user: user!, body: parsedBody, req });
  });
}

export function toMessageDTO(r: {
  id: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  model: string | null;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  promptTokens?: number;
  cacheWrites?: number;
  cacheReads?: number;
  latencyMs: number;
  segments?: string | null;
  attachments?: string | null;
  createdAt: Date;
}): MessageDTO {
  const toolCalls = r.toolCalls ? safeJsonParse<ToolCall[]>(r.toolCalls) : undefined;
  const segments = r.segments ? safeJsonParse<any[]>(r.segments) : undefined;
  const attachments = r.attachments ? safeJsonParse<MessageDTO["attachments"]>(r.attachments) : undefined;
  return {
    id: r.id,
    role: (r.role as MessageDTO["role"]) || "user",
    content: r.content,
    thinking: r.thinking ?? undefined,
    toolCalls,
    toolCallId: r.toolCallId ?? undefined,
    model: r.model ?? undefined,
    provider: r.provider ?? undefined,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    promptTokens: r.promptTokens,
    cacheWrites: r.cacheWrites,
    cacheReads: r.cacheReads,
    latencyMs: r.latencyMs,
    segments,
    attachments,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toConversationDTO(c: {
  id: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string | null;
  mode: string;
  pinned: boolean;
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  messages?: Array<Parameters<typeof toMessageDTO>[0]>;
  isAgentRunning?: boolean;
}): ConversationDTO {
  return {
    id: c.id,
    title: c.title,
    provider: c.provider as ProviderId,
    model: c.model,
    systemPrompt: c.systemPrompt,
    mode: c.mode as ConversationDTO["mode"],
    pinned: c.pinned,
    workspaceId: c.workspaceId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    messages: c.messages?.map(toMessageDTO),
    isAgentRunning: c.isAgentRunning !== undefined ? c.isAgentRunning : isAgentRunning(c.id),
  };
}

export function toProviderKeyDTO(r: {
  provider: string;
  keyHint: string;
  baseUrl: string | null;
  models: string | null;
  isActive: boolean;
}): ProviderKeyDTO {
  let models: string[] | undefined;
  let modelsConfig: Array<{ id: string; enabled?: boolean; thinkingLevel?: string }> | undefined;
  if (r.models) {
    const parsed = safeJsonParse<unknown[]>(r.models);
    if (Array.isArray(parsed)) {
      models = parsed.map((m: any) => (typeof m === "string" ? m : m.id));
      modelsConfig = parsed.map((m: any) => {
        if (typeof m === "string") {
          return { id: m, enabled: true, thinkingLevel: "default" };
        }
        return {
          id: String(m.id),
          enabled: m.enabled !== false,
          thinkingLevel: normalizeThinkingLevel(m.thinkingLevel),
        };
      });
    }
  }
  // keyHint column stores the raw last 4 chars of the API key; we expose
  // a masked form `••••<last4>` so users can identify which key is set
  // without the raw key ever leaving the server.
  const safeHint = r.keyHint ? `••••${r.keyHint.slice(-4)}` : undefined;
  return {
    provider: r.provider as ProviderId,
    hasKey: true,
    keyHint: safeHint,
    baseUrl: r.baseUrl ?? undefined,
    models,
    modelsConfig,
    isActive: r.isActive,
  };
}

export function toMcpServerDTO(r: {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
  status: string;
  lastError: string | null;
  tools: string | null;
  createdAt: Date;
}): McpServerDTO {
  const args = r.args ? safeJsonParse<string[]>(r.args) : undefined;
  const env = r.env ? safeJsonParse<Record<string, string>>(r.env) : undefined;
  const headers = r.headers ? safeJsonParse<Record<string, string>>(r.headers) : undefined;
  const tools = r.tools ? safeJsonParse<McpServerDTO["tools"]>(r.tools) : undefined;
  return {
    id: r.id,
    name: r.name,
    transport: r.transport as McpServerDTO["transport"],
    command: r.command ?? undefined,
    args,
    env,
    url: r.url ?? undefined,
    headers,
    status: r.status as McpServerDTO["status"],
    lastError: r.lastError ?? undefined,
    tools,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toPluginDTO(r: {
  id: string;
  name: string;
  description: string | null;
  type: string;
  version: string;
  source: string;
  enabled: boolean;
  manifest: string | null;
  createdAt: Date;
}): PluginDTO {
  const manifest = r.manifest ? safeJsonParse<Record<string, unknown>>(r.manifest) : undefined;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    type: r.type as "plugin" | "skill",
    version: r.version,
    source: r.source,
    enabled: r.enabled,
    manifest,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toPresetDTO(r: {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  tools: string | null;
  temperature: number;
  isBuiltin: boolean;
}): AgentPresetDTO {
  const tools = r.tools ? safeJsonParse<string[]>(r.tools) : undefined;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    systemPrompt: r.systemPrompt,
    provider: r.provider as ProviderId,
    model: r.model,
    tools,
    temperature: r.temperature,
    isBuiltin: r.isBuiltin,
  };
}

export async function audit(
  userId: string | null,
  action: string,
  details?: string,
  ip?: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: { userId, action, details, ip },
    });
  } catch (e) {
    console.error("[audit] failed:", e);
  }
}

export async function parseJson<T = unknown>(req: Request): Promise<T | null> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  return text ? (safeJsonParse<T>(text) ?? null) : null;
}


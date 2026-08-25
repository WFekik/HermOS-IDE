/**
 * Subagent worker execution loop: spawns background tasks in isolated reasoning loops,
 * executes permitted tools, and publishes structured completion reports to the parent session.
 */
import {
  stripHtml,
  parseRetryHeader,
  getErrorStatusCode,
  isTransientStreamError,
} from "@/lib/ai/retry-utils";
import { PROVIDERS, getProvider, requiresReasoningEcho, rememberReasoningEchoRequired } from "@/lib/ai/providers";
import { type ProviderId } from "@/lib/types";
import type {
  SubagentSession,
  SubagentSessionMessage,
  SubagentReport,
} from "./subagent-session";
import {
  createSession,
  internalGet,
  getSession,
  updateSession,
  appendMessage,
  appendProgress,
  registerSessionAbort,
  unregisterSessionAbort,
  streamSubagentPartial,
  clearSubagentPartial,
} from "./subagent-session";
import {
  enqueueSubagentReport,
  enqueueSubagentMessage,
  unmarkSubagentReportDelivered,
  drainSubagentMailbox,
} from "./subagent-queue";
import { runTool, resolveWs, PUBLIC_BUILTIN_TOOLS, type ToolCtx } from "@/lib/ai/tools";
import {
  getCompletedCommand,
  acknowledgeCompletedCommand,
  stopRunningCommand,
} from "@/lib/workspace";
import { evaluateToolPermission, getPermissions, isReadOnlyTool, isWriteTool, type PermissionMode } from "@/lib/permissions";
import {
  configureRequestBody,
  parseSseReasoningChunk,
  sanitizeRejectedReasoningParams,
  ANTHROPIC_SDK_DEFAULT_MAX_TOKENS,
} from "@/lib/ai/provider-payloads";
import {
  resolveReasoningPlan,
  normalizeThinkingLevel,
  modelRejectsReasoning,
  type ReasoningPlan,
} from "@/lib/reasoning";
import { decrypt } from "@/lib/encryption";
import { db } from "@/lib/db";
import { buildDiscoveryBlock } from "./discovery";
import { refreshProviderModels } from "@/lib/provider-fetch";
import { assertUrlAllowed } from "@/lib/ssrf";
import { truncateHistory, pruneOldToolOutputs, estimateTokens } from "@/lib/ai/context";
import { getSecuritySettings } from "@/lib/security-settings";
import { scrubHistoryForWire, scrubPromptString } from "@/lib/security-scrub";
import { fitPayloadToBudget, recoverGroqTpmRateLimit } from "./token-budget";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { peekModelInRegistry } from "@/lib/models-dev";

/** Character limit for subagent conclusion injected into parent conversation. */
const SUBAGENT_REPORT_MAX_CHARS = 160_000;

/** Subagent session read tracker to catch repeated reads of identical line ranges. */
const subagentReadTracker = new Map<string, Set<string>>();



interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** Verbatim thinking text echoed back on assistant messages for reasoning models. */
  reasoning_content?: string;
}

interface StreamChunk {
  type: "content" | "thinking" | "tool_calls" | "finish" | "tools_rejected";
  text?: string;
  reason?: string;
  calls?: Array<{ id: string; name: string; arguments: string }>;
}

export const DEFAULT_SUBAGENT_PROMPT = `You are an HermOS research subagent. Gather ground truth, report precisely.

- READ-ONLY TOOLS ONLY: read_file, list_directory, glob, grep, web_search, http_fetch.
- GROUND TRUTH: report only observed facts. If a tool returned nothing, an error, or a denial, say exactly that — never invent paths.
- GATHER 2-4 pieces of evidence before answering; do not stop after one call.
- NO OVERTHINKING: read files <500 lines in one call; for larger files read by range. Never re-read identical ranges.
- PROTECT SECRETS: never repeat credential content or API keys in your report.
- REPORT ONLY: 1-sentence headline + 2-5 evidence bullets with exact paths. No preamble.`;

export const DEFAULT_WORKER_SUBAGENT_PROMPT = `You are an HermOS worker subagent. Execute the task precisely, then verify.

- GROUND TRUTH: base actions on observed tool outputs; never invent paths, code, or results.
- NATIVE TOOL CALLS: Call function tools directly (e.g. command_stop, write_file). NEVER execute tool names like "command_stop" as shell command strings in PowerShell or bash.
- SEQUENTIAL EDITS: edits/commands one at a time, character-exact.
- FAIL TO DIAGNOSE: ok:false → read the error, fix, retry — never silently continue.
- VERIFY: after writing/editing, read the result back (or run a check) before reporting success.
- MINIMAL: change only what the task requires; no stubs or TODOs.
- PROTECT SECRETS: never print, echo, or write real keys, tokens, or secrets.
- REPORT ONLY: 1-sentence summary, files changed, verification. No preamble.`;

import { cleanContent, parseTextToolCalls, parseNonStreamingResponse, extractUpstreamError } from "@/lib/ai/tool-call-parser";

/** Select subagent prompt based on tool access — workers that can write get the verification-focused prompt. */
function selectSubagentPrompt(allowedTools?: string[]): string {
  if (!allowedTools || allowedTools.length === 0) return DEFAULT_SUBAGENT_PROMPT;
  // create_artifact writes artifacts but does not modify workspace files directly.
  const hasWriteAccess = allowedTools.some(t => isWriteTool(t) && t !== "create_artifact");
  return hasWriteAccess ? DEFAULT_WORKER_SUBAGENT_PROMPT : DEFAULT_SUBAGENT_PROMPT;
}

/** Apply a terminal transition and queue the report for the main agent. */
function finishSubagent(sessionId: string, patch: Partial<SubagentSession>): void {
  updateSession(sessionId, patch);
  const live = internalGet(sessionId);
  if (live) enqueueSubagentReport(live.userId, live.parentConversationId, sessionId);
}

/** Public spawn — fire-and-forget; returns the freshly-created session. */
export function spawnSubagent(
  userId: string,
  conversationId: string,
  opts: {
    name: string;
    task: string;
    systemPrompt?: string;
    allowedTools?: string[];
    provider?: string;
    model?: string;
    checkpointId?: string;
    thinkingLevel?: string;
  },
): { subagentId: string; name: string; status: "running" } {
  const session = createSession(userId, conversationId, {
    name: opts.name,
    task: opts.task,
    systemPrompt: opts.systemPrompt || selectSubagentPrompt(opts.allowedTools),
    allowedTools: opts.allowedTools ?? [],
    provider: opts.provider || "",
    model: opts.model || "",
    checkpointId: opts.checkpointId,
    thinkingLevel: opts.thinkingLevel,
  });
  // Fire-and-forget with error boundary to prevent awaitSubagents from hanging on early crash.
  runSubagentWorker(session.id).catch((err) => {
    console.error(`[subagent:${session.id}] worker crashed:`, err);
    finishSubagent(session.id, {
      status: "failed",
      error: err instanceof Error ? err.message : "Worker crashed unexpectedly",
      completedAt: Date.now(),
    });
  });
  return { subagentId: session.id, name: session.name, status: "running" };
}

/** Run the focused, single-shot reasoning loop. */
async function runSubagentWorker(sessionId: string, opts?: { resume?: boolean }): Promise<void> {
  const session = internalGet(sessionId);
  if (!session) {
    return;
  }

  updateSession(sessionId, { status: "thinking" });
  if (!opts?.resume) {
    appendProgress(sessionId, "Subagent started");
    appendMessage(sessionId, { role: "system", content: session.systemPrompt });
    appendMessage(sessionId, { role: "user", content: session.task });
  }

  // Per-session abort signal so long tool waits resolve immediately when cancelled.
  const sessionAbort = new AbortController();
  registerSessionAbort(sessionId, sessionAbort);

  try {
    const byok = await resolveProvider(session.userId, session.provider, session.model);
    if (!byok) {
      finishSubagent(sessionId, {
        status: "failed",
        error: "No provider available for this user.",
        completedAt: Date.now(),
      });
      return;
    }
    const availableTools = pickTools(session.allowedTools);
    const discoveryBlock = await buildDiscoveryBlock(session.userId);
    // Resolve workspace root once to canonicalize tool lock keys with the parent agent.
    const subagentRootDir = await resolveWs(session.userId, session.parentConversationId)
      .then((ws) => ws.rootDir)
      .catch(() => undefined);

    // Server-authoritative secret scrubbing so prompts, history, and tools never leak creds.
    const securitySettings = await getSecuritySettings(session.userId);

    // Tracks if loop exited via final-answer break rather than max-iteration cut.
    let stoppedAfterAnswer = false;

    for (let iter = 0; iter < 100; iter++) {
      const live = internalGet(sessionId);
      if (!live || sessionAbort.signal.aborted) return;
      const mailbox = drainSubagentMailbox(sessionId);
      if (mailbox.length > 0) {
        for (const m of mailbox) appendMessage(sessionId, { role: "user", content: `[Message from main agent]\n\n${m}` });
        appendProgress(sessionId, `Received ${mailbox.length} message(s) from main agent`);
      }

      // Check if a background command started by this subagent has finished
      const completedCmd = getCompletedCommand(session.userId, sessionId);
      if (completedCmd) {
        acknowledgeCompletedCommand(session.userId, sessionId);
        const cmdOk = !completedCmd.exitCode || completedCmd.exitCode === 0;
        const resultContent = `Command: ${completedCmd.command} (${cmdOk ? "completed" : "FAILED"})\nExit code: ${completedCmd.exitCode ?? 0}\n\n--- STDOUT ---\n${completedCmd.stdout}\n${completedCmd.stderr?.trim() ? `--- STDERR ---\n${completedCmd.stderr}\n` : ""}`;
        appendMessage(sessionId, {
          role: "user",
          content: `[System: Background command completed]\n${resultContent}`,
        });
        appendProgress(sessionId, `Background command "${completedCmd.command.slice(0, 30)}" completed`);
      }

      const currentMessages = live.messages;

      updateSession(sessionId, { status: "thinking" });
      appendProgress(sessionId, `Iteration ${iter + 1}: thinking`);

      let iterContent = "";
      let iterThinking = "";
      let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      // Throttle live partial streaming (~60ms) to avoid O(n²) string clean passes on each chunk.
      let lastPartialFlush = 0;
      let partialTimeout: ReturnType<typeof setTimeout> | null = null;
      const flushPartial = () => {
        partialTimeout = null;
        lastPartialFlush = Date.now();
        const live = internalGet(sessionId);
        if (!live || live.status === "completed" || live.status === "failed") return;
        streamSubagentPartial(sessionId, cleanContent(iterContent), iterThinking);
      };
      const schedulePartial = () => {
        const elapsed = Date.now() - lastPartialFlush;
        if (elapsed >= 60) {
          if (partialTimeout) { clearTimeout(partialTimeout); partialTimeout = null; }
          flushPartial();
        } else if (!partialTimeout) {
          partialTimeout = setTimeout(flushPartial, 60 - elapsed);
        }
      };
      const clearPartialTimer = () => {
        if (partialTimeout) { clearTimeout(partialTimeout); partialTimeout = null; }
      };
      // Track upstream finish_reason ("length" = output budget exhausted) to retry truncated outputs.
      let lastFinishReason: string | undefined;
      let budgetRetried = false;
      let budgetMaxTokens: number | undefined;
      // Tracks if reasoning_content must be echoed; upgraded on 4xx when thinking text is present.
      let echoReasoning = requiresReasoningEcho(byok.baseUrl);
      let echoUpgraded = false;

      for (let attempts = 0; ; attempts++) {
        try {
          let maxTokens: number | undefined;
          let subagentContextWindow: number | undefined = PROVIDERS[session.provider as ProviderId]?.models.find(
            (m) => m.id === byok.model,
          )?.contextWindow;
          try {
            const row = await db.providerKey.findUnique({
              where: { userId_provider: { userId: session.userId, provider: session.provider as ProviderId } },
            });
            if (row?.models) {
              const parsed: unknown = JSON.parse(row.models);
              if (Array.isArray(parsed)) {
                const entry = parsed.find(
                  (m: unknown) =>
                    m && typeof m === "object" && "id" in m && (m as { id: string }).id === byok.model,
                );
                if (entry && typeof entry === "object") {
                  if ("contextWindow" in entry && typeof (entry as { contextWindow: number }).contextWindow === "number") {
                    subagentContextWindow = (entry as { contextWindow: number }).contextWindow;
                  }
                  if ("maxOutput" in entry && typeof (entry as { maxOutput: number }).maxOutput === "number") {
                    const maxOut = (entry as { maxOutput: number }).maxOutput;
                    if (subagentContextWindow === undefined || maxOut < subagentContextWindow) {
                      maxTokens = maxOut;
                    }
                  }
                }
              }
            }
          } catch {
            // fall through, limits stay default
          }

          if (session.provider === "anthropic" && maxTokens === undefined) {
            await refreshProviderModels(session.userId, "anthropic");
            try {
              const row = await db.providerKey.findUnique({
                where: { userId_provider: { userId: session.userId, provider: "anthropic" } },
              });
              if (row?.models) {
                const parsed: unknown = JSON.parse(row.models);
                if (Array.isArray(parsed)) {
                  const entry = parsed.find(
                    (m: unknown) =>
                      m && typeof m === "object" && "id" in m && (m as { id: string }).id === byok.model,
                  );
                  if (entry && typeof entry === "object") {
                    if ("contextWindow" in entry && typeof (entry as { contextWindow: number }).contextWindow === "number") {
                      subagentContextWindow = (entry as { contextWindow: number }).contextWindow;
                    }
                    if ("maxOutput" in entry && typeof (entry as { maxOutput: number }).maxOutput === "number") {
                      const maxOut = (entry as { maxOutput: number }).maxOutput;
                      if (subagentContextWindow === undefined || maxOut < subagentContextWindow) {
                        maxTokens = maxOut;
                      }
                    }
                  }
                }
              }
            } catch {
              // fall through, limits stay default
            }
          }

          if (subagentContextWindow === undefined || maxTokens === undefined) {
            const reg = await peekModelInRegistry(byok.model, session.provider, { core: true });
            if (subagentContextWindow === undefined && reg?.contextWindow !== undefined) {
              subagentContextWindow = reg.contextWindow;
            }
            if (maxTokens === undefined && reg?.maxOutput !== undefined) {
              if (reg.contextWindow === undefined || reg.maxOutput < reg.contextWindow) {
                maxTokens = reg.maxOutput;
              }
            }
          }

          // Budget retry override: if an earlier attempt hit
          // `finish_reason: "length"` and the models.dev registry documents a
          // higher maxOutput, use that so the retry isn't cut off again.
          if (budgetMaxTokens !== undefined) {
            maxTokens = budgetMaxTokens;
          }

          // Preserve all subagent message fields (toolCalls, toolCallId, thinking)
          // so the model sees its own past tool calls in history and doesn't
          // repeat the same call infinitely. The main executor (executor.ts)
          // preserves these fields — the subagent must do the same.
          const effectiveContextWindow = subagentContextWindow ?? lookupContextWindow(byok.model);
          interface SubagentTruncationMsg {
            role: string;
            content: string;
            createdAt: Date;
            thinking?: string;
            toolCallId?: string;
            toolCalls?: Array<{ id: string; name: string; arguments: string }>;
          }
          const truncationMsgs: SubagentTruncationMsg[] = currentMessages.map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: new Date(),
            thinking: m.thinking,
            toolCallId: m.toolCallId,
            toolCalls: m.toolCalls,
          }));
          const { messages: prunedMsgs } = pruneOldToolOutputs(truncationMsgs, {
            contextWindow: effectiveContextWindow,
          });
          const truncatedRes = truncateHistory(
            prunedMsgs,
            session.systemPrompt + discoveryBlock,
            {
              contextWindow: effectiveContextWindow,
              // 0 = unknown — let provider default apply without reservation.
              maxOutputTokens: maxTokens ?? 0,
            },
          );
          const truncatedMsgs: SubagentSessionMessage[] = scrubHistoryForWire(
            truncatedRes.messages.map((m) => ({
              role: m.role as SubagentSessionMessage["role"],
              content: m.content,
              thinking: (m as SubagentTruncationMsg).thinking,
              toolCallId: (m as SubagentTruncationMsg).toolCallId,
              toolCalls: (m as SubagentTruncationMsg).toolCalls,
            })),
            securitySettings,
          );
          const subagentSystemPrompt =
            scrubPromptString(session.systemPrompt + discoveryBlock, securitySettings) ?? "";

          // Normalize thinking level; unknown resolves to "auto" allowing provider default.
          const tl = normalizeThinkingLevel(session.thinkingLevel);

          if (maxTokens !== undefined && effectiveContextWindow !== undefined && effectiveContextWindow > 0) {
            const promptTokens = (truncatedRes.keptTokens ?? 0) + estimateTokens(subagentSystemPrompt);
            const remainingBudget = effectiveContextWindow - promptTokens;
            if (remainingBudget > 0) {
              maxTokens = Math.min(maxTokens, remainingBudget);
            }
          }

          if (session.provider === "anthropic") {
            for await (const chunk of streamAnthropic(
              byok.baseUrl,
              byok.apiKey,
              byok.model,
              subagentSystemPrompt,
              toAnthropicHistory(truncatedMsgs),
              availableTools,
              maxTokens,
              tl,
            )) {
              if (chunk.type === "tool_calls") toolCalls = chunk.calls ?? [];
              else if (chunk.type === "content") {
                iterContent += chunk.text ?? "";
                schedulePartial();
              } else if (chunk.type === "thinking") {
                iterThinking += chunk.text ?? "";
                schedulePartial();
              } else if (chunk.type === "finish") {
                lastFinishReason = chunk.reason ?? lastFinishReason;
              }
            }
          } else {
            for await (const chunk of streamOpenAICompatible(
              byok.baseUrl,
              byok.apiKey,
              byok.model,
              toOpenAIMessages(
                truncatedMsgs,
                subagentSystemPrompt,
                echoReasoning,
              ),
              availableTools,
              maxTokens,
              session.provider,
              tl,
            )) {
              if (chunk.type === "tool_calls") toolCalls = chunk.calls ?? [];
              else if (chunk.type === "content") {
                iterContent += chunk.text ?? "";
                schedulePartial();
              } else if (chunk.type === "thinking") {
                iterThinking += chunk.text ?? "";
                schedulePartial();
              } else if (chunk.type === "finish") {
                lastFinishReason = chunk.reason ?? lastFinishReason;
              }
            }
          }
          // Clear partial timer and flush buffered update immediately.
          clearPartialTimer();
          flushPartial();
          // Clean content: strip redundant tool-call blocks and <think> tags.
          const cleanedContent = cleanContent(iterContent);

          // Text-fallback: parse text tool calls if no native tool calls were returned.
          if (toolCalls.length === 0 && cleanedContent.length < iterContent.length) {
            // The model likely wrote tool calls as text — try to parse them.
            const textParsed = parseTextToolCalls(iterContent);
            if (textParsed.length > 0) {
              toolCalls = textParsed;
              iterContent = cleanedContent;
            }
          } else {
            // Strip tool blocks from content to avoid leaking raw fence syntax into stored messages.
            iterContent = cleanedContent;
          }
          // Remember reasoning echo requirement for gateway if retry succeeded.
          if (echoUpgraded && byok) {
            rememberReasoningEchoRequired(byok.baseUrl);
          }

          // Retry truncated output with registry maxOutput if stream ended due to length without tools.
          if (
            lastFinishReason === "length" &&
            toolCalls.length === 0 &&
            !budgetRetried
          ) {
            const reg = await peekModelInRegistry(byok.model, session.provider, { core: true });
            if (
              reg?.maxOutput !== undefined &&
              (maxTokens === undefined || maxTokens < reg.maxOutput)
            ) {
              budgetRetried = true;
              budgetMaxTokens = reg.maxOutput;
              continue; // re-run this attempt with the higher budget
            }
          }

          break; // success, exit retry loop
        } catch (err) {
          const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
          const is429 = (err instanceof Error && "status" in err && (err as any).status === 429) ||
                        /429|rate limit|too many requests/i.test(msg);

          // Retry with reasoning echo enabled if gateway returns 4xx when past thinking exists.
          const errStatus = getErrorStatusCode(err) ?? 0;

          if (
            !echoReasoning &&
            byok &&
            errStatus >= 400 &&
            errStatus < 500 &&
            errStatus !== 408 &&
            errStatus !== 429 &&
            currentMessages.some((m) => !!(m.thinking && m.thinking.trim()))
          ) {
            echoReasoning = true;
            echoUpgraded = true;
            attempts = -1; // do not consume the attempt budget
            continue;
          }

          const isTransient = isTransientStreamError(err);
          if (isTransient) {
            if (attempts < 2) {
              const headerVal = (err as any)?.retryAfter || (err as any)?.headers?.get?.("retry-after") || (err as any)?.headers?.get?.("x-ratelimit-reset");
              const headerMs = (err as any)?.retryAfterMs || parseRetryHeader(headerVal);
              let delayMs = 1000 * Math.pow(2, attempts) + Math.random() * 500;
              if (headerMs !== null && headerMs > 0) {
                delayMs = Math.min(headerMs, 10000);
              }

              const delaySec = Math.max(1, Math.ceil(delayMs / 1000));
              for (let sec = delaySec; sec > 0; sec--) {
                const liveSession = internalGet(sessionId);
                if (!liveSession) {
                  return; // Session deleted/cancelled
                }
                await sleep(1000);
              }
              continue;
            }
            finishSubagent(sessionId, {
              status: "failed",
              error: msg,
              completedAt: Date.now(),
            });
            return;
          }
          finishSubagent(sessionId, {
            status: "failed",
            error: msg,
            completedAt: Date.now(),
          });
          return;
        }
      }

      appendMessage(sessionId, {
        role: "assistant",
        content: iterContent || "",
        thinking: iterThinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      // Turn committed — drop live partial draft in favor of the durable message.
      clearSubagentPartial(sessionId);

      if (toolCalls.length === 0) {
        stoppedAfterAnswer = true;
        updateSession(sessionId, { status: "completing" });
        appendProgress(sessionId, "Final answer — building report");
        break;
      }

      updateSession(sessionId, { status: "tool_exec" });
      appendProgress(sessionId, `Executing ${toolCalls.length} tool(s)`);

      const toolCtx: ToolCtx = {
        userId: session.userId,
        conversationId: sessionId,
        parentConversationId: session.parentConversationId,
        provider: session.provider,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        checkpointId: session.checkpointId,
        signal: sessionAbort.signal,
        rootDir: subagentRootDir,
      };

      // Screen tools up front and execute sequentially in model-emitted order.
      interface PendingToolCall {
        tc: { id: string; name: string; arguments: string };
        content: string;
        rejected: boolean;
      }
      const ordered: PendingToolCall[] = [];
      // Load permission config once per batch of tool calls.
      const subagentPermConfig = await getPermissions(session.userId);
      for (const tc of toolCalls) {
        if (!availableTools.some((t) => t.function.name === tc.name)) {
          ordered.push({ tc, content: `Error: tool "${tc.name}" is not allowed for this subagent.`, rejected: true });
          continue;
        }

        // Evaluate permissions for the subagent tool call
        let permissionMode: PermissionMode = "allow";
        try {
          permissionMode = await evaluateToolPermission(session.userId, tc.name, "agent", subagentPermConfig);
        } catch (e) {
          permissionMode = "ask"; // fail-closed on errors
        }

        // Auto-elevate explicitly delegated tools to allow autonomous execution.
        const isExplicitlyAllowedSubagentTool =
          Array.isArray(session.allowedTools) &&
          (session.allowedTools.includes(tc.name) ||
            (tc.name === "command_stop" && session.allowedTools.includes("run_command")));
        if (
          permissionMode === "ask" &&
          (isReadOnlyTool(tc.name) || tc.name === "command_stop") &&
          (isExplicitlyAllowedSubagentTool || session.allowedTools.length === 0)
        ) {
          permissionMode = "allow";
        }

        if (permissionMode === "deny") {
          ordered.push({ tc, content: `Error: Permission denied for tool "${tc.name}".`, rejected: true });
          continue;
        }

        if (permissionMode === "ask") {
          ordered.push({
            tc,
            rejected: true,
            content: `Error: Permission requires user approval ("ask" mode is denied for background subagents). Please grant "allow" permission for this action in settings to let subagents run it autonomously.`,
          });
          continue;
        }

        ordered.push({ tc, content: "", rejected: false });
      }
      const executed = ordered.filter((x) => !x.rejected);
      if (executed.length > 0) {
        const runOne = async (tc: { id: string; name: string; arguments: string }) => {
          appendProgress(sessionId, `Tool: ${tc.name}`);
          let content: string;
          try {
            const parsedArgs = parseArgs(tc.arguments);
            const result = await runTool(tc.name, parsedArgs, toolCtx);

            // Duplicate Read Interceptor: detect and annotate repeated reads of identical ranges.
            if (tc.name === "read_file" && result.ok && typeof result.result === "object" && result.result !== null) {
              const resObj = result.result as Record<string, unknown>;
              const pathKey = String(resObj.path ?? parsedArgs?.path ?? parsedArgs?.TargetFile ?? "");
              if (pathKey) {
                const isRangeRead = typeof resObj.startLine === "number" && typeof resObj.endLine === "number";
                const rangeKey = isRangeRead ? `${resObj.startLine}-${resObj.endLine}` : "full";
                const readKey = `${pathKey}:${rangeKey}`;
                const prevReads = subagentReadTracker.get(sessionId) ?? new Set<string>();
                if (prevReads.has(readKey) && typeof resObj.content === "string") {
                  resObj.note = `[System Note: You have already inspected this line range of ${pathKey}. Do not re-read identical ranges. Formulate your report or action now.]`;
                }
                prevReads.add(readKey);
                subagentReadTracker.set(sessionId, prevReads);
              }
            }

            if (isWriteTool(tc.name)) {
              subagentReadTracker.delete(sessionId);
            }

            content = formatResult(result.result);
          } catch (toolErr) {
            content = `Tool error: ${toolErr instanceof Error ? toolErr.message : "unknown"}`;
          }
          const record = executed.find((x) => x.tc.id === tc.id);
          if (record) record.content = content;
        };

        // Strictly sequential tool execution in model-emitted order.
        for (const x of executed) {
          await runOne(x.tc);
        }
      }
      // Append all tool results (rejected and executed) in exact model-emitted order.
      for (const x of ordered) {
        appendMessage(sessionId, { role: "tool", content: x.content, toolCallId: x.tc.id });
      }
    }

    // Abort finish if session was deleted or cancelled during preceding awaits.
    const preFinish = internalGet(sessionId);
    if (stoppedAfterAnswer && (!preFinish || sessionAbort.signal.aborted)) {
      return;
    }

    // If we exited due to max iterations, still build a report
    const refreshed = internalGet(sessionId);
    if (!refreshed) {
      // Session deleted — mark failed so the parent does not hang.
      finishSubagent(sessionId, {
        status: "failed",
        error: "Session lost during report generation",
        completedAt: Date.now(),
      });
      return;
    }
    const toolResultsCount = refreshed.messages.filter(
      (m) => m.role === "tool" && !isFailedToolResult(m.content ?? ""),
    ).length;
    // Gathered results are delivered even when exiting via iteration budget exhaustion.
    const budgetCut = !stoppedAfterAnswer;
    const { hasFinalAnswer, report } = buildReport(refreshed);
    let finalReport = report;
    if (budgetCut && hasFinalAnswer) {
      finalReport = {
        ...report,
        conclusion: `${report.conclusion}\n\n_Note: this subagent hit its iteration budget; the answer above was captured mid-run._`,
      };
    }
    finishSubagent(sessionId, {
      status: "completed",
      ...(hasFinalAnswer ? {} : {
        error: `Subagent did not produce a final answer (${toolResultsCount} tool result(s) executed). Message it with "continue" to resume.`,
      }),
      report: finalReport,
      completedAt: Date.now(),
    });
    appendProgress(
      sessionId,
      hasFinalAnswer
        ? budgetCut
          ? "Subagent completed (iteration budget reached — partial results delivered)"
          : "Subagent completed"
        : "Subagent completed without a final answer",
    );
  } catch (e) {
    clearSubagentPartial(sessionId);
    finishSubagent(sessionId, {
      status: "failed",
      error: e instanceof Error ? e.message : "Subagent execution failed",
      completedAt: Date.now(),
    });
  } finally {
    // Clean up partial streaming state, abort listeners, and running commands on exit.
    clearSubagentPartial(sessionId);
    unregisterSessionAbort(sessionId, sessionAbort);
    subagentReadTracker.delete(sessionId);
    try {
      stopRunningCommand(session.userId, sessionId);
    } catch {
      /* ignore cleanup error */
    }
  }
}

/** Resume a terminal subagent with history or queue a message to a live session. */
export function reviveSubagent(
  userId: string,
  subagentId: string,
  message: string,
): { ok: boolean; status: "queued" | "resumed"; note: string; error?: string } {
  const session = getSession(userId, subagentId);
  if (!session) {
    return { ok: false, status: "queued", note: "", error: "Subagent not found (or does not belong to you)." };
  }
  if (session.status !== "completed" && session.status !== "failed") {
    // Live session — may not read it, that is accepted and documented in the note.
    enqueueSubagentMessage(subagentId, message);
    return { ok: true, status: "queued", note: "Message queued — the subagent will see it on its next iteration." };
  }
  const revives = session.revives ?? 0;
  if (revives >= 3) {
    return { ok: false, status: "queued", note: "", error: "Subagent already exhausted its resume attempts (3). Spawn a fresh subagent to continue." };
  }
  unmarkSubagentReportDelivered(userId, session.parentConversationId, subagentId);
  updateSession(subagentId, {
    status: "pending",
    report: undefined,
    error: undefined,
    completedAt: undefined,
    partial: undefined,
    revives: revives + 1,
  });
  appendMessage(subagentId, { role: "user", content: `[Continue instruction from main agent]\n\n${message}` });
  appendProgress(subagentId, "Resumed by main agent");
  // Fire-and-forget with the same crash boundary as spawnSubagent.
  runSubagentWorker(subagentId, { resume: true }).catch((err) => {
    console.error(`[subagent:${subagentId}] resumed worker crashed:`, err);
    updateSession(subagentId, {
      status: "failed",
      error: err instanceof Error ? err.message : "Worker crashed unexpectedly",
      completedAt: Date.now(),
    });
    void enqueueSubagentReport(userId, session.parentConversationId, subagentId);
  });
  return { ok: true, status: "resumed", note: "Subagent resumed — its next report will be delivered to you." };
}

async function resolveProvider(
  userId: string,
  provider: string,
  requestedModel?: string,
): Promise<{ baseUrl: string; apiKey: string; model: string } | null> {
  // BYOK path — looks up the stored auth token (Puter or any other provider)
  try {
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId, provider: provider as ProviderId } },
    });
    if (row?.isActive) {
      const apiKey = decrypt(row.encryptedKey);
      const info = PROVIDERS[provider as ProviderId];
      const baseUrl = row.baseUrl || info?.baseUrl || "";
      const userModels: Array<{ id: string }> = (() => {
        try {
          const parsed = JSON.parse(row.models ?? "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })();
      
      let model = requestedModel || "auto";
      if (model === "auto") {
        const concreteModel = 
          info?.models?.find((m) => m.id && m.id !== "auto")?.id ||
          userModels.find((m) => m.id && m.id !== "auto")?.id ||
          info?.models?.[0]?.id ||
          userModels[0]?.id ||
          "auto";
        model = concreteModel;
      }
      return { baseUrl: cleanBase(baseUrl), apiKey, model };
    }
  } catch {
    return null;
  }
  return null;
}

function pickConcreteModel(list: Array<{ id: string }>): string {
  // Free gateways reject the literal "auto" sentinel — pick any non-auto entry.
  const concrete = list.find((m) => m.id && m.id !== "auto");
  if (concrete) return concrete.id;
  return list[0]?.id ?? "auto";
}

function cleanBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function pickTools(allowed: string[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  // Subagents cannot recursively spawn subagents, interact with parent orchestration, or prompt the user interactively
  const subagentForbidden = new Set(["spawn_subagent", "get_subagent", "message_subagent", "ask_question"]);
  const available = PUBLIC_BUILTIN_TOOLS.filter((t) => !subagentForbidden.has(t.name));

  if (allowed.length === 0) {
    return available.filter((t) => isReadOnlyTool(t.name)).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  // Expand allowed tools: if run_command is permitted, automatically grant command_stop
  const effectiveAllowed = new Set(allowed);
  if (effectiveAllowed.has("run_command")) {
    effectiveAllowed.add("command_stop");
  }

  return available.filter((t) => effectiveAllowed.has(t.name)).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toOpenAIMessages(msgs: SubagentSessionMessage[], systemPromptOverride?: string, reasoningEcho = false): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  // Track emitted tool_use IDs to ensure tool results always follow valid assistant calls.
  const emittedToolCallIds = new Set<string>();
  const historyLen = msgs.length;
  for (let idx = 0; idx < historyLen; idx++) {
    const m = msgs[idx];
    if (m.role === "system") {
      out.push({ role: "system", content: systemPromptOverride ?? m.content });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // Preserve thinking content for recent turns, matching main executor behavior
      const isRecentTurn = idx >= historyLen - 4;
      const hasThinking = !!(m.thinking && m.thinking.trim());
      // DeepSeek APIs require reasoning_content echoed back in its dedicated field.
      const assistantContent = reasoningEcho
        ? (m.content || null)
        : (hasThinking && isRecentTurn)
          ? ` thinking${m.thinking} response${m.content || ""}`
          : m.content || null;
      const msg: OpenAIMessage = { role: "assistant", content: assistantContent };
      if (reasoningEcho && hasThinking) msg.reasoning_content = m.thinking;
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => {
          if (tc.id) emittedToolCallIds.add(tc.id);
          return {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            },
          };
        });
      }
      // Skip empty assistant messages without content or valid tool calls.
      if (!assistantContent || !assistantContent.trim()) {
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          if (!(reasoningEcho && hasThinking)) continue;
        }
      }
      out.push(msg);
    } else if (m.role === "tool") {
      // Skip orphan / out-of-order tool results (no matching emitted tool_use).
      if (!m.toolCallId || !emittedToolCallIds.has(m.toolCallId)) {
        continue;
      }
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      });
    }
  }

  // Ensure history does not end with a tool-less assistant message (required by Gemini).
  while (
    out.length > 0 &&
    out[out.length - 1].role === "assistant" &&
    (!out[out.length - 1].tool_calls || out[out.length - 1].tool_calls!.length === 0)
  ) {
    out.pop();
  }

  return out;
}

function toAnthropicHistory(
  msgs: SubagentSessionMessage[],
): Array<{
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}> {
  return msgs
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as string,
      content: m.content ?? "",
      toolCallId: m.toolCallId,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args:
          typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
      })),
    }));
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function formatResult(r: unknown): string {
  if (typeof r === "string") return r;
  if (r == null) return "(empty result)";
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

/** Check if a stored tool output represents an error or denied execution. */
function isFailedToolResult(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith("Error:") || trimmed.startsWith("Tool error:")) return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      return true;
    }
  } catch {
    // Not JSON — a normal readable result string.
  }
  return false;
}

/** Summarize stored tool result into a compact readable evidence excerpt for parent reports. */
function summarizeToolEvidence(content: string, maxLen = 240): string {
  let text = content;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.content === "string") {
        // read_file — surface the file content snippet.
        text = obj.content;
      } else if (Array.isArray(obj.entries)) {
        // list_directory — count files/dirs and list entry names.
        const entries = obj.entries as Array<{ name?: string; type?: string; path?: string }>;
        const files = typeof obj.files === "number" ? obj.files : entries.filter((e) => e.type !== "dir").length;
        const dirs = typeof obj.dirs === "number" ? obj.dirs : entries.filter((e) => e.type === "dir").length;
        const names = entries
          .slice(0, 12)
          .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
          .join(", ");
        text = `${files} file(s), ${dirs} dir(s) — ${names}${entries.length > 12 ? ` (+${entries.length - 12} more)` : ""}`;
      } else if (Array.isArray(obj.matches)) {
        // glob — list matched paths.
        text = (obj.matches as unknown[]).slice(0, 12).join(", ") + (obj.matches.length > 12 ? ` (+${obj.matches.length - 12} more)` : "");
      } else if (typeof obj.error === "string") {
        text = `Error: ${obj.error}`;
      }
    }
  } catch {
    // Not JSON — keep the raw string as-is.
  }
  const collapsed = text
    .replace(/\\r?\\n/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "(no tool output)";
  if (collapsed.length <= maxLen) return collapsed;
  const cut = collapsed.slice(0, maxLen).trimEnd();
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > 120 ? cut.slice(0, boundary) : cut}…`;
}

/** Build structured report from session messages, capturing summary, findings, and conclusion. */
function buildReport(session: SubagentSession): { hasFinalAnswer: boolean; report: SubagentReport } {
  // Extract final assistant message text for report summary and conclusion.
  let finalText = "";
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role !== "assistant") continue;
    const cleaned = cleanContent((m.content ?? "").trim());
    if (cleaned) {
      finalText = cleaned;
      break;
    }
  }

  if (!finalText) {
    // No clean final answer — report that honestly instead of fabricating
    // structure from tool dumps or the reasoning channel.
    return { hasFinalAnswer: false, report: { summary: "", findings: [], conclusion: "" } };
  }

  // Extract findings only from successfully executed tool results.
  const toolResults = new Map<string, string>();
  for (const m of session.messages) {
    if (m.role !== "tool") continue;
    if (!m.toolCallId) continue;
    if (isFailedToolResult(m.content ?? "")) continue;
    toolResults.set(m.toolCallId, m.content ?? "");
  }
  const toolCalls = session.messages
    .filter((m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0)
    .slice(-6)
    .flatMap((m) => m.toolCalls ?? [])
    .filter((tc) => toolResults.has(tc.id))
    .slice(0, 12);

  const findings = toolCalls.map((tc) => {
    const args = parseArgs(tc.arguments);
    const fileFromArgs =
      typeof args.path === "string"
        ? args.path
        : typeof args.file === "string"
          ? args.file
          : typeof args.url === "string"
            ? args.url
            : typeof args.uri === "string"
              ? args.uri
              : typeof args.query === "string"
                ? args.query
                : typeof args.pattern === "string"
                  ? args.pattern
                  : undefined;
    return {
      file: fileFromArgs && tc.name !== "web_search" && tc.name !== "http_fetch"
        ? fileFromArgs
        : undefined,
      action: tc.name,
      evidence: summarizeToolEvidence(toolResults.get(tc.id) ?? ""),
    };
  });

  const firstLine = finalText.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return {
    hasFinalAnswer: !!finalText,
    report: {
      summary: firstLine.slice(0, 800),
      findings,
      conclusion:
        finalText.length > SUBAGENT_REPORT_MAX_CHARS
          ? `${finalText.slice(0, SUBAGENT_REPORT_MAX_CHARS)}… (report truncated for context)`
          : finalText,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with no artificial timeout — the response can take as long as needed.
 * SSRF-gated: the URL (which derives from the user-editable provider baseUrl)
 * is validated against the shared policy before sending, and the final URL is
 * re-validated after any redirects were followed.
 */
function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return (async () => {
    await assertUrlAllowed(url);
    const resp = await fetch(url, {
      ...init,
      signal: init.signal ?? undefined,
    });
    if (resp.redirected) {
      await assertUrlAllowed(resp.url);
    }
    return resp;
  })();
}

async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>,
  maxTokens?: number,
  providerId?: string,
  thinkingLevel?: string,
): AsyncGenerator<StreamChunk> {
  const url = `${baseUrl}/chat/completions`;
  const resolvedMaxTokens = maxTokens ?? undefined;
  const plan = resolveReasoningPlan({
    providerId: providerId ?? "",
    userLevel: thinkingLevel,
    maxTokens,
    modelRejectsReasoning: modelRejectsReasoning(baseUrl, model),
  });
  const body: Record<string, unknown> = { model, messages, stream: true };
  configureRequestBody({
    providerId,
    model,
    body,
    reasoningParams: plan?.kind === "params" ? plan.params : undefined,
    maxTokens: resolvedMaxTokens,
    tools,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (apiKey && apiKey !== "not-needed") headers.Authorization = `Bearer ${apiKey}`;

  let resp = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify(body),
  });

  if ((resp.status === 400 || resp.status === 405 || resp.status === 422) && (body.reasoning_effort || body.reasoning || body.thinkingConfig)) {
    sanitizeRejectedReasoningParams(body);
    resp = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!resp.ok && (resp.status === 400 || resp.status === 405 || resp.status === 422) && body.tools) {
    delete body.tools;
    delete body.tool_choice;
    resp = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  // OpenRouter / Groq limit recovery: parse error limits, cap max_tokens, and retry once.
  if (!resp.ok || !resp.body) {
    let text = await resp.text().catch(() => "");
    const isOpenRouter = url.includes("openrouter.ai") || providerId === "openrouter";
    const isGroq = plan?.scheme === "groq_effort" || providerId === "groq" || url.includes("api.groq.com");
    let capped: number | null = null;
    const currentMax = typeof body.max_tokens === "number" ? body.max_tokens : 4096;

    if (isOpenRouter || isGroq) {
      if (isOpenRouter && (resp.status === 402 || resp.status === 400)) {
        const limitMatch = text.match(/can only afford (\d+)/i);
        const promptLimitMatch = text.match(/Prompt tokens limit exceeded:\s*(\d+)\s*>\s*(\d+)/i);
        const contextLimitMatch = text.match(/maximum context length is (\d+).*?requested about (\d+).*?(\d+)\s+of\s+text\s+input(?:,\s*(\d+)\s+of\s+tool\s+input)?,\s*(\d+)\s+in\s+the\s+output/i);
        if (limitMatch) {
          capped = Math.min(currentMax, parseInt(limitMatch[1], 10));
        } else if (promptLimitMatch) {
          const allowedOutput = Math.max(1, parseInt(promptLimitMatch[2], 10) - parseInt(promptLimitMatch[1], 10));
          capped = Math.min(currentMax, allowedOutput);
        } else if (contextLimitMatch) {
          const textInput = parseInt(contextLimitMatch[3], 10);
          const toolInput = contextLimitMatch[4] ? parseInt(contextLimitMatch[4], 10) : 0;
          const allowedOutput = Math.max(1, parseInt(contextLimitMatch[1], 10) - textInput - toolInput);
          capped = Math.min(currentMax, allowedOutput);
        }
      } else if (isGroq && (resp.status === 400 || resp.status === 413)) {
        const tpm = recoverGroqTpmRateLimit(body as Record<string, unknown>, text, resp.status, "[subagent]");
        if (tpm.isTpmError) {
          capped = tpm.capped;
        }
        const groqLimitMatch = text.match(/maximum context length is (\d+) tokens.*?requested (\d+) tokens \((\d+) in the messages, (\d+) in the completion_length\)/i);
        if (groqLimitMatch) {
          const allowedOutput = Math.max(1, parseInt(groqLimitMatch[1], 10) - parseInt(groqLimitMatch[3], 10));
          capped = Math.min(currentMax, allowedOutput);
        }
      }
    }

    const standardContextMatch = text.match(/maximum context length is (\d+).*?requested (\d+) output tokens.*?prompt contains (?:at least )?(\d+)\s+(?:input tokens|characters)/i);
    if (standardContextMatch && (resp.status === 400 || resp.status === 422)) {
      const limit = parseInt(standardContextMatch[1], 10);
      const promptTokens = parseInt(standardContextMatch[3], 10);
      const allowedOutput = Math.max(1, limit - promptTokens);
      capped = Math.min(currentMax, allowedOutput);
      console.warn(
        `[subagent] Provider 400: prompt + output exceeds context window (${limit}), capping max_tokens to ${capped}`,
      );
      body.max_tokens = capped;
      resp = await fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) text = await resp.text().catch(() => "");
    } else if (capped !== null && capped > 0) {
      console.warn(
        `[subagent] ${isOpenRouter ? "OpenRouter" : "Groq"} ${resp.status}: capping max_tokens to ${capped}`,
      );
      body.max_tokens = capped;
      resp = await fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) text = await resp.text().catch(() => "");
    }
    if (!resp.ok || !resp.body) {
      const err = new Error(`Provider returned ${resp.status}: ${stripHtml(text.slice(0, 500)) || resp.statusText}`);
      (err as Error & { status?: number }).status = resp.status;
      (err as Error & { responseBody?: string }).responseBody = text.slice(0, 1000);
      const retryHeader =
        resp.headers.get("retry-after") ||
        resp.headers.get("x-ratelimit-reset") ||
        resp.headers.get("ratelimit-reset") ||
        resp.headers.get("x-ratelimit-reset-requests") ||
        resp.headers.get("x-ratelimit-reset-tokens");
      const retryAfterMs = parseRetryHeader(retryHeader);
      if (retryAfterMs !== null) {
        (err as any).retryAfterMs = retryAfterMs;
        (err as any).retryAfter = retryHeader;
      }
      throw err;
    }
  }

  return yield* streamOpenAICompatibleFromResponse(resp);
}

async function* streamOpenAICompatibleFromResponse(
  resp: Response,
): AsyncGenerator<StreamChunk> {
  // Parse non-streaming JSON responses if returned despite stream: true.
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("text/event-stream")) {
    const fullBody = await resp.text();
    const parsed = parseNonStreamingResponse(fullBody);
    if (parsed) {
      if (parsed.thinking) yield { type: "thinking", text: parsed.thinking };
      if (parsed.content) yield { type: "content", text: parsed.content };
      if (parsed.toolCalls?.length) yield { type: "tool_calls", calls: parsed.toolCalls };
    }
    return;
  }

  if (!resp.body) throw new Error("Response body is null");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const acc = new Map<number, { id: string; name: string; args: string }>();
  let sawToolCalls = false;
  // Upstream finish_reason from the final SSE frame — surfaced so callers can
  // detect budget exhaustion (`length`) vs. a normal stop.
  let finishReason: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        if (finishReason) yield { type: "finish", reason: finishReason };
        if (sawToolCalls && acc.size > 0) yield { type: "tool_calls", calls: flushAcc(acc) };
        return;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // malformed line — skip
      }
      if (json?.error) {
        // Surface upstream SSE error frames if returned with HTTP 200.
        const err = new Error(`Provider error: ${extractUpstreamError(json.error)}`) as Error & {
          status?: number;
          statuslessUpstream?: boolean;
        };
        if (typeof json.error?.status === "number") err.status = json.error.status;
        if (err.status === undefined) err.statuslessUpstream = true;
        throw err;
      }
      const finishReasonFrame = json?.choices?.[0]?.finish_reason;
      if (typeof finishReasonFrame === "string") finishReason = finishReasonFrame;
      const delta = json?.choices?.[0]?.delta;
      if (!delta) continue;
      try {
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          sawToolCalls = true;
          for (const tc of delta.tool_calls) {
            const existing = acc.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
            acc.set(tc.index, existing);
          }
          continue;
        }
        const { reasoningDelta, contentDelta } = parseSseReasoningChunk(delta);
        if (reasoningDelta) yield { type: "thinking", text: reasoningDelta };
        if (contentDelta) yield { type: "content", text: contentDelta };
      } catch {
        /* ignore */
      }
    }
  }
  if (sawToolCalls && acc.size > 0) yield { type: "tool_calls", calls: flushAcc(acc) };
}

function flushAcc(acc: Map<number, { id: string; name: string; args: string }>): Array<{
  id: string;
  name: string;
  arguments: string;
}> {
  return Array.from(acc.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }));
}

async function* streamAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: Array<{
    role: string;
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; args: string }>;
  }>,
  tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>,
  maxTokens?: number,
  thinkingLevel?: string,
): AsyncGenerator<StreamChunk> {
  // Track emitted tool_use IDs to ensure tool results follow valid tool_use blocks.
  const emittedToolUseIds = new Set<string>();
  const messagesOut: Array<Record<string, unknown>> = [];
  for (const m of history) {
    if (m.role === "tool") {
      if (!m.toolCallId || !emittedToolUseIds.has(m.toolCallId)) {
        continue; // Skip orphan / out-of-order tool results
      }
      messagesOut.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
        ],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        if (tc.id) emittedToolUseIds.add(tc.id);
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.args) });
      }
      messagesOut.push({ role: "assistant", content: blocks });
    } else if (m.role !== "system") {
      messagesOut.push({ role: m.role, content: m.content });
    }
  }
  const url = `${baseUrl}/messages`;
  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    messages: messagesOut,
    stream: true,
    max_tokens: maxTokens ?? ANTHROPIC_SDK_DEFAULT_MAX_TOKENS,
  };
  const plan: ReasoningPlan = resolveReasoningPlan({
    providerId: "anthropic",
    userLevel: thinkingLevel,
    maxTokens,
    anthropicMode: "adaptive",
    modelRejectsReasoning: modelRejectsReasoning(baseUrl, model),
  });
  if (plan.kind === "params") Object.assign(body, plan.params);
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Anthropic returned ${resp.status}: ${stripHtml(text.slice(0, 500)) || resp.statusText}`);
    (err as Error & { status?: number }).status = resp.status;
    (err as Error & { responseBody?: string }).responseBody = text.slice(0, 1000);
    const retryHeader =
      resp.headers.get("retry-after") ||
      resp.headers.get("x-ratelimit-reset") ||
      resp.headers.get("ratelimit-reset") ||
      resp.headers.get("x-ratelimit-reset-requests") ||
      resp.headers.get("x-ratelimit-reset-tokens");
    const retryAfterMs = parseRetryHeader(retryHeader);
    if (retryAfterMs !== null) {
      (err as any).retryAfterMs = retryAfterMs;
      (err as any).retryAfter = retryHeader;
    }
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending = new Map<number, { id: string; name: string; json: string }>();
  const completed: Array<{ id: string; name: string; arguments: string }> = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      try {
        const json = JSON.parse(trimmed.slice(5).trim());
        if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
          pending.set(json.index, {
            id: json.content_block.id,
            name: json.content_block.name,
            json: "",
          });
        } else if (json.type === "content_block_delta") {
          if (json.delta?.type === "text_delta") {
            yield { type: "content", text: json.delta.text as string };
          } else if (json.delta?.type === "input_json_delta") {
            const pt = pending.get(json.index);
            if (pt) pt.json += json.delta.partial_json;
          } else if (json.delta?.type === "thinking_delta") {
            yield { type: "thinking", text: json.delta.thinking as string };
          }
        } else if (json.type === "content_block_stop") {
          const pt = pending.get(json.index);
          if (pt) {
            completed.push({ id: pt.id, name: pt.name, arguments: pt.json || "{}" });
            pending.delete(json.index);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (completed.length > 0) yield { type: "tool_calls", calls: completed };
}

import { subscribeSubagentUpdates } from "./subagent-session";

/** Block until each id reaches a terminal status (completed/failed/cancelled),
 *  or until `timeoutMs` elapses. Uses pub/sub so it wakes immediately
 *  when the subagent worker updates the session status. */
export async function awaitSubagents(
  userId: string,
  ids: string[],
  timeoutMs = 1_800_000, // 30 minutes default — subagents run autonomously with AbortSignal
  signal?: AbortSignal,
): Promise<
  Array<{
    id: string;
    name: string;
    status: "completed" | "failed";
    report: SubagentReport | null;
    error: string | null;
  }>
> {
  const deadline = Date.now() + timeoutMs;
  const out: Array<{
    id: string;
    name: string;
    status: "completed" | "failed";
    report: SubagentReport | null;
    error: string | null;
  }> = [];

  // Track which ids we're still waiting on
  const pending = new Map<string, SubagentSession>();
  for (const id of ids) {
    const session = getById(id);
    if (!session || session.userId !== userId) {
      out.push({ id, name: id, status: "failed", report: null, error: "Subagent not found" });
      continue;
    }
    if (session.status === "completed") {
      out.push({ id, name: session.name, status: "completed", report: session.report ?? null, error: null });
      continue;
    }
    if (session.status === "failed") {
      out.push({ id, name: session.name, status: "failed", report: null, error: session.error ?? "Unknown failure" });
      continue;
    }
    pending.set(id, session);
  }

  if (pending.size === 0) return out;

  // Create resolvable promises for remaining pending subagents
  const resolvers = new Map<string, (value: { status: "completed" | "failed"; report: SubagentReport | null; error: string | null }) => void>();
  const waiters = new Map<string, Promise<{ status: "completed" | "failed"; report: SubagentReport | null; error: string | null }>>();

  for (const id of pending.keys()) {
    waiters.set(id, new Promise((resolve) => {
      resolvers.set(id, resolve);
    }));
  }

  // Group pending ids by conversationId for efficient subscription
  const convIds = new Set<string>();
  for (const [, session] of pending) {
    convIds.add(session.parentConversationId);
  }

  // Subscribe to updates for each conversation
  const unsubscribes: (() => void)[] = [];
  for (const convId of convIds) {
    unsubscribes.push(subscribeSubagentUpdates(userId, convId, (updatedId: string) => {
      const resolver = resolvers.get(updatedId);
      if (!resolver) return; // not one we're waiting on

      const session = getById(updatedId);
      if (!session) {
        if (pending.has(updatedId)) {
          pending.delete(updatedId);
          resolver({ status: "failed", report: null, error: "Subagent evicted or session missing" });
        }
        return;
      }

      const pendingEntry = pending.get(updatedId);
      if (!pendingEntry) return; // already resolved or not tracked

      if (session.status === "completed") {
        pending.delete(updatedId);
        resolver({ status: "completed", report: session.report ?? null, error: null });
      } else if (session.status === "failed") {
        pending.delete(updatedId);
        resolver({ status: "failed", report: null, error: session.error ?? "Unknown failure" });
      }
    }));
  }

  // Also set a timeout/abort guard
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const remaining = Math.max(0, deadline - Date.now());
    timer = setTimeout(() => reject(new Error("awaitSubagents timeout")), remaining);
    signal?.addEventListener("abort", () => {
      if (timer) clearTimeout(timer);
      reject(new Error("awaitSubagents aborted"));
    }, { once: true });
  });

  try {
    // Wait for all pending to complete OR timeout/abort
    await Promise.race([
      Promise.all(Array.from(resolvers.keys()).map((id) => waiters.get(id)!)),
      timeoutPromise,
    ]);
  } catch {
    // Timeout or abort — check individual subagent statuses before marking pending subagents as failed
    for (const [id, session] of pending) {
      const latest = getById(id);
      if (latest?.status === "completed") {
        out.push({ id, name: latest.name ?? session.name, status: "completed", report: latest.report ?? null, error: null });
      } else if (latest?.status === "failed") {
        out.push({ id, name: latest.name ?? session.name, status: "failed", report: null, error: latest.error ?? "Unknown failure" });
      } else {
        out.push({ id, name: session.name, status: "failed", report: null, error: "Timeout or aborted" });
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    for (const unsub of unsubscribes) unsub();
  }

  // Collect results from resolved waiters
  for (const id of ids) {
    // Already added as failure?
    if (out.some(o => o.id === id)) continue;

    try {
      const result = await waiters.get(id)!;
      const session = getById(id);
      out.push({ id, name: session?.name ?? id, ...result });
    } catch {
      out.push({ id, name: getById(id)?.name ?? id, status: "failed", report: null, error: "Waiter rejected" });
    }
  }

  return out;
}

/** Internal: read session by id only (no user ACL). Workers use this. */
function getById(id: string): SubagentSession | null {
  return internalGet(id);
}

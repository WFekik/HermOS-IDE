import { db } from "@/lib/db";
import {
  onBackgroundCommandCompleted,
  acknowledgeCompletedCommand,
} from "@/lib/workspace";
import { internalGet } from "@/lib/ai/subagent-session";
import { isRunActive } from "@/lib/ai/subagent-queue";
import {
  grantAndPublishWake,
  isConversationDeliveryPaused,
} from "@/lib/ai/subagent-delivery";

let initialized = false;
let unsubscribe: (() => void) | null = null;

export function resetCommandDeliveryForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
}

export function initCommandDelivery(): void {
  if (initialized) return;
  initialized = true;

  unsubscribe = onBackgroundCommandCompleted(async (userId, conversationId, completed) => {
    // Subagent sessions key commands by sessionId and the subagent executor
    // drains those completions itself — a sessionId is not a conversation row.
    if (internalGet(conversationId)) return;
    // Transcript undo pauses delivery so nothing lands in a rewound
    // transcript; the entry stays pending for the next executor drain.
    if (isConversationDeliveryPaused(conversationId)) return;
    // If conversation's executor run is currently active,
    // the running loop will drain the completed command directly.
    if (isRunActive(userId, conversationId)) {
      return;
    }

    try {
      const cmdOk = completed.exitCode === 0 || completed.exitCode === null;
      const statusText = cmdOk
        ? "completed successfully"
        : `failed with exit code ${completed.exitCode ?? "?"}`;
      const stdoutSnippet = completed.stdout.trim() ? completed.stdout : "(no stdout)";
      const stderrSnippet = completed.stderr.trim() ? `\n\n--- STDERR ---\n${completed.stderr}` : "";
      const content = `[System: Background command finished]\nCommand: \`${completed.command}\` ${statusText} (exit code ${completed.exitCode ?? 0}):\n\n\`\`\`\n${stdoutSnippet}${stderrSnippet}\n\`\`\``;

      // Claim BEFORE the awaited DB writes — the executor drain gates its
      // posts on this ack, so claiming first closes the double-post TOCTOU.
      acknowledgeCompletedCommand(userId, conversationId, completed.execId);

      // 1. Post command result as user-role turn input in the conversation
      await db.message.create({
        data: {
          conversationId,
          role: "user",
          content,
        },
      });

      // 2. Update the previous assistant message's running tool call so its
      // card converges to terminal state without waiting for a reload.
      const lastAssistantMsg = await db.message.findFirst({
        where: { conversationId, role: "assistant" },
        orderBy: { createdAt: "desc" },
      });

      if (lastAssistantMsg?.toolCalls) {
        try {
          const tcs = JSON.parse(lastAssistantMsg.toolCalls) as Array<Record<string, unknown>>;
          // Stamp only the card this completion belongs to: the running
          // payload carries `commandId` = `${userId}:${conversationId}:${execId}`.
          let target: Record<string, unknown> | null = null;
          let fallback: Record<string, unknown> | null = null;
          for (const tc of tcs) {
            if (
              (tc.name === "run_command" || tc.name === "run_terminal") &&
              (tc.status === "running" ||
                (tc.result &&
                  typeof tc.result === "object" &&
                  (tc.result as Record<string, unknown>).status === "running"))
            ) {
              fallback ??= tc;
              const resultObj = tc.result as Record<string, unknown> | null;
              const cardExecId =
                resultObj && typeof resultObj.commandId === "string"
                  ? resultObj.commandId.split(":").slice(2).join(":")
                  : "";
              if (cardExecId && cardExecId === completed.execId) {
                target = tc;
                break;
              }
            }
          }
          const matched = target ?? fallback;
          if (matched) {
            matched.status = cmdOk ? "done" : "error";
            matched.result = {
              status: cmdOk ? "completed" : "failed",
              command: completed.command,
              stdout: completed.stdout,
              stderr: completed.stderr,
              exitCode: completed.exitCode ?? 0,
            };
            await db.message.update({
              where: { id: lastAssistantMsg.id },
              data: { toolCalls: JSON.stringify(tcs) },
            });
          }
        } catch {
          /* best-effort toolCalls update */
        }
      }

      // 3. Issue wake grant and trigger client autoWake
      grantAndPublishWake(userId, conversationId);
    } catch (err) {
      console.error("[command-delivery] Failed to deliver completed background command:", err);
    }
  });
}

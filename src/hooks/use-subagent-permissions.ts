"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAppStore } from "@/stores/app-store";
import { parseSubagentPermissionEvent } from "@/lib/permission-prompt-events";
import { t } from "@/lib/i18n";

/**
 * Surfaces subagent tool approvals for every conversation of the user.
 *
 * The per-conversation subagent stream only reaches the client that has that
 * conversation open, so an approval raised by a worker running in a background
 * conversation stayed invisible until the user switched to it — while the
 * worker parked until its approval window expired. This stream is user-scoped:
 * the request is always delivered, and a request for a conversation that is
 * not on screen raises a toast that jumps to it.
 */
export function useSubagentPermissionStream(): void {
  React.useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;

    const handle = (e: MessageEvent) => {
      if (closed) return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const event = parseSubagentPermissionEvent(raw);
      const conversationId = event?.conversationId;
      if (!event || !conversationId) return;

      const state = useAppStore.getState();
      const accepted = state.setPermissionPrompt(
        {
          id: event.permission.approvalId,
          conversationId,
          action: event.permission.action,
          target: event.permission.target,
          toolCallId: event.permission.toolCallId,
          toolName: event.permission.toolName,
          subagentId: event.sessionId,
          subagentName: event.name,
          createdAt: event.permission.createdAt,
          ttlMs: event.permission.ttlMs,
        },
        conversationId,
      );
      if (!accepted) return;
      if (conversationId === state.activeConversationId) return;

      const lang = state.language;
      const session =
        state.conversations.find((c) => c.id === conversationId) ||
        state.pendingConversations.find((p) => p.id === conversationId);
      const sessionTitle = session?.title
        ? `"${session.title}"`
        : t("background_session", lang);
      // The toast stays up for the server-authoritative review window (up to 30 min)
      // and dismisses automatically if the approval expires on the server.
      const ttl = event.permission.ttlMs ?? 1_800_000;
      const remainingTtl = Math.max(
        10_000,
        ttl - (Date.now() - event.permission.createdAt),
      );
      toast(t("permission_requested", lang), {
        id: `perm-${event.permission.approvalId}`,
        description: `${sessionTitle} · ${event.permission.action}`,
        duration: remainingTtl,
        action: {
          label: t("review", lang),
          onClick: () => {
            const live = useAppStore.getState();
            const exists =
              live.conversations.some((c) => c.id === conversationId) ||
              live.pendingConversations.some((p) => p.id === conversationId);
            if (!exists) {
              toast.error(t("conversation_gone", lang));
              return;
            }
            void live.selectConversation(conversationId);
          },
        },
      });
    };

    try {
      es = new EventSource("/api/agents/subagents/permissions/stream");
      es.addEventListener("permission", handle);
    } catch {
      /* SSE unavailable — the pending-approval recovery endpoint still covers it */
    }

    return () => {
      closed = true;
      es?.close();
    };
  }, []);
}

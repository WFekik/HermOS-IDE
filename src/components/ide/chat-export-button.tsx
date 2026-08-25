"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { ApiRequestError } from "@/lib/api-client";

interface ChatExportButtonProps {
  conversationId: string | null;
  title: string;
  className?: string;
}

/**
 * Window event dispatched by the global ⌘E keyboard shortcut (handled in
 * ide-shell.tsx). The ChatExportButton listens for it so the export logic
 * stays encapsulated in this component — no store coupling, no duplicate
 * fetch code. The detail can optionally carry a conversationId + title
 * override, but in practice we always export the active conversation.
 */
export interface ExportConversationEventDetail {
  conversationId?: string;
  title?: string;
}

/**
 * Sanitize a conversation title into a filesystem-safe slug.
 * Replaces whitespace with hyphens, strips anything outside
 * [a-z0-9-_], collapses runs of hyphens, trims edges. Falls back
 * to "conversation" when the result is empty.
 */
function slugifyTitle(title: string): string {
  const cleaned = (title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || "conversation";
}

/**
 * Export-button for the chat header. Fetches the conversation as
 * Markdown via GET /api/conversations/[id]/export (auth-cookies via
 * `credentials: include`), then triggers a download using a hidden
 * `<a>` element backed by an object URL.
 *
 * The endpoint returns `text/markdown` with
 * `Content-Disposition: attachment; filename="<slug>.md"` — we read
 * the filename from the header when present, otherwise derive it from
 * the conversation title.
 *
 * The same export logic also runs when a `hermos:export-conversation`
 * window event is dispatched (e.g. by the ⌘E global shortcut). This
 * keeps the fetch + download code in one place while letting the
 * keyboard shortcut live in the shell.
 */
export function ChatExportButton({
  conversationId,
  title,
  className,
}: ChatExportButtonProps) {
  const [busy, setBusy] = React.useState(false);
  const linkRef = React.useRef<HTMLAnchorElement | null>(null);

  // Keep the latest props in a ref so the window-event handler (which
  // is registered once) always sees the current conversationId/title
  // without needing to re-bind on every render.
  const propsRef = React.useRef({ conversationId, title, busy });
  React.useEffect(() => {
    propsRef.current = { conversationId, title, busy };
  }, [conversationId, title, busy]);

  const disabled = !conversationId || busy;

  const runExport = React.useCallback(async () => {
    const { conversationId: id, title: t, busy: b } = propsRef.current;
    if (!id || b) return;

    setBusy(true);
    let objectUrl: string | null = null;
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(id)}/export`,
        {
          method: "GET",
          credentials: "include",
          headers: { Accept: "text/markdown" },
        },
      );

      if (!res.ok) {
        let message = `Export failed (${res.status})`;
        try {
          const env = (await res.json()) as { error?: string };
          if (env?.error) message = env.error;
        } catch {
          // not JSON — keep the generic message
        }
        throw new ApiRequestError(message, undefined, res.status);
      }

      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("Empty response from server");
      }

      objectUrl = URL.createObjectURL(blob);

      // Try to read a filename from Content-Disposition; fall back to slug.
      let filename = `${slugifyTitle(t)}.md`;
      const cd = res.headers.get("content-disposition");
      if (cd) {
        const match = cd.match(/filename="?([^";]+)"?/i);
        if (match?.[1]) filename = match[1];
      }

      const link = linkRef.current ?? document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.rel = "noopener";
      if (!linkRef.current) {
        link.style.display = "none";
        document.body.appendChild(link);
      }
      link.click();

      toast.success("Conversation exported", { description: filename });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to export conversation";
      toast.error(message);
    } finally {
      // Revoke the object URL on the next tick so the download has time
      // to start in all browsers.
      if (objectUrl) {
        setTimeout(() => URL.revokeObjectURL(objectUrl as string), 1000);
      }
      setBusy(false);
    }
  }, []);

  // Listen for the global ⌘E shortcut dispatching an
  // `hermos:export-conversation` event. We re-use the same runExport
  // path so there's exactly one fetch/download implementation.
  React.useEffect(() => {
    const handler = (e: Event) => {
      // Allow callers to override the conversationId/title via the
      // event detail, but default to the current props.
      const detail = (e as CustomEvent<ExportConversationEventDetail>).detail;
      if (detail?.conversationId) {
        propsRef.current = {
          ...propsRef.current,
          conversationId: detail.conversationId,
          title: detail.title ?? propsRef.current.title,
        };
      }
      void runExport();
    };
    window.addEventListener("hermos:export-conversation", handler as EventListener);
    return () => {
      window.removeEventListener(
        "hermos:export-conversation",
        handler as EventListener,
      );
    };
  }, [runExport]);

  const onExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    void runExport();
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={className}
            onClick={onExport}
            disabled={disabled}
            aria-label="Export conversation as Markdown"
            type="button"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            <span className="hidden sm:inline">Export</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          {disabled && !conversationId
            ? "No active conversation"
            : "Export as Markdown (⌘E)"}
        </TooltipContent>
      </Tooltip>
      {/* Hidden anchor used to trigger the download. */}
      <a ref={linkRef} className="hidden" aria-hidden="true" />
    </>
  );
}

/**
 * Dispatch the global export-conversation event. Imported by the
 * keyboard shortcut handler in ide-shell.tsx so it doesn't need to know
 * about the ChatExportButton's internals.
 */
export function dispatchExportConversation(
  detail?: ExportConversationEventDetail,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ExportConversationEventDetail>("hermos:export-conversation", {
      detail: detail ?? {},
    }),
  );
}

"use client";

import * as React from "react";
import {
  Paperclip,
  Send,
  SendHorizonal,
  Square,
  Wrench,
  ChevronDown,
  Pencil,
  X,
  Brain,
  Shield,
  ShieldAlert,
  Check,
  Ban,
  ShieldCheck,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MentionAutocomplete,
  detectTrigger,
  type MentionTrigger,
} from "@/components/ide/mention-autocomplete";
import { ModelSelector } from "@/components/ide/model-selector";
import { ProjectSelector } from "@/components/ide/project-selector";
import { TodoCollapsedBanner } from "@/components/ide/todo-collapsed-banner";
import { QuestionPromptCard } from "@/components/ide/question-prompt";
import { useAppStore } from "@/stores/app-store";
import { useChatStream } from "@/hooks/use-chat-stream";
import {
  getReasoningLevels,
  normalizeThinkingLevel,
  type ModelReasoningCapabilities,
} from "@/lib/reasoning";
import { toast } from "sonner";
import type { AgentMode, AttachmentDTO } from "@/lib/types";
import { AGENT_MODES, AGENT_MODES_BY_VALUE } from "@/lib/agent-modes";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/tool-ui-shared";
import { isMacPlatform } from "@/lib/platform";
import { conversationWidthClass } from "@/lib/color-theme";

interface ComposerProps {
  onSend: (text: string, attachmentIds?: string[], attachmentMetas?: AttachmentDTO[]) => void;
  onQueue: (text: string, attachmentIds?: string[], attachmentMetas?: AttachmentDTO[]) => Promise<boolean> | void;
  onStop: () => void;
  disabled?: boolean;
}

const MAX_LINES = 8;
const LINE_HEIGHT = 22;
const MAX_ATTACHMENT_BYTES = 50 * 1000 * 1000;

/** MIME families we accept. Images show inline preview; everything else shows an icon chip. */
const ACCEPTED_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/tiff",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/plain", "text/markdown", "text/html", "text/css", "text/csv", "text/javascript", "text/typescript",
  "application/json", "application/xml", "application/x-yaml", "application/zip", "application/x-tar", "application/gzip",
  // Catch all text and image subtypes
  "image/*", "text/*",
];

interface AttachPreview {
  /** Client-side temp id. */
  id: string;
  file: File;
  /** Uploaded attachment id from the server (null while uploading). */
  uploadedId?: string;
  /** Upload error message. */
  error?: string;
  uploading?: boolean;
  /** Data URL for inline image preview. */
  previewUrl?: string;
}

export function Composer({ onSend, onQueue, onStop, disabled }: ComposerProps) {
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const isStreaming = useAppStore(
    (s) => s.streamingStateByConversation[s.activeConversationId ?? ""]?.isStreaming ?? false,
  );
  const composerMode = useAppStore((s) => s.composerMode);
  const setComposerMode = useAppStore((s) => s.setComposerMode);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const enabledTools = useAppStore((s) => s.enabledTools);
  const editingMessageId = useAppStore((s) => s.editingMessageId);
  const setEditingMessageId = useAppStore((s) => s.setEditingMessageId);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const ensureRealConversation = useAppStore((s) => s.ensureRealConversation);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const systemPrompt = useAppStore((s) => s.systemPrompt);
  const providerKeys = useAppStore((s) => s.providerKeys);
  const providers = useAppStore((s) => s.providers);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const updateMessageContent = useAppStore((s) => s.updateMessageContent);
  const removeMessagesAfter = useAppStore((s) => s.removeMessagesAfter);
  const permissionPrompt = useAppStore((s) =>
    activeConversationId ? s.permissionPromptsByConversation[activeConversationId] ?? null : s.permissionPrompt,
  );
  const resolvePermissionPrompt = useAppStore((s) => s.resolvePermissionPrompt);
  const questionPrompt = useAppStore((s) =>
    activeConversationId ? s.questionPromptsByConversation[activeConversationId] ?? null : s.questionPrompt,
  );
  const resolveQuestionPrompt = useAppStore((s) => s.resolveQuestionPrompt);

  // composerDraft in the store is the single source of truth — suggestion cards
  // and skill pickers write to it directly, and the textarea is bound to it.
  const text = useAppStore((s) => s.composerDraft);
  const setText = useAppStore((s) => s.setComposerDraft);
  const { stream, stop } = useChatStream();
  // Only subscribe to the message list while editing an existing message —
  // when not editing the selector is a constant `null` and the composer
  // subtree no longer re-renders on every streaming flush.
  const targetEditMsg = useAppStore((s) =>
    editingMessageId ? (s.messages.find((m) => m.id === editingMessageId) ?? null) : null,
  );
  const isEditMode = targetEditMsg !== null && targetEditMsg !== undefined;
  const hasMessages = useAppStore((s) => s.messages.length > 0);
  const conversationWidth = useAppStore((s) => s.conversationWidth);

  // Auto-clear stale editingMessageId if it no longer exists in current messages
  React.useEffect(() => {
    if (editingMessageId && !targetEditMsg) {
      setEditingMessageId(null);
    }
  }, [editingMessageId, targetEditMsg, setEditingMessageId]);
  const [isFocused, setIsFocused] = React.useState(false);
  const [modeOpen, setModeOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = React.useState<AttachPreview[]>([]);
  const uploadInFlight = React.useRef(false);

  // Typed text OR a pasted/attached file. While the agent is running a draft
  // enables the Queue button (the draft becomes the next iteration's user
  // turn); Stop stays available regardless.
  const hasDraft = text.trim().length > 0 || attachments.length > 0;

  const connectedMcpTools = React.useMemo(() => {
    const list: { server: string; tool: string; description?: string }[] = [];
    for (const s of mcpServers) {
      if (s.status !== "connected") continue;
      for (const t of s.tools ?? []) {
        list.push({ server: s.name, tool: t.name, description: t.description });
      }
    }
    return list;
  }, [mcpServers]);

  const enabledToolsCount = connectedMcpTools.length + enabledTools.length;

  const grow = React.useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, LINE_HEIGHT * MAX_LINES);
    el.style.height = `${next}px`;
  }, []);

  React.useEffect(() => {
    grow();
  }, [text, grow]);

  // When the draft changes externally (suggestion click, skill picker),
  // re-focus the textarea so the user can immediately press ⌘↵ to send.
  const lastExternalRef = React.useRef(text);
  React.useEffect(() => {
    if (text !== lastExternalRef.current) {
      lastExternalRef.current = text;
      // Only focus if user isn't already typing in another input.
      const active = document.activeElement;
      if (!active || active === document.body) {
        taRef.current?.focus();
      }
    }
  }, [text]);

  // Focus the textarea when entering edit mode.
  React.useEffect(() => {
    if (editingMessageId) {
      taRef.current?.focus();
      // Move cursor to end.
      const el = taRef.current;
      if (el) {
        const len = el.value.length;
        requestAnimationFrame(() => {
          el.setSelectionRange(len, len);
        });
      }
    }
  }, [editingMessageId]);

  const submit = async () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || disabled) return;

    // A1 — guard: default provider "puter" requires a key; new users otherwise
    // see a cryptic streaming error. Check before any upload/queue.
    const hasKeyForSelected = providerKeys.some((k) => k.provider === selectedProvider && k.hasKey);
    if (!hasKeyForSelected && providers.length > 0) {
      const providerInfo = providers.find((p) => p.id === selectedProvider);
      const needsKey = providerInfo ? providerInfo.requiresKey : false;
      if (needsKey) {
        toast.error("Add your API key in Settings → Providers", {
          description: `${providerInfo?.name ?? selectedProvider} requires an API key to send messages.`,
          action: {
            label: "Open Settings",
            onClick: () => {
              setSettingsTab("providers");
              setSettingsOpen(true);
            },
          },
          duration: 6000,
        });
        setSettingsTab("providers");
        setSettingsOpen(true);
        return;
      }
    }

    if (isEditMode && editingMessageId) {
      if (isStreaming) {
        // Edits interrupt the run and regenerate — they can't be queued.
        // Stop first, then save the edit. The Stop button stays visible
        // while streaming, so this is always resolvable.
        toast.info("Stop the current run before editing a message");
        return;
      }
      const msgId = editingMessageId;
      try {
        await commitMessageEdit(msgId, value, {
          activeConversationId,
          selectedProvider,
          selectedModel,
          composerMode,
          systemPrompt,
          mcpServers,
          updateMessageContent,
          removeMessagesAfter,
          setEditingMessageId,
          setComposerDraft,
          stream,
          stop,
        });
        toast.success("Edit saved & regenerated");
      } catch {
        toast.error("Failed to save edit");
      } finally {
        requestAnimationFrame(() => {
          if (taRef.current) taRef.current.style.height = "auto";
        });
      }
      return;
    }

    // Upload any pending attachments first (in parallel)
    const pending = attachments.filter((a) => !a.uploadedId && !a.error && a.uploading !== false);
    for (const a of pending) {
      a.uploading = true;
    }
    setAttachments([...attachments]);
    let results: Array<{ id: string; error?: string; uploadedId?: string }> = [];
    if (pending.length > 0) {
      // Lazy conversations: attachments must upload against a persisted row —
      // materialize a pending chat first, otherwise the route 404s and the
      // files would be silently dropped on send.
      const realConvId = await ensureRealConversation(activeConversationId ?? undefined);
      if (!realConvId) { toast.error("No active conversation"); return; }
      const convId = realConvId;
      results = await Promise.all(
        pending.map(async (a) => {
          try {
            const formData = new FormData();
            formData.append("file", a.file);
            const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}/attachments`, {
              method: "POST",
              credentials: "include",
              body: formData,
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: "Upload failed" }));
              return { id: a.id, error: err.error || "Upload failed" };
            }
            const data = await res.json();
            return { id: a.id, uploadedId: data.attachments?.[0]?.id };
          } catch (e: any) {
            return { id: a.id, error: e?.message || "Upload failed" };
          }
        }),
      );
      setAttachments((prev) =>
        prev.map((a) => {
          const r = results.find((x) => x.id === a.id);
          if (!r) return { ...a, uploading: false };
          if ("error" in r && r.error) return { ...a, error: r.error, uploading: false };
          if ("uploadedId" in r && r.uploadedId) return { ...a, uploadedId: r.uploadedId, uploading: false };
          return { ...a, uploading: false };
        }),
      );
    }

    const newlyUploaded = results.filter((r): r is { id: string; uploadedId: string } => "uploadedId" in r && !!r.uploadedId);
    const uploadErrors = results.filter((r) => "error" in r && r.error);
    const alreadyUploaded = attachments.filter((a) => a.uploadedId && !pending.some((p) => p.id === a.id));
    if (!value && newlyUploaded.length === 0 && alreadyUploaded.length === 0) {
      if (uploadErrors.length > 0) toast.error(uploadErrors[0].error ?? "Upload failed");
      setAttachments((prev) => prev.map((a) => ({ ...a, uploading: false })));
      return;
    }
    const allAttachmentMetas: AttachmentDTO[] = [
      ...alreadyUploaded.map((a) => ({ id: a.uploadedId!, name: a.file.name, type: a.file.type, size: a.file.size, persisted: true as const })),
      ...newlyUploaded.map((r) => {
        const a = pending.find((x) => x.id === r.id)!;
        return { id: r.uploadedId, name: a.file.name, type: a.file.type, size: a.file.size, persisted: true as const };
      }),
    ];
    const allIds = allAttachmentMetas.map((a) => a.id);
    if (isStreaming) {
      // While the agent iterates, submit QUEUES the message — the running
      // loop's next iteration picks it up (no interrupt, no stop). Keep the
      // draft + attachments when the queue fails so nothing typed is lost.
      const queued = await onQueue(
        value,
        allIds.length > 0 ? allIds : undefined,
        allAttachmentMetas.length > 0 ? allAttachmentMetas : undefined,
      );
      if (queued === false) {
        setAttachments((prev) => prev.map((a) => ({ ...a, uploading: false })));
        return;
      }
    } else {
      onSend(value, allIds.length > 0 ? allIds : undefined, allAttachmentMetas.length > 0 ? allAttachmentMetas : undefined);
    }
    setText("");
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setAttachments([]);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    setText("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    // Reset the input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (files.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
      toast.error(`Each file must be under ${MAX_ATTACHMENT_BYTES / 1000 / 1000} MB.`);
      return;
    }
    if (attachments.length + files.length > 20) {
      toast.error("Max 20 attachments per message.");
      return;
    }
    const newPreviews: AttachPreview[] = files.map((file) => {
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      return { id, file, previewUrl };
    });
    setAttachments((prev) => [...prev, ...newPreviews]);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const fileItems = items.filter((item) => item.kind === "file");
    if (fileItems.length === 0) return;
    e.preventDefault();
    // Insert text at cursor position (handle selection replacement)
    const pastedText = e.clipboardData.getData("text");
    if (pastedText) {
      const el = taRef.current;
      if (el) {
        const start = el.selectionStart ?? text.length;
        const end = el.selectionEnd ?? text.length;
        const before = text.slice(0, start);
        const after = text.slice(end);
        setText(before + pastedText + after);
        requestAnimationFrame(() => {
          const pos = start + pastedText.length;
          el.setSelectionRange(pos, pos);
        });
      }
    }
    const newChips: AttachPreview[] = [];
    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`File "${file.name}" exceeds ${MAX_ATTACHMENT_BYTES / 1000 / 1000} MB limit.`);
        continue;
      }
      if (newChips.length + attachments.length >= 20) {
        toast.error("Max 20 attachments per message.");
        break;
      }
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      newChips.push({ id, file, previewUrl });
    }
    if (newChips.length > 0) {
      setAttachments((prev) => [...prev, ...newChips]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention autocomplete handles ArrowUp/Down/Enter/Tab/Escape via a
    // window-level capture handler when the popover is open. We must
    // NOT also fire ⌘↵/Esc here for those keys — the capture handler
    // preventDefault-stops them before this React handler runs.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape" && isEditMode && !trigger) {
      e.preventDefault();
      cancelEdit();
      return;
    }
    // Plain Enter inserts a newline (per spec hint) — unless the
    // mention popover is open, in which case Enter selects.
  };

  /* ---------------- Mention autocomplete ----------------
   *
   * The composer's textarea is bound to the store's `composerDraft`.
   * On every change or cursor move we run `detectTrigger` against the
   * text up to the caret. If a trigger is found we render the
   * `MentionAutocomplete` popover above the textarea. When the user
   * picks an item, we splice `insertText` into the draft at the
   * trigger's start position, replacing the `@query` / `/query` token.
   */
  const [trigger, setTrigger] = React.useState<MentionTrigger | null>(null);

  // Recompute the trigger on every text or cursor change.
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) {
      setTrigger(null);
      return;
    }
    const next = detectTrigger(text, el.selectionStart ?? 0);
    setTrigger((cur) => {
      // Shallow compare to avoid needless re-renders.
      if (
        cur &&
        next &&
        cur.kind === next.kind &&
        cur.start === next.start &&
        cur.end === next.end &&
        cur.query === next.query
      ) {
        return cur;
      }
      return next;
    });
  }, [text]);

  // Also recompute on selection changes (cursor moves without text edit).
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const onSel = () => {
      const next = detectTrigger(text, el.selectionStart ?? 0);
      setTrigger((cur) => {
        if (
          cur &&
          next &&
          cur.kind === next.kind &&
          cur.start === next.start &&
          cur.end === next.end &&
          cur.query === next.query
        ) {
          return cur;
        }
        return next;
      });
    };
    el.addEventListener("select", onSel);
    el.addEventListener("keyup", onSel);
    el.addEventListener("click", onSel);
    return () => {
      el.removeEventListener("select", onSel);
      el.removeEventListener("keyup", onSel);
      el.removeEventListener("click", onSel);
    };
  }, [text]);

  const handleMentionPick = React.useCallback(
    (insertText: string) => {
      if (!trigger) return;
      const before = text.slice(0, trigger.start);
      const after = text.slice(trigger.end);
      const next = before + insertText + after;
      setText(next);
      setTrigger(null);
      // Move the caret to just after the inserted text and refocus.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        const pos = before.length + insertText.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [trigger, text, setText],
  );

  const handleMentionClose = React.useCallback(() => setTrigger(null), []);

  return (
    <div className="border-t bg-background/80 backdrop-blur-sm">
      <div className={cn("mx-auto px-4 py-2", conversationWidthClass(conversationWidth))}>
        <TodoCollapsedBanner key={activeConversationId ?? "none"} conversationId={activeConversationId} />
        <AnimatePresence>
          {!hasMessages && !isEditMode && (
            <motion.div
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.15 }}
              className="mb-1.5 flex items-center"
            >
              <ProjectSelector />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {isEditMode && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="mb-2 flex items-center gap-2 rounded-md border border-brand/40 bg-brand/5 px-2.5 py-1.5 text-xs"
            >
              <Pencil className="size-3 text-brand" />
              <span className="font-medium text-foreground">Editing message</span>
              <span className="text-muted-foreground">
                — Send to save &amp; regenerate · Esc to cancel
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2 text-xs gap-1"
                onClick={cancelEdit}
                aria-label="Cancel edit"
              >
                <X className="size-3" />
                Cancel
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className={cn(
            "relative rounded-xl bg-card shadow-xs transition-all border p-2 flex flex-col gap-1",
            isEditMode
              ? "border-brand/50 ring-1 ring-brand/30 shadow-sm"
              : isFocused
                ? "border-brand/40 shadow-xs"
                : "border-border/60 hover:border-border",
          )}
        >
          {permissionPrompt && (!permissionPrompt.conversationId || permissionPrompt.conversationId === activeConversationId) ? (
            <PermissionPromptCard
              prompt={permissionPrompt}
              onResolve={(decision) => resolvePermissionPrompt(permissionPrompt.id, decision)}
            />
          ) : questionPrompt && (!questionPrompt.conversationId || questionPrompt.conversationId === activeConversationId) ? (
            <QuestionPromptCard
              prompt={questionPrompt}
              onResolve={(answer) => resolveQuestionPrompt(questionPrompt.id, answer)}
            />
          ) : (
            <React.Fragment>
              <MentionAutocomplete
                trigger={trigger}
                onPick={handleMentionPick}
                onClose={handleMentionClose}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.zip,.tar,.gz,.ts,.tsx,.js,.jsx,.css,.html,.sh"
                className="hidden"
                onChange={handleFilePick}
                aria-label="Choose files to attach"
              />
              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2 pb-1">
                  {attachments.map((a) => {
                    const isImage = Boolean(a.previewUrl);
                    return (
                      <div
                        key={a.id}
                        className={cn(
                          "relative group transition-all shrink-0",
                          isImage
                            ? "size-14 sm:size-16 rounded-xl overflow-hidden border border-border/80 bg-muted/40 shadow-2xs"
                            : "h-11 px-3 flex items-center gap-2 rounded-xl border border-border/80 bg-muted/30 shadow-2xs max-w-[220px]",
                          a.error && "border-rose-500/50 bg-rose-500/5",
                          a.uploading && "opacity-75",
                        )}
                      >
                        {isImage ? (
                          <>
                            <img
                              src={a.previewUrl}
                              alt={a.file.name}
                              className="size-full object-cover rounded-xl"
                            />
                            {a.uploading && (
                              <div className="absolute inset-0 bg-black/40 backdrop-blur-2xs flex items-center justify-center text-[10px] text-white font-medium">
                                Uploading…
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <FileIcon type={a.file.type} />
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="text-xs font-medium truncate leading-snug">{a.file.name}</span>
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {a.error ? "Failed" : a.uploading ? "Uploading…" : formatBytes(a.file.size)}
                              </span>
                            </div>
                          </>
                        )}
                        {!a.uploading && (
                          <button
                            type="button"
                            onClick={() => removeAttachment(a.id)}
                            className={cn(
                              "size-4 rounded-full bg-zinc-900/80 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center transition-opacity shadow-2xs",
                              isImage
                                ? "absolute top-1 right-1 opacity-60 group-focus-within:opacity-100 hover:opacity-100"
                                : "ml-auto shrink-0 opacity-60 hover:opacity-100",
                            )}
                            aria-label={`Remove ${a.file.name}`}
                          >
                            <X className="size-2.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <Textarea
                ref={taRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                onPaste={handlePaste}
                placeholder={isEditMode ? "Edit your message…" : "Message HermOS…  (@ to mention, / to command)"}
                className="min-h-[40px] border-0 bg-transparent shadow-none resize-none focus-visible:ring-0 px-2.5 pt-1.5 pb-0 text-sm leading-relaxed placeholder:text-muted-foreground/50"
                disabled={disabled && !isStreaming}
                aria-label="Message input"
                rows={1}
              />
              <div className="flex items-center justify-between gap-1 px-1 pb-0.5 pt-1 min-w-0">
                <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto no-scrollbar">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6.5 w-6.5 p-0 text-muted-foreground hover:text-foreground text-xs rounded-md transition-colors shrink-0 font-medium"
                    aria-label="Attach files"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="size-3.5 text-brand" />
                  </Button>

                  {/* Mention + command helper buttons — mouse affordance for
                      the @ mention and / command popovers */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6.5 px-1.5 text-[11px] font-mono rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium"
                    onClick={() => {
                      const el = taRef.current;
                      if (!el) return;
                      const pos = el.selectionStart ?? text.length;
                      const next = text.slice(0, pos) + "@" + text.slice(pos);
                      setText(next);
                      requestAnimationFrame(() => {
                        el.focus();
                        el.setSelectionRange(pos + 1, pos + 1);
                      });
                    }}
                    aria-label="Insert @mention"
                    title="Mention a file, skill, MCP server, or agent (@)"
                  >
                    @
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6.5 px-1.5 text-[11px] font-mono rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium"
                    onClick={() => {
                      const el = taRef.current;
                      if (!el) return;
                      const pos = el.selectionStart ?? text.length;
                      const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
                      const linePrefix = text.slice(lineStart, pos);
                      if (linePrefix.trim() === "") {
                        const next = text.slice(0, lineStart) + "/" + text.slice(lineStart);
                        setText(next);
                        requestAnimationFrame(() => {
                          el.focus();
                          el.setSelectionRange(lineStart + 1, lineStart + 1);
                        });
                      } else {
                        setText(text + "\n/clear ");
                        requestAnimationFrame(() => {
                          el.focus();
                          const p = (text + "\n/clear ").length;
                          el.setSelectionRange(p, p);
                        });
                      }
                    }}
                    aria-label="Insert /command"
                    title="Run a command (/clear, /compact, /agent, /model)"
                  >
                    /
                  </Button>

                  <ModelSelector compact />

                  <Popover open={modeOpen} onOpenChange={setModeOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6.5 px-1.5 gap-1 text-[11px] rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium">
                        {(() => {
                          const Icon = AGENT_MODES_BY_VALUE[composerMode].icon;
                          return <Icon className="size-3.5 text-brand" />;
                        })()}
                        <span className="hidden sm:inline font-medium text-foreground">{AGENT_MODES_BY_VALUE[composerMode].label}</span>
                        <ChevronDown className="size-3 text-muted-foreground/60" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-48 p-1" align="start">
                      <div className="space-y-0.5">
                        {AGENT_MODES.map((m) => {
                          const Icon = m.icon;
                          const isSelected = composerMode === m.value;
                          return (
                            <button
                              key={m.value}
                              type="button"
                              onClick={() => {
                                setComposerMode(m.value as AgentMode);
                                setModeOpen(false);
                              }}
                              className={cn(
                                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-accent",
                                isSelected && "bg-accent font-medium text-foreground",
                              )}
                            >
                              <Icon className="size-3.5 text-brand shrink-0" />
                              <span className="font-medium flex-1 truncate">{m.label}</span>
                              {isSelected && <Check className="size-3 text-brand shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>

                  {/* Thinking level selector — shown directly in the composer */}
                  <ThinkingSelector />

                  {/* Permissions indicator — opens settings → permissions */}
                  <PermissionsButton />

                  {/* Tools indicator (compact icon-only) */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6.5 px-1.5 gap-1 text-[11px] rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium"
                        aria-label="Enabled tools"
                        title={`${enabledToolsCount} tools enabled`}
                      >
                        <Wrench className="size-3.5 text-brand" />
                        <span className="text-[10px] font-mono text-muted-foreground">{enabledToolsCount}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0 max-h-[min(420px,80vh)] flex flex-col" align="start">
                      <div className="px-3 py-2 border-b shrink-0">
                        <div className="text-xs font-medium">Enabled tools</div>
                        <div className="text-[10px] text-muted-foreground">
                          {enabledToolsCount} tools available to the agent
                        </div>
                      </div>
                      <ScrollArea className="flex-1 min-h-0 overflow-auto">
                        <div className="p-1.5 space-y-0.5">
                          {enabledTools.length === 0 && connectedMcpTools.length === 0 ? (
                            <div className="px-2 py-3 text-[11px] text-muted-foreground text-center">
                              No tools enabled
                            </div>
                          ) : (
                            <>
                              {enabledTools.map((t) => (
                                <div
                                  key={`builtin-${t}`}
                                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]"
                                >
                                  <Wrench className="size-3 text-muted-foreground" />
                                  <span className="font-mono">{t}</span>
                                  <Badge variant="secondary" className="ml-auto text-[9px] h-4">
                                    builtin
                                  </Badge>
                                </div>
                              ))}
                              {connectedMcpTools.map((t, i) => (
                                <div
                                  key={`mcp-${t.server}-${t.tool}-${i}`}
                                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]"
                                >
                                  <Wrench className="size-3 text-muted-foreground" />
                                  <div className="min-w-0">
                                    <div className="font-mono truncate">{t.tool}</div>
                                    <div className="text-[10px] text-muted-foreground truncate">
                                      {t.server}
                                    </div>
                                  </div>
                                  <Badge variant="outline" className="ml-auto text-[9px] h-4">
                                    mcp
                                  </Badge>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  <span className="hidden md:flex items-center gap-0.5 text-[10px] text-muted-foreground mr-0.5">
                    <kbd className="inline-flex items-center justify-center min-w-[1.1rem] rounded border bg-muted px-1 py-px font-mono text-[9px] text-foreground/80">{isMacPlatform() ? "⌘" : "Ctrl"}</kbd>
                    <kbd className="inline-flex items-center justify-center min-w-[1.1rem] rounded border bg-muted px-1 py-px font-mono text-[9px] text-foreground/80">↵</kbd>
                  </span>
                  <AnimatePresence mode="wait" initial={false}>
                    {isStreaming ? (
                      // While the agent runs, Stop is ALWAYS available — a
                      // draft must never hide the only way to halt the run.
                      // With a draft, a Queue button sits next to it; the
                      // draft becomes the next iteration's user turn.
                      <motion.div
                        key="streaming"
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ duration: 0.15 }}
                        className="flex items-center gap-1.5 shrink-0"
                      >
                        {hasDraft && !isEditMode && (
                          <Button
                            size="sm"
                            className="h-7 px-2.5 gap-1.5 rounded-lg bg-brand hover:bg-brand/90 text-brand-foreground transition-all text-xs font-medium shrink-0 flex items-center justify-center shadow-2xs"
                            onClick={() => void submit()}
                            title="Queue message — sent to the agent on its next iteration (the current run keeps going)"
                            aria-label="Queue message for next iteration"
                          >
                            <SendHorizonal className="size-3.5" />
                            <span className="hidden sm:inline">Queue</span>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 p-0 rounded-lg text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-300 transition-colors shrink-0 flex items-center justify-center border-0"
                          onClick={onStop}
                          aria-label="Stop streaming"
                          title={hasDraft ? "Stop the agent — your draft stays in the composer" : "Stop the agent"}
                        >
                          <Square className="size-3.5 fill-rose-500 text-rose-500" />
                        </Button>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="send"
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ duration: 0.15 }}
                        className="shrink-0"
                      >
                        <Button
                          size="sm"
                          className="size-7 p-0 rounded-lg bg-brand hover:bg-brand/90 text-brand-foreground transition-all text-xs font-medium disabled:opacity-30 shrink-0 flex items-center justify-center shadow-2xs"
                          onClick={() => void submit()}
                          disabled={!hasDraft || disabled}
                          title={isEditMode ? "Save edit & regenerate" : "Send message"}
                          aria-label={isEditMode ? "Save edit & regenerate" : "Send message"}
                        >
                          {isEditMode ? (
                            <Pencil className="size-3.5" />
                          ) : (
                            <Send className="size-3.5" />
                          )}
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </React.Fragment>
          )}
        </div>
      </div>
    </div>
  );
}

function ThinkingSelector() {
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const providers = useAppStore((s) => s.providers);
  const thinkingLevel = useAppStore((s) => s.thinkingLevel);
  const setThinkingLevel = useAppStore((s) => s.setThinkingLevel);
  const [open, setOpen] = React.useState(false);

  const caps = React.useMemo(() => {
    const provider = providers.find((p) => p.id === selectedProvider);
    const models = provider?.models ?? [];
    const findCaps = (id: string): ModelReasoningCapabilities | undefined =>
      models.find((m) => m.id === id)?.reasoning;
    if (selectedModel !== "auto") return findCaps(selectedModel);
    // "auto" resolves server-side to the first enabled concrete model
    // (the executor's apiModel resolution); mirror it so per-model caps
    // surface even for the default selection instead of falling back to
    // the full scheme list.
    const autoModel = models.find((m) => m.id !== "auto" && m.enabled !== false);
    return autoModel ? findCaps(autoModel.id) : undefined;
  }, [providers, selectedProvider, selectedModel]);
  const levels = React.useMemo(
    () => getReasoningLevels({ providerId: selectedProvider, caps }),
    [selectedProvider, caps],
  );

  if (levels.length === 0) return null;

  // Default to "default" (Model default thinking) if no explicit selection yet.
  // The user's stored thinkingLevel is the source of truth.
  const current = levels.find((t) => t.value === normalizeThinkingLevel(thinkingLevel)) ?? levels.find((t) => t.value === "default") ?? levels[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6.5 px-1.5 gap-1 text-[11px] rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium"
          aria-label="Thinking level"
          title={`Thinking level: ${current.label}`}
        >
          <Brain className="size-3.5 text-brand" />
          <span className="hidden md:inline font-medium text-foreground">{current.label}</span>
          <ChevronDown className="size-3 text-muted-foreground/60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {levels.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => {
              setThinkingLevel(t.value);
              setOpen(false);
            }}
            className={cn(
              "w-full text-left text-xs px-2.5 py-1.5 rounded-sm hover:bg-accent flex items-center justify-between gap-2",
              t.value === current.value && "bg-accent font-medium",
            )}
          >
            <span className="shrink-0 font-medium">{t.label}</span>
            <span className="text-[10px] text-muted-foreground truncate text-right">{t.desc}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function PermissionsButton() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const [open, setOpen] = React.useState(false);
  const [perms, setPerms] = React.useState<{ rules: Array<{ action: string; mode: string }> } | null>(null);

  // Fetch live permissions from the API — refetched every time the popover
  // opens so the badges reflect rules edited in settings since the last open.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/permissions", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setPerms(d?.config ?? null);
      })
      .catch((err: unknown) => {
        console.warn("[PermissionsButton] Failed to load permissions:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const getMode = (action: string): string => {
    if (!perms) return "ask";
    const rule = perms.rules?.find((r) => r.action === action);
    return rule?.mode ?? "ask";
  };

  const modeColor = (mode: string) => {
    if (mode === "allow") return "text-brand border-brand/40";
    if (mode === "deny") return "text-red-500 border-red-500/40";
    return "text-amber-500 border-amber-500/40";
  };

  const modeLabel = (mode: string) => {
    if (mode === "allow") return "Allow";
    if (mode === "deny") return "Deny";
    return "Ask";
  };

  const actions = [
    { action: "file.read", label: "File read" },
    { action: "file.write", label: "File write" },
    { action: "command.run", label: "Commands" },
    { action: "browser.open", label: "Browser" },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6.5 px-1.5 gap-1 text-[11px] rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium"
          aria-label="Permissions"
          title="Permissions"
        >
          <Shield className="size-3.5 text-brand" />
          <span className="hidden md:inline font-medium text-foreground">Perms</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="text-xs font-medium mb-2">Permissions</div>
        <div className="space-y-1">
          {actions.map((a) => {
            const mode = getMode(a.action);
            return (
              <div key={a.action} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{a.label}</span>
                <Badge variant="outline" className={cn("text-[9px] h-4", modeColor(mode))}>
                  {modeLabel(mode)}
                </Badge>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-[11px]"
          onClick={() => {
            setSettingsTab("permissions");
            setSettingsOpen(true);
            setOpen(false);
          }}
        >
          <Shield className="size-3" />
          Manage permissions
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ *
 * PermissionPromptCard — inline card that replaces the composer input
 * when the agent requests a permission. Shows the action, target, and
 * Allow once / Always / Deny buttons. Auto-deny after 2 minutes
 * (mirrors APPROVAL_TTL_MS in permissions-prompt.ts).
 * ------------------------------------------------------------------ */

const PERM_AUTO_DENY_MS = 120_000;

function PermissionPromptCard({
  prompt,
  onResolve,
}: {
  prompt: NonNullable<ReturnType<typeof useAppStore.getState>["permissionPrompt"]>;
  onResolve: (decision: "allow-once" | "always-allow" | "deny") => void;
}) {
  const resolveRef = React.useRef(onResolve);
  React.useEffect(() => {
    resolveRef.current = onResolve;
  });
  const [remaining, setRemaining] = React.useState(PERM_AUTO_DENY_MS);

  React.useEffect(() => {
    setRemaining(PERM_AUTO_DENY_MS);
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const left = Math.max(0, PERM_AUTO_DENY_MS - elapsed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(interval);
        resolveRef.current("deny");
      }
    }, 200);
    return () => clearInterval(interval);
  }, [prompt.id]);

  const secondsLeft = Math.ceil(remaining / 1000);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="p-3"
      role="dialog"
      aria-live="assertive"
      aria-label={`Permission request: ${prompt.action}`}
    >
      <div className="rounded-lg border border-amber-500/40 bg-card overflow-hidden">
        <div className="flex items-start gap-2.5 p-3 pb-2">
          <div className="mt-0.5 size-7 shrink-0 rounded-md bg-amber-500/10 flex items-center justify-center">
            <ShieldAlert className="size-4 text-amber-600 dark:text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground">
              HermOS wants permission
            </div>
            <div className="mt-1 text-[13px] text-foreground/90 leading-snug">
              <span className="text-muted-foreground">Action: </span>
              <code className="font-mono text-[11px] bg-muted/60 rounded px-1 py-0.5">
                {prompt.action}
              </code>
            </div>
            <div className="mt-1.5 text-[13px] text-foreground leading-snug">
              <span className="text-muted-foreground">{prompt.toolName ?? "tool"} </span>
              <span className="font-medium">{prompt.target}</span>
            </div>
          </div>
        </div>

        <div className="px-3">
          <div className="h-0.5 w-full bg-muted overflow-hidden rounded-full">
            <div
              className="h-full bg-amber-500/60 transition-all duration-200 ease-linear"
              style={{ width: `${(remaining / PERM_AUTO_DENY_MS) * 100}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 p-3 pt-2">
          <Button
            size="sm"
            onClick={() => onResolve("allow-once")}
            className="h-8 gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
            aria-label="Allow once"
          >
            <Check className="size-3.5" />
            Allow once
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onResolve("always-allow")}
            className="h-8 gap-1"
            aria-label="Always allow"
          >
            <ShieldCheck className="size-3.5" />
            Always
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onResolve("deny")}
            className="h-8 gap-1"
            aria-label="Deny"
          >
            <Ban className="size-3.5" />
            Deny
          </Button>
        </div>
        <div className="px-3 pb-2 -mt-1 text-[10px] text-muted-foreground/80 font-mono text-center">
          Auto-deny in {secondsLeft}s
        </div>
      </div>
    </motion.div>
  );
}

function FileIcon({ type }: { type: string }) {
  const t = (type || "").toLowerCase();
  let emoji: string;
  if (t.startsWith("image/")) emoji = "\u{1F5BC}";
  else if (t.includes("pdf")) emoji = "\u{1F4C4}";
  else if (t.includes("word") || t.includes("document")) emoji = "\u{1F4DD}";
  else if (t.includes("excel") || t.includes("sheet")) emoji = "\u{1F4CA}";
  else if (t.includes("powerpoint") || t.includes("presentation")) emoji = "\u{1F4F9}";
  else if (t.includes("zip") || t.includes("tar") || t.includes("gzip")) emoji = "\u{1F4E6}";
  else if (t.includes("json") || t.includes("xml") || t.includes("yaml")) emoji = "\u{1F4CB}";
  else if (t.startsWith("text/")) emoji = "\u{1F4DD}";
  else emoji = "\u{1F4CE}";
  return <span className="text-xs shrink-0 leading-none" aria-hidden>{emoji}</span>;
}

/**
 * Save an edit to a user message: update locally, truncate later messages,
 * and re-stream the assistant response via a single request to the executor.
 *
 * The executor handles all DB writes (update message + delete stale responses)
 * atomically via the `editMessageId` field — no separate PATCH needed.
 */
async function commitMessageEdit(
  messageId: string,
  newContent: string,
  deps: {
    activeConversationId: string | null;
    selectedProvider: import("@/lib/types").ProviderId;
    selectedModel: string;
    composerMode: import("@/lib/types").AgentMode;
    systemPrompt: string;
    mcpServers: import("@/lib/types").McpServerDTO[];
    updateMessageContent: (id: string, c: string) => void;
    removeMessagesAfter: (id: string) => void;
    setEditingMessageId: (id: string | null) => void;
    setComposerDraft: (s: string) => void;
    stream: (
      req: import("@/lib/types").ChatRequest,
      userMessageText: string,
      opts?: { skipUserAppend?: boolean },
    ) => Promise<void>;
    stop: (conversationId?: string) => void;
  },
) {
  const cid = deps.activeConversationId;
  if (!cid) {
    toast.error("No active conversation");
    return;
  }

  // 1. Stop any in-progress stream FIRST — before touching any local state.
  deps.stop(cid);

  // 2. Exit edit mode and clear the draft immediately.
  deps.setEditingMessageId(null);
  deps.setComposerDraft("");

  // 3. Optimistic local update: update the target message content in-place,
  //    then drop everything that came after it (stale assistant responses).
  //    We do NOT remove the target itself — no remove-and-re-add dance needed.
  deps.updateMessageContent(messageId, newContent);
  deps.removeMessagesAfter(messageId);

  // 4. Re-stream — skip appending a new user message (the edited one is already
  //    in the list). Pass editMessageId so the executor updates the DB row and
  //    deletes stale assistant messages atomically before running the agent loop.
  const ctxConfig = useAppStore.getState().contextConfig;
  await deps.stream(
    {
      conversationId: cid,
      message: newContent,
      provider: deps.selectedProvider,
      model: deps.selectedModel,
      mode: deps.composerMode,
      systemPrompt: deps.systemPrompt,
      thinkingLevel: useAppStore.getState().thinkingLevel as any,
      mcpServerIds: deps.mcpServers
        .filter((s) => s.status === "connected")
        .map((s) => s.id),
      editMessageId: messageId,
      contextConfig: ctxConfig,
    },
    newContent,
    { skipUserAppend: true },
  );
}

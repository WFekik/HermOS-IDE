"use client";

import * as React from "react";
import { Terminal as TerminalIcon, Trash2, CornerDownLeft, AlertTriangle, ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useTranslation } from "@/hooks/use-translation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getPlatformShells, getDefaultShell } from "@/lib/platform";
import type { TerminalRequest } from "@/lib/types";

type Shell = TerminalRequest["shell"];
type LinePayload =
  | { kind: "in"; text: string; shell: Shell }
  | { kind: "out"; text: string }
  | { kind: "err"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "banner"; text: string };

type Line = { id: string } & LinePayload;

const PROMPTS: Record<Shell, string> = {
  bash: "$",
  zsh: "%",
  pwsh: "PS>",
  cmd: "C:\\>",
};

function makeLine(payload: LinePayload): Line {
  return { id: crypto.randomUUID(), ...payload };
}

export function TerminalPanel() {
  const { t } = useTranslation();
  const runTerminal = useAppStore((s) => s.runTerminal);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const availableShells = React.useMemo(() => getPlatformShells(), []);
  const [shell, setShell] = React.useState<Shell>(() => getDefaultShell());
  const wsPrefix = activeWorkspace?.name ? `[${activeWorkspace.name}] ` : "";
  const currentPrompt = `${wsPrefix}${PROMPTS[shell]}`;

  // Ensure shell is valid for the current platform
  React.useEffect(() => {
    const isSupported = availableShells.some((s) => s.value === shell);
    if (!isSupported) {
      setShell(getDefaultShell());
    }
  }, [availableShells, shell]);
  const [input, setInput] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>(() => [
    makeLine({ kind: "banner", text: t("terminal_welcome") }),
  ]);
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const append = (...payloads: LinePayload[]) =>
    setLines((prev) => [...prev, ...payloads.map(makeLine)]);

  const help = () =>
    append(
      { kind: "out", text: t("terminal_help_available") },
      { kind: "out", text: t("terminal_help_cmd_help") },
      { kind: "out", text: t("terminal_help_cmd_echo") },
      { kind: "out", text: t("terminal_help_cmd_ls") },
      { kind: "out", text: t("terminal_help_cmd_pwd") },
      { kind: "out", text: t("terminal_help_cmd_whoami") },
      { kind: "out", text: t("terminal_help_cmd_clear") },
      { kind: "out", text: t("terminal_help_sandboxed_desc") },
    );

  const handleCommand = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    append({ kind: "in", text: cmd, shell });
    setHistory((h) => [...h, cmd]);
    setHistIdx(null);

    if (cmd === "clear") {
      setLines([makeLine({ kind: "banner", text: t("terminal_welcome") })]);
      return;
    }
    if (cmd === "help") {
      help();
      return;
    }

    if (cmd === "echo" || cmd.startsWith("echo ")) {
      append({ kind: "out", text: cmd.slice(5) });
      return;
    }

    setBusy(true);
    try {
      const res = await runTerminal({ command: cmd, shell });
      if (!res) {
        append({ kind: "err", text: t("terminal_no_response") });
      } else if (res.blocked) {
        append({
          kind: "warn",
          text: t("terminal_blocked_prefix", { reason: res.reason ?? t("terminal_blocked_default") }),
        });
      } else {
        if (res.stdout) append({ kind: "out", text: res.stdout.replace(/\n$/, "") });
        if (res.stderr) append({ kind: "err", text: res.stderr.replace(/\n$/, "") });
        if (!res.stdout && !res.stderr) {
          append({ kind: "out", text: `(exit ${res.exitCode})` });
        }
      }
    } catch (e: any) {
      append({
        kind: "err",
        text: t("terminal_error_prefix", { message: e?.message ?? t("terminal_failed_default") }),
      });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const next = input;
      setInput("");
      void handleCommand(next);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(history[idx]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (history.length === 0 || histIdx === null) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(null);
        setInput("");
      } else {
        setHistIdx(idx);
        setInput(history[idx]);
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 px-2 h-8 border-b bg-muted/40">
        <TerminalIcon className="size-3.5 text-brand" />
        <span className="text-[11px] font-medium">{t("terminal")}</span>
        <Badge
          variant="outline"
          className="text-[9px] font-normal px-1.5 py-0 h-4 text-muted-foreground border-border/50 bg-background/50 select-none"
          title={t("terminal_non_interactive_tooltip")}
        >
          {t("terminal_non_interactive")}
        </Badge>
        <div className="ms-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground font-mono"
                aria-label={t("terminal_shell_aria", { shell })}
                title={t("terminal_select_shell")}
              >
                <span>{shell}</span>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold py-1">
                {t("terminal_available_shells")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableShells.map((s) => (
                <DropdownMenuItem
                  key={s.value}
                  onClick={() => setShell(s.value)}
                  className={cn(
                    "flex items-center justify-between text-xs cursor-pointer py-1.5",
                    shell === s.value && "text-brand font-medium"
                  )}
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-xs">{s.value}</span>
                    <span className="text-[10px] text-muted-foreground font-sans">{s.label}</span>
                  </div>
                  {shell === s.value && <Check className="size-3.5 text-brand" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setLines([makeLine({ kind: "banner", text: t("terminal_welcome") })])}
            aria-label={t("terminal_clear")}
            title={t("terminal_clear")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed"
        role="log"
      >
        {lines.map((l) => (
          <LineView key={l.id} line={l} prompt={currentPrompt} />
        ))}
      </div>

      <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-1.5">
        <span className="font-mono text-[12px] text-brand shrink-0">{currentPrompt}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent font-mono text-[12px] text-zinc-900 dark:text-zinc-100 outline-none placeholder:text-zinc-500 disabled:opacity-60"
          placeholder={busy ? t("terminal_running") : `${wsPrefix}${t("terminal_placeholder")}`}
          aria-label={t("terminal_input_aria")}
        />
        <CornerDownLeft className="size-3 text-zinc-500" />
      </div>
    </div>
  );
}

function LineView({ line, prompt }: { line: Line; prompt: string }) {
  if (line.kind === "banner") {
    return <div className="text-brand/90 italic">{line.text}</div>;
  }
  if (line.kind === "in") {
    return (
      <div className="flex gap-2">
        <span className="text-brand shrink-0">{prompt}</span>
        <span className="text-zinc-900 dark:text-zinc-100">{line.text}</span>
      </div>
    );
  }
  if (line.kind === "err") {
    return <div className="text-red-400 whitespace-pre-wrap">{line.text}</div>;
  }
  if (line.kind === "warn") {
    return (
      <div className="flex items-start gap-1.5 text-amber-400 whitespace-pre-wrap">
        <AlertTriangle className="size-3 shrink-0 mt-0.5" />
        <span>{line.text}</span>
      </div>
    );
  }
  return <div className={cn("text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap")}>{line.text}</div>;
}

"use client";

import * as React from "react";
import { Play, Loader2, ChevronDown, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { runCommand, type CommandResult } from "@/components/workspace/types";

export interface CommandBarProps {
  disabled?: boolean;
  disabledReason?: string;
  cwdLabel?: string;
  onResult?: (result: CommandResult) => void;
}

interface OutputState {
  command: string;
  result: CommandResult;
}

export function CommandBar({
  disabled,
  disabledReason,
  cwdLabel,
  onResult,
}: CommandBarProps) {
  const [input, setInput] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [outputs, setOutputs] = React.useState<OutputState[]>([]);
  const [open, setOpen] = React.useState(false);

  const run = async (rawCommand: string) => {
    const command = rawCommand.trim();
    if (!command || disabled || running) return;
    setInput("");
    setRunning(true);
    setOpen(true);
    try {
      const result = await runCommand(command);
      setOutputs((prev) => [...prev, { command, result }]);
      onResult?.(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "request failed";
      setOutputs((prev) => [
        ...prev,
        {
          command,
          result: {
            ok: false,
            blocked: false,
            stdout: "",
            stderr: message + "\n",
            exitCode: 1,
            command,
            cwd: cwdLabel ?? "",
            reason: message,
          },
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run(input);
    } else if (e.key === "ArrowUp" && !e.shiftKey) {
      // quick re-run previous command
      if (outputs.length > 0) {
        e.preventDefault();
        setInput(outputs[outputs.length - 1].command);
      }
    }
  };

  const lastOutput = outputs.length > 0 ? outputs[outputs.length - 1] : null;

  return (
    <div className="flex flex-col border-t bg-card shrink-0">
      <Collapsible
        open={open && (outputs.length > 0 || running)}
        onOpenChange={setOpen}
      >
        <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 hover:text-foreground"
              aria-label={open ? "Hide output" : "Show output"}
              disabled={outputs.length === 0 && !running}
            >
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  open && "rotate-180",
                )}
              />
              <span>Output</span>
              <span className="text-[10px] text-muted-foreground/60">
                ({outputs.length})
              </span>
              {lastOutput && (
                <Badge
                  variant="outline"
                  className={cn(
                    "ml-1 h-3.5 px-1 text-[9px] font-mono",
                    lastOutput.result.exitCode === 0
                      ? "border-brand/40 text-brand"
                      : "border-destructive/40 text-destructive",
                  )}
                >
                  exit {lastOutput.result.exitCode}
                </Badge>
              )}
            </button>
          </CollapsibleTrigger>
          {outputs.length > 0 && !running && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOutputs([]);
                setOpen(false);
              }}
              aria-label="Clear output"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t bg-white dark:bg-[#0b0b0c] text-zinc-800 dark:text-zinc-200 max-h-48 overflow-y-auto">
            <div className="px-3 py-2 font-mono text-[11px] leading-relaxed space-y-3">
              {outputs.map((out, i) => (
                <CommandOutput key={i} output={out} />
              ))}
              {running && (
                <div className="flex items-center gap-2 text-zinc-400">
                  <Loader2 className="size-3 animate-spin text-brand" />
                  <span>running: {input || (lastOutput?.command ?? "")}</span>
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Command input row — always at the bottom, not hidden by output */}
      <div className="flex h-10 items-center gap-2 px-3 border-t border-border/40 shrink-0 relative z-10 bg-card">
        <span className="font-mono text-xs text-brand select-none" aria-hidden>
          &gt;
        </span>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || running}
          spellCheck={false}
          autoComplete="off"
          className="h-7 flex-1 border-0 bg-transparent px-0 font-mono text-xs shadow-none focus-visible:ring-0"
          placeholder={
            disabled
              ? disabledReason ?? "open a folder to run commands"
              : running
                ? "running…"
                : "run a command in the workspace"
          }
          aria-label="Workspace command"
          title={disabled ? disabledReason : undefined}
        />
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1 px-2 text-[11px] bg-brand text-brand-foreground hover:bg-brand/90 shrink-0"
          onClick={() => void run(input)}
          disabled={disabled || running || !input.trim()}
          aria-label="Run command"
        >
          {running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Play className="size-3" />
          )}
          Run
        </Button>
      </div>
    </div>
  );
}

function CommandOutput({ output }: { output: OutputState }) {
  const { result } = output;
  const exitCode = result.exitCode ?? 0;
  return (
    <div className="rounded border border-border/40 bg-zinc-500/5 p-2 space-y-1.5 font-mono text-xs my-1">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "text-[9px] h-4 font-mono border-0 shrink-0",
            exitCode === 0
              ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
              : "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/20"
          )}
        >
          exit {exitCode}
        </Badge>
        <span className="text-brand font-bold select-none">$</span>
        <span className="break-all text-foreground font-semibold min-w-0 flex-1">{output.command}</span>
      </div>
      {result.blocked && result.reason && (
        <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400 bg-amber-500/10 p-1.5 rounded">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="break-all">{result.reason}</span>
        </div>
      )}
      {result.stdout && (
        <pre className="whitespace-pre-wrap break-all text-zinc-800 dark:text-zinc-200 bg-black/5 dark:bg-black/30 rounded p-1.5 max-h-64 overflow-y-auto">
          {result.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}
        </pre>
      )}
      {result.stderr && (
        <pre className="whitespace-pre-wrap break-all text-red-600 dark:text-red-400 bg-red-500/5 rounded p-1.5 max-h-64 overflow-y-auto">
          {result.stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}
        </pre>
      )}
      {!result.blocked && !result.stdout && !result.stderr && (
        <pre className="text-muted-foreground text-[11px] italic">(no output produced)</pre>
      )}
      {result.cwd && (
        <div className="pt-0.5 text-[10px] text-muted-foreground/70">
          cwd: <span className="font-mono">{result.cwd}</span>
        </div>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { Wand2, Check, X, RotateCw, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api-client";
import { toast } from "sonner";

export interface InlineAiLensProps {
  path: string;
  selectedCode: string;
  startLine?: number;
  endLine?: number;
  onAccept: (newCode: string) => void;
  onClose: () => void;
}

export function InlineAiLens({
  path,
  selectedCode,
  startLine,
  endLine,
  onAccept,
  onClose,
}: InlineAiLensProps) {
  const [instruction, setInstruction] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!instruction.trim() || loading) return;

    setLoading(true);
    try {
      const res = await apiPost<{ ok: boolean; modifiedCode: string }>(
        "/api/workspace/inline-edit",
        {
          path,
          instruction: instruction.trim(),
          code: selectedCode,
          startLine,
          endLine,
        },
      );
      if (res.ok && res.modifiedCode) {
        setResult(res.modifiedCode);
      }
    } catch (err) {
      toast.error("Inline edit failed", {
        description: err instanceof Error ? err.message : "Error generating edits",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      className="z-50 my-2 rounded-lg border bg-popover/95 p-3 shadow-xl backdrop-blur-md transition-all animate-in fade-in-50 zoom-in-95"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-1.5 font-medium text-xs text-brand">
          <Sparkles className="size-3.5" />
          <span>Inline AI Lens</span>
          {startLine && endLine && (
            <Badge variant="outline" className="h-4 text-[10px] font-mono">
              L{startLine}-L{endLine}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 rounded-sm hover:bg-accent"
          onClick={onClose}
        >
          <X className="size-3 text-muted-foreground" />
        </Button>
      </div>

      {result === null ? (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <Input
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Ask AI to edit, refactor, or add comments (Ctrl+I)..."
            className="h-8 text-xs bg-background/80"
            disabled={loading}
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 gap-1 bg-brand text-brand-foreground hover:bg-brand/90 text-xs px-3"
            disabled={!instruction.trim() || loading}
          >
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <>
                <Wand2 className="size-3" /> Edit
              </>
            )}
          </Button>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="rounded border bg-muted/40 p-2 font-mono text-xs overflow-x-auto max-h-40">
            <div className="text-[10px] text-muted-foreground mb-1 font-sans">Proposed Edits:</div>
            <pre className="text-foreground/90 whitespace-pre-wrap">{result}</pre>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setResult(null)}
            >
              <RotateCw className="size-3" /> Retry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={onClose}
            >
              <X className="size-3" /> Reject
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
              onClick={() => {
                onAccept(result);
                onClose();
              }}
            >
              <Check className="size-3" /> Accept
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

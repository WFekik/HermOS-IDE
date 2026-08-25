"use client";

import * as React from "react";
import {
  SquareFunction,
  Box,
  SquareStack,
  Type,
  Braces,
  ArrowDownToLine,
  ArrowUpFromLine,
  Loader2,
  AlertTriangle,
  RefreshCw,
  FileText,
  ListTree,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { apiGet, ApiRequestError } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";

/* -------------------------------------------------------------------------- *
 * Symbol outline
 *
 * Lists the symbols (functions, classes, interfaces, types, consts, imports,
 * exports) declared in the active file. Fetches GET /api/workspace/symbols
 * ?path=<activeFile> and renders a flat list sorted by line number. Clicking
 * a symbol dispatches `hermos:scroll-to-line` (handled by the file editor),
 * which scrolls + briefly highlights the line.
 *
 * Auto-refreshes when the active file changes. Shows loading skeleton,
 * empty states ("Open a file…", "Symbols only available for .ts/.tsx/…",
 * "No symbols found"), and an error state with Retry.
 * -------------------------------------------------------------------------- */

/** Matches the SymbolInfo type exported from src/lib/symbols.ts. */
interface SymbolInfo {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "const"
    | "export"
    | "import";
  line: number;
  exportName?: string;
  params?: string;
}

interface SymbolsResponse {
  symbols: SymbolInfo[];
  path: string;
  language: string | null;
}

/** File extensions for which the backend extractor returns symbols. */
const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isSupportedPath(path: string | null): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTS.has(lower.slice(dot));
}

const KIND_ICON: Record<SymbolInfo["kind"], React.ElementType> = {
  function: SquareFunction,
  class: Box,
  interface: SquareStack,
  type: Type,
  const: Braces,
  export: ArrowUpFromLine,
  import: ArrowDownToLine,
};

const KIND_LABEL: Record<SymbolInfo["kind"], string> = {
  function: "Function",
  class: "Class",
  interface: "Interface",
  type: "Type",
  const: "Const",
  export: "Export",
  import: "Import",
};

export interface SymbolOutlineProps {
  /** Optional override for the file path to outline. Defaults to the store's activeFileTab. */
  path?: string | null;
  /** Optional className for the root element. */
  className?: string;
}

export function SymbolOutline({ path: pathProp, className }: SymbolOutlineProps) {
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const path = pathProp !== undefined ? pathProp : activeFileTab;

  const [symbols, setSymbols] = React.useState<SymbolInfo[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unsupported, setUnsupported] = React.useState(false);

  // Fetch symbols whenever the active path changes. Short-circuits unsupported
  // extensions (no API call) so the UI shows the "only available for .ts/…"
  // empty state immediately.
  const fetchSymbols = React.useCallback(
    async (filePath: string, checkCancelled?: () => boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiGet<SymbolsResponse>("/api/workspace/symbols", {
          query: { path: filePath },
          timeoutMs: 5 * 60_000,
        });
        if (checkCancelled && checkCancelled()) return;
        const list = (res?.symbols ?? []).slice().sort((a, b) => a.line - b.line);
        setSymbols(list);
        setLoading(false);
      } catch (e: unknown) {
        if (checkCancelled && checkCancelled()) return;
        if (e instanceof ApiRequestError && e.status === 404) {
          setSymbols([]);
          setLoading(false);
          setError(null);
          return;
        }
        const msg = e instanceof ApiRequestError ? e.message : "Failed to load symbols";
        setSymbols(null);
        setLoading(false);
        setError(msg);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!path) {
      setSymbols(null);
      setLoading(false);
      setError(null);
      setUnsupported(false);
      return;
    }
    if (!isSupportedPath(path)) {
      setSymbols([]);
      setLoading(false);
      setError(null);
      setUnsupported(true);
      return;
    }
    let cancelled = false;
    setUnsupported(false);
    void fetchSymbols(path, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [path, fetchSymbols]);

  const refresh = React.useCallback(() => {
    if (!path || !isSupportedPath(path)) return;
    void fetchSymbols(path);
  }, [path, fetchSymbols]);

  const handleSymbolClick = React.useCallback((line: number) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent<{ line: number }>("hermos:scroll-to-line", { detail: { line } }),
    );
  }, []);

        // Render: states

  if (!path) {
    return (
      <OutlineEmpty
        icon={<FileText className="size-7 text-muted-foreground/40" />}
        title="No file open"
        body="Open a file to see its outline."
      />
    );
  }

  if (unsupported) {
    return (
      <OutlineEmpty
        icon={<ListTree className="size-7 text-muted-foreground/40" />}
        title="No symbols for this file"
        body="Symbols are only available for .ts, .tsx, .js, and .jsx files."
      />
    );
  }

  if (loading && symbols === null) {
    return <OutlineSkeleton />;
  }

  if (error && symbols === null) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <OutlineHeader path={path} count={null} onRefresh={refresh} refreshing={loading} />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-center">
            <AlertTriangle className="mx-auto size-7 text-amber-500" />
            <p className="mt-2 text-xs text-muted-foreground">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-7 gap-1 text-xs"
              onClick={refresh}
            >
              <RefreshCw className="size-3" /> Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (symbols && symbols.length === 0) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <OutlineHeader path={path} count={0} onRefresh={refresh} refreshing={loading} />
        <OutlineEmpty
          icon={<ListTree className="size-7 text-muted-foreground/40" />}
          title="No symbols found"
          body="This file doesn't declare any functions, classes, types, or exports the extractor recognizes."
        />
      </div>
    );
  }

        // Render: list

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <OutlineHeader
        path={path}
        count={symbols?.length ?? 0}
        onRefresh={refresh}
        refreshing={loading}
      />
      <ScrollArea className="min-h-0 flex-1">
        <ul className="py-1" role="list" aria-label="Symbols in this file">
          {symbols?.map((sym, i) => {
            const Icon = KIND_ICON[sym.kind] ?? SquareFunction;
            const label =
              sym.kind === "export" && sym.exportName
                ? `export ${sym.exportName}`
                : sym.name;
            return (
              <li key={`${sym.line}-${sym.kind}-${i}`}>
                <button
                  type="button"
                  onClick={() => handleSymbolClick(sym.line)}
                  className={cn(
                    "group flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors",
                    "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                  )}
                  title={`${KIND_LABEL[sym.kind]} • line ${sym.line}`}
                  aria-label={`${KIND_LABEL[sym.kind]} ${sym.name} — line ${sym.line}`}
                >
                  <Icon className="size-3.5 shrink-0 text-brand" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                    {label}
                  </span>
                  {sym.params && (
                    <span className="hidden shrink-0 truncate font-mono text-[10px] text-muted-foreground/70 sm:inline max-w-[120px]">
                      {sym.params}
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                    {sym.line}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Sub-components
 * -------------------------------------------------------------------------- */

function OutlineHeader({
  path,
  count,
  onRefresh,
  refreshing,
}: {
  path: string;
  count: number | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const name = path.split("/").pop() ?? path;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <ListTree className="size-3.5 shrink-0 text-brand" />
        <span className="truncate font-mono text-xs" title={path}>
          {name}
        </span>
        {count !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="size-6 shrink-0 p-0"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh symbols"
      >
        {refreshing ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
      </Button>
    </div>
  );
}

function OutlineEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <div className="mx-auto flex size-9 items-center justify-center">{icon}</div>
        <p className="mt-2 text-xs font-medium">{title}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function OutlineSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <div className="size-3.5 shrink-0 rounded bg-muted/60 animate-pulse" />
        <div className="h-3 w-24 shrink-0 rounded bg-muted/60 animate-pulse" />
        <div className="ml-auto size-3 shrink-0 rounded bg-muted/60 animate-pulse" />
      </div>
      <div className="flex-1 space-y-1 p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1">
            <div className="size-3.5 shrink-0 rounded bg-muted/60 animate-pulse" />
            <div
              className="h-3 shrink-0 rounded bg-muted/60 animate-pulse"
              style={{ width: `${60 + ((i * 17) % 80)}px` }}
            />
            <div className="ml-auto h-2.5 w-6 shrink-0 rounded bg-muted/40 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

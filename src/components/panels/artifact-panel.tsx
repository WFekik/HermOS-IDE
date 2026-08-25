"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  Copy,
  Check,
  Sparkles,
  RefreshCw,
  Info,
  AlertCircle,
  AlertTriangle,
  ShieldAlert,
  Lightbulb,
  FileCode,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api-client";
import { CodeBlock } from "@/components/ide/code-block";
import { preprocessContent } from "@/components/ide/message-renderer";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface ArtifactPanelProps {
  activeArtifactPath?: string;
}

function AlertBlockquote({ children }: { children: React.ReactNode }) {
  const text = React.Children.toArray(children)
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (c?.props?.children) {
        if (Array.isArray(c.props.children)) {
          return c.props.children.map((child: any) => (typeof child === "string" ? child : "")).join("");
        }
        return String(c.props.children);
      }
      return "";
    })
    .join("");

  const match = text.match(/^\[\!(NOTE|IMPORTANT|WARNING|CAUTION|TIP)\]/i);
  if (match) {
    const alertType = match[1].toUpperCase();
    const config: Record<string, { border: string; icon: React.ElementType; title: string }> = {
      NOTE: { border: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300", icon: Info, title: "Note" },
      IMPORTANT: { border: "border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300", icon: AlertCircle, title: "Important" },
      WARNING: { border: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", icon: AlertTriangle, title: "Warning" },
      CAUTION: { border: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300", icon: ShieldAlert, title: "Caution" },
      TIP: { border: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", icon: Lightbulb, title: "Tip" },
    };
    const current = config[alertType] ?? { border: "border-border bg-muted/30 text-foreground", icon: Info, title: "Note" };
    const Icon = current.icon;
    return (
      <div className={cn("my-3 rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed", current.border)}>
        <div className="flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-wide mb-1">
          <Icon className="size-3.5 shrink-0" />
          <span>{current.title}</span>
        </div>
        <div>{children}</div>
      </div>
    );
  }

  return (
    <blockquote className="my-3 border-l-2 border-brand/40 pl-3 text-muted-foreground italic text-xs leading-relaxed">
      {children}
    </blockquote>
  );
}

const artifactMarkdownComponents: Components = {
  code(props) {
    const { className, children, ...rest } = props;
    const text = String(children ?? "").replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      return <CodeBlock language={match[1]} value={text} />;
    }
    if (text.includes("\n")) {
      return <CodeBlock language="text" value={text} />;
    }
    return (
      <code
        className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[12px] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  blockquote({ children }) {
    return <AlertBlockquote>{children}</AlertBlockquote>;
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-md border">
        <table className="w-full text-xs">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-muted/50">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="border-b px-3 py-1.5 text-left font-semibold text-foreground">{children}</th>
    );
  },
  td({ children }) {
    return <td className="border-b px-3 py-1.5 text-foreground/90">{children}</td>;
  },
  h1({ children }) {
    return <h1 className="mt-4 mb-2 text-base font-bold tracking-tight text-foreground border-b pb-1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mt-4 mb-2 text-sm font-semibold tracking-tight text-foreground">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mt-3 mb-1.5 text-xs font-semibold text-foreground">{children}</h3>;
  },
  p({ children }) {
    return <p className="my-2 leading-relaxed text-xs text-foreground/90">{children}</p>;
  },
  ul({ children }) {
    return <ul className="my-2 list-disc pl-5 space-y-1 text-xs">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal pl-5 space-y-1 text-xs">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  img(props) {
    const { src: rawSrc, alt, ...rest } = props;
    if (!rawSrc || typeof rawSrc !== "string") return null;
    const src: string = rawSrc;

    let resolvedSrc = src;
    if (src.startsWith("file:///")) {
      const cleanPath = src.replace(/^file:\/\/\//i, "");
      resolvedSrc = `/api/workspace/file?path=${encodeURIComponent(cleanPath)}&raw=true`;
    } else if (src.startsWith("file://")) {
      const cleanPath = src.replace(/^file:\/\//i, "");
      resolvedSrc = `/api/workspace/file?path=${encodeURIComponent(cleanPath)}&raw=true`;
    } else if (!src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("data:") && !src.startsWith("blob:")) {
      resolvedSrc = `/api/workspace/file?path=${encodeURIComponent(src)}&raw=true`;
    }

    return (
      <figure className="my-4 flex flex-col items-center justify-center">
        <img
          src={resolvedSrc}
          alt={alt || "Artifact image"}
          className="max-w-full rounded-lg border bg-card shadow-xs object-contain max-h-[500px]"
          loading="lazy"
          {...rest}
        />
        {alt && (
          <figcaption className="mt-1.5 text-center text-[11px] text-muted-foreground italic font-mono">
            {alt}
          </figcaption>
        )}
      </figure>
    );
  },
  hr() {
    return <hr className="my-4 border-border" />;
  },
};

export function ArtifactPanel({ activeArtifactPath: propArtifactPath }: ArtifactPanelProps) {
  const storeActivePath = useAppStore((s) => s.activeArtifactPath);
  const storeArtifacts = useAppStore((s) => s.artifactsList);
  const setActiveArtifactPath = useAppStore((s) => s.setActiveArtifactPath);
  const addArtifact = useAppStore((s) => s.addArtifact);
  const removeArtifact = useAppStore((s) => s.removeArtifact);

  const [content, setContent] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(false);
  const [copied, setCopied] = React.useState<boolean>(false);
  const [artifactPath, setArtifactPathState] = React.useState<string>(
    propArtifactPath || storeActivePath || ""
  );

  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);

  const setArtifactPath = React.useCallback(
    (path: string) => {
      setArtifactPathState(path);
      setActiveArtifactPath(path);
    },
    [setActiveArtifactPath]
  );

  // Sync active path from store or props when user clicks an artifact in chat
  React.useEffect(() => {
    const target = propArtifactPath || storeActivePath;
    if (target && target !== artifactPath) {
      setArtifactPathState(target);
    }
  }, [propArtifactPath, storeActivePath]);

  const rawList = [
    ...(artifactPath ? [artifactPath] : []),
    ...storeArtifacts,
  ];

  const seenKeys = new Set<string>();
  const displayTabs: string[] = [];
  for (const p of rawList) {
    const key = p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || p;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      displayTabs.push(p);
    }
  }

  const handleCloseTab = React.useCallback(
    (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      removeArtifact(path);
      if (artifactPath === path) {
        const remaining = displayTabs.filter((p) => p !== path);
        if (remaining.length > 0) {
          setArtifactPath(remaining[0]);
        } else {
          setArtifactPath("");
          setRightPanelOpen(false);
        }
      }
    },
    [removeArtifact, artifactPath, setArtifactPath, displayTabs, setRightPanelOpen]
  );

  const loadArtifact = React.useCallback(async () => {
    if (!artifactPath) {
      setContent("");
      return;
    }
    setLoading(true);
    try {
      const cleanPath = artifactPath.startsWith("file://")
        ? (() => {
            try {
              return decodeURIComponent(new URL(artifactPath).pathname).replace(/^\/([A-Z]:)/i, "$1");
            } catch {
              return artifactPath.replace(/^file:\/\//i, "").replace(/^\/([A-Z]:)/i, "$1");
            }
          })()
        : artifactPath;
      const encodedPath = encodeURIComponent(cleanPath);
      const res = await apiGet<{ content?: string }>(`/api/workspace/file?path=${encodedPath}`);
      if (res?.content) {
        setContent(res.content);
      } else {
        const filename = cleanPath.replace(/\\/g, "/").split("/").pop() || cleanPath;
        const fallbackRes = await apiGet<{ content?: string }>(`/api/workspace/file?path=${encodeURIComponent(filename)}`);
        setContent(fallbackRes?.content ?? "# Artifact Content\n\nNo content available.");
      }
    } catch {
      const filename = artifactPath.replace(/\\/g, "/").split("/").pop() || "Artifact";
      setContent(`# ${filename}\n\n*Unable to load artifact content.*`);
    } finally {
      setLoading(false);
    }
  }, [artifactPath]);

  React.useEffect(() => {
    void loadArtifact();
  }, [loadArtifact]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success("Artifact copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const activeFileName = artifactPath ? artifactPath.replace(/\\/g, "/").split("/").pop() : "Artifact Canvas";

  const [viewMode, setViewMode] = React.useState<"markdown" | "preview" | "code">("markdown");

  const isHtmlOrSvg = React.useMemo(() => {
    if (!artifactPath) return false;
    const lower = artifactPath.toLowerCase();
    return lower.endsWith(".html") || lower.endsWith(".svg") || (content && (content.includes("<!DOCTYPE html>") || content.includes("<svg")));
  }, [artifactPath, content]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Panel Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 bg-muted/20">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="size-3.5 text-brand shrink-0" />
          <span className="font-semibold text-xs text-foreground truncate font-mono">
            {activeFileName}
          </span>
          {artifactPath && (
            <Badge variant="outline" className="h-4 text-[10px] font-mono border-brand/30 text-brand bg-brand/5 shrink-0">
              Artifact
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {content && (
            <div className="flex items-center rounded-md border bg-background p-0.5 text-[11px] mr-1">
              <button
                type="button"
                onClick={() => setViewMode("markdown")}
                className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors", viewMode === "markdown" ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}
                title="Markdown View"
              >
                Docs
              </button>
              {isHtmlOrSvg && (
                <button
                  type="button"
                  onClick={() => setViewMode("preview")}
                  className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors", viewMode === "preview" ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}
                  title="Live HTML/SVG Preview"
                >
                  Preview
                </button>
              )}
              <button
                type="button"
                onClick={() => setViewMode("code")}
                className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors", viewMode === "code" ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}
                title="Raw Code View"
              >
                Code
              </button>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => void loadArtifact()}
            disabled={loading || !artifactPath}
            title="Refresh Artifact"
            aria-label="Refresh Artifact"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={handleCopy}
            disabled={!content}
            title="Copy Artifact Content"
            aria-label="Copy Artifact Content"
          >
            {copied ? <Check className="size-3 text-brand" /> : <Copy className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            onClick={(e) => handleCloseTab(artifactPath || displayTabs[0] || "", e)}
            title="Close Artifact Canvas"
            aria-label="Close Artifact Canvas"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Artifact File Selection Tabs */}
      {displayTabs.length > 1 && (
        <div className="flex items-center border-b px-2 py-1 gap-1 overflow-x-auto bg-card shrink-0">
          {displayTabs.map((path) => (
            <div
              key={path}
              className={cn(
                "group flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-mono shrink-0 transition-colors border cursor-pointer select-none",
                artifactPath === path
                  ? "bg-brand/10 border-brand/40 text-brand font-medium"
                  : "border-transparent text-muted-foreground hover:bg-accent/60"
              )}
              onClick={() => setArtifactPath(path)}
            >
              <FileCode className="size-3 shrink-0" />
              <span className="truncate max-w-[140px]">{path.split("/").pop()}</span>
              <button
                type="button"
                onClick={(e) => handleCloseTab(path, e)}
                className="rounded p-0.5 opacity-60 hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity ml-0.5"
                title="Close Artifact Tab"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* View Content */}
      {content ? (
        viewMode === "preview" ? (
          <div className="flex-1 w-full h-full bg-white relative overflow-hidden">
            <iframe
              srcDoc={content}
              title={activeFileName}
              className="w-full h-full border-0"
              sandbox="allow-scripts"
            />
          </div>
        ) : viewMode === "code" ? (
          <div className="flex-1 p-3 overflow-y-auto">
            <CodeBlock
              language={artifactPath.split(".").pop() || "text"}
              value={content}
            />
          </div>
        ) : (
          <ScrollArea className="flex-1 p-4">
            <article className="max-w-none text-xs leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={artifactMarkdownComponents}
              >
                {preprocessContent(content)}
              </ReactMarkdown>
            </article>
          </ScrollArea>
        )
      ) : (
        <div className="flex flex-col items-center justify-center flex-1 min-h-[300px] text-center p-8 space-y-3 my-auto">
          <div className="rounded-full bg-brand/10 p-3 text-brand border border-brand/20">
            <Sparkles className="size-6" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">No Artifacts Selected</h3>
          <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
            Select an artifact from the conversation or list to view its rendered implementation plan, code, or live preview.
          </p>
        </div>
      )}
    </div>
  );
}


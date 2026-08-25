"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Plug, Trash2, ChevronDown, Loader2, Server, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { McpServerDTO, McpTransport, CreateMcpServerRequest } from "@/lib/types";

const POPULAR: { name: string; transport: McpTransport; command: string; args: string[]; description: string }[] = [
  { name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], description: "Read/write local files" },
  { name: "GitHub", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], description: "Issues, PRs, search" },
  { name: "Fetch", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"], description: "HTTP fetch as markdown" },
  { name: "Memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], description: "Persistent knowledge graph" },
  { name: "SQLite", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite"], description: "Query local SQLite" },
  { name: "Slack", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], description: "Slack messages & channels" },
  { name: "Postgres", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], description: "Read-only Postgres" },
];

export function McpPanel() {
  const servers = useAppStore((s) => s.mcpServers);
  const create = useAppStore((s) => s.createMcpServer);
  const connect = useAppStore((s) => s.connectMcpServer);
  const disconnect = useAppStore((s) => s.disconnectMcpServer);
  const remove = useAppStore((s) => s.deleteMcpServer);

  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  const existingNames = React.useMemo(
    () => new Set(
      servers.map((s) => s.name.trim().toLowerCase()),
    ),
    [servers],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-brand" />
          <span className="text-sm font-medium">MCP Servers</span>
          <Badge variant="secondary" className="text-[10px]">{servers.length}</Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-2">
          {servers.length === 0 ? (
            <EmptyMcp onAdd={() => setAddOpen(true)} />
          ) : (
            <AnimatePresence initial={false}>
              {servers.map((s) => (
                <ServerRow
                  key={s.id}
                  server={s}
                  onConnect={() => connect(s.id)}
                  onDisconnect={() => disconnect(s.id)}
                  onDelete={() => setDeleteId(s.id)}
                />
              ))}
            </AnimatePresence>
          )}

          {servers.length > 0 && (
            <>
              <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Popular MCP servers
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {POPULAR.map((p) => {
                  const alreadyExists = existingNames.has(p.name.toLowerCase());
                  return (
                    <button
                      key={p.name}
                      type="button"
                      disabled={alreadyExists}
                      title={alreadyExists ? "Already in your servers" : undefined}
                      onClick={async () => {
                        const req: CreateMcpServerRequest = {
                          name: p.name,
                          transport: p.transport,
                          command: p.command,
                          args: p.args,
                        };
                        const created = await create(req);
                        if (created) {
                          toast.success(`${p.name} added`);
                          await connect(created.id);
                          toast.success(`${p.name} connected`);
                        }
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-xs transition-all",
                        alreadyExists
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:border-brand/40 hover:bg-accent/50",
                      )}
                    >
                      <Zap className="size-3.5 text-brand shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{p.name}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {alreadyExists ? "Already in your servers" : p.description}
                        </div>
                      </div>
                      {alreadyExists ? (
                        <span className="text-[10px] text-muted-foreground">added</span>
                      ) : (
                        <Plus className="size-3 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreate={async (req) => {
          const created = await create(req);
          if (created) {
            toast.success("MCP server added");
            await connect(created.id);
            setAddOpen(false);
          }
        }}
      />

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the server configuration. Tools provided by this server will no longer be available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteId) return;
                await remove(deleteId);
                setDeleteId(null);
                toast.success("MCP server removed");
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyMcp({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <Plug className="size-8 text-muted-foreground/50 mx-auto mb-2" />
      <div className="text-sm font-medium">No MCP servers yet</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect tools via the Model Context Protocol — filesystem, GitHub, fetch, databases, and more.
      </p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onAdd}>
        <Plus className="size-3.5" /> Add server
      </Button>
    </div>
  );
}

function ServerRow({
  server,
  onConnect,
  onDisconnect,
  onDelete,
}: {
  server: McpServerDTO;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  const status = server.status;
  const statusColor =
    status === "connected"
      ? "bg-brand"
      : status === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.15 }}
      className="rounded-lg border bg-background overflow-hidden"
    >
      <Collapsible>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <span className={cn("size-2 rounded-full", statusColor)} />
          <Server className="size-3.5 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{server.name}</div>
            <div className="text-[10px] text-muted-foreground font-mono truncate">
              {server.transport} · {server.tools?.length ?? 0} tools
            </div>
          </div>
          {status === "connected" ? (
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onConnect}>
              Connect
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 hover:text-destructive"
            onClick={onDelete}
            aria-label="Remove"
          >
            <Trash2 className="size-3" />
          </Button>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="Expand">
              <ChevronDown className="size-3" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="border-t bg-muted/20 px-2.5 py-2 text-xs space-y-1.5">
            {server.lastError && status === "error" && (
              <div className="rounded bg-destructive/10 text-destructive px-2 py-1 text-[11px] font-mono">
                {server.lastError}
              </div>
            )}
            <div className="font-mono text-[10px] text-muted-foreground break-all">
              {server.transport === "stdio"
                ? `${server.command} ${(server.args ?? []).join(" ")}`
                : server.url}
            </div>
            {(server.tools?.length ?? 0) > 0 ? (
              <div className="space-y-1 pt-1">
                {server.tools!.map((t) => (
                  <div key={t.name} className="rounded border bg-background px-2 py-1">
                    <div className="font-mono text-[11px] text-foreground">{t.name}</div>
                    {t.description && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{t.description}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground italic">No tools registered</div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  );
}

function AddServerDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (req: CreateMcpServerRequest) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<McpTransport>("stdio");
  const [command, setCommand] = React.useState("");
  const [args, setArgs] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [headers, setHeaders] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName("");
      setTransport("stdio");
      setCommand("");
      setArgs("");
      setEnv("");
      setUrl("");
      setHeaders("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSubmitting(true);
    const req: CreateMcpServerRequest = {
      name: name.trim(),
      transport,
    };
    if (transport === "stdio") {
      if (!command.trim()) {
        toast.error("Command is required for stdio transport");
        setSubmitting(false);
        return;
      }
      req.command = command.trim();
      req.args = args.trim() ? args.trim().split(/\s+/) : [];
      if (env.trim()) {
        const envObj: Record<string, string> = {};
        env.trim().split("\n").forEach((line) => {
          const i = line.indexOf("=");
          if (i > 0) envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        if (Object.keys(envObj).length > 0) req.env = envObj;
      }
    } else {
      if (!url.trim()) {
        toast.error("URL is required for HTTP transports");
        setSubmitting(false);
        return;
      }
      req.url = url.trim();
      if (headers.trim()) {
        const h: Record<string, string> = {};
        headers.trim().split("\n").forEach((line) => {
          const i = line.indexOf(":");
          if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        if (Object.keys(h).length > 0) req.headers = h;
      }
    }
    try {
      await onCreate(req);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            Connect a Model Context Protocol server. Choose stdio for local processes, or HTTP transports for remote endpoints.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-mcp-server" />
          </div>
          <div className="grid gap-1.5">
            <Label>Transport</Label>
            <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {transport === "stdio" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-command">Command</Label>
                <Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-args">Args (space-separated)</Label>
                <Input id="mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-env">Env (KEY=value per line)</Label>
                <textarea
                  id="mcp-env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder={"API_KEY=abc123\nNODE_ENV=production"}
                  className="font-mono text-xs min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-url">URL</Label>
                <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-headers">Headers (Key: value per line)</Label>
                <textarea
                  id="mcp-headers"
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={"Authorization: Bearer xyz"}
                  className="font-mono text-xs min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Adding…
              </>
            ) : (
              "Add server"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

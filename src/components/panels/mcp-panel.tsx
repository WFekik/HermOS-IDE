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
import { useTranslation } from "@/hooks/use-translation";
import { tOr } from "@/lib/i18n";
import type { McpServerDTO, McpTransport, CreateMcpServerRequest } from "@/lib/types";

const POPULAR: { name: string; transport: McpTransport; command: string; args: string[]; descKey: string; description: string }[] = [
  { name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], descKey: "mcp_desc_filesystem", description: "Read/write local files" },
  { name: "GitHub", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], descKey: "mcp_desc_github", description: "Issues, PRs, search" },
  { name: "Fetch", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"], descKey: "mcp_desc_fetch", description: "HTTP fetch as markdown" },
  { name: "Memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], descKey: "mcp_desc_memory", description: "Persistent knowledge graph" },
  { name: "SQLite", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite"], descKey: "mcp_desc_sqlite", description: "Query local SQLite" },
  { name: "Slack", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], descKey: "mcp_desc_slack", description: "Slack messages & channels" },
  { name: "Postgres", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], descKey: "mcp_desc_postgres", description: "Read-only Postgres" },
];

export function McpPanel() {
  const { t, language } = useTranslation();
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
        <div className="flex items-center gap-2 min-w-0">
          <Plug className="size-4 text-brand shrink-0" />
          <span className="text-sm font-medium truncate"><bdi>{t("mcp_servers")}</bdi></span>
          <Badge variant="secondary" className="text-[10px] font-mono shrink-0">{servers.length}</Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> {t("add")}
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
              <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-start">
                <bdi>{t("popular_mcp_servers")}</bdi>
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {POPULAR.map((p) => {
                  const alreadyExists = existingNames.has(p.name.toLowerCase());
                  return (
                    <button
                      key={p.name}
                      type="button"
                      disabled={alreadyExists}
                      title={alreadyExists ? t("already_in_servers") : undefined}
                      onClick={async () => {
                        const req: CreateMcpServerRequest = {
                          name: p.name,
                          transport: p.transport,
                          command: p.command,
                          args: p.args,
                        };
                        const created = await create(req);
                        if (created) {
                          toast.success(t("server_added", { name: p.name }));
                          await connect(created.id);
                          toast.success(t("server_connected", { name: p.name }));
                        }
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-start text-xs transition-all",
                        alreadyExists
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:border-brand/40 hover:bg-accent/50",
                      )}
                    >
                      <Zap className="size-3.5 text-brand shrink-0" />
                      <div className="flex-1 min-w-0 text-start">
                        <div className="font-medium truncate"><bdi>{p.name}</bdi></div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          <bdi>{alreadyExists ? t("already_in_servers") : tOr(p.descKey, p.description, language)}</bdi>
                        </div>
                      </div>
                      {alreadyExists ? (
                        <span className="text-[10px] text-muted-foreground shrink-0">{t("added")}</span>
                      ) : (
                        <Plus className="size-3 text-muted-foreground shrink-0" />
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
            toast.success(t("server_added", { name: req.name }));
            await connect(created.id);
            setAddOpen(false);
          }
        }}
      />

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("remove_mcp_server_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("remove_mcp_server_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteId) return;
                await remove(deleteId);
                setDeleteId(null);
                toast.success(t("mcp_server_removed"));
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyMcp({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <Plug className="size-8 text-muted-foreground/50 mx-auto mb-2" />
      <div className="text-sm font-medium">{t("no_mcp_servers")}</div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("no_mcp_servers_desc")}
      </p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onAdd}>
        <Plus className="size-3.5" /> {t("add_server")}
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
  const { t } = useTranslation();
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
          <span className={cn("size-2 rounded-full shrink-0", statusColor)} />
          <Server className="size-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0 text-start">
            <div className="text-xs font-medium truncate"><bdi>{server.name}</bdi></div>
            <div className="text-[10px] text-muted-foreground font-mono truncate flex items-center gap-1">
              <span>{server.transport}</span>
              <span>·</span>
              <bdi>{t("count_tools", { count: server.tools?.length ?? 0 })}</bdi>
            </div>
          </div>
          {status === "connected" ? (
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onDisconnect}>
              {t("disconnect")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onConnect}>
              {t("connect")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 hover:text-destructive"
            onClick={onDelete}
            aria-label={t("delete")}
          >
            <Trash2 className="size-3" />
          </Button>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label={t("expand")}>
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
                {server.tools!.map((tTool) => (
                  <div key={tTool.name} className="rounded border bg-background px-2 py-1">
                    <div className="font-mono text-[11px] text-foreground">{tTool.name}</div>
                    {tTool.description && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{tTool.description}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground italic">{t("no_tools_registered")}</div>
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
  const { t } = useTranslation();
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
      toast.error(t("name_required"));
      return;
    }
    setSubmitting(true);
    const req: CreateMcpServerRequest = {
      name: name.trim(),
      transport,
    };
    if (transport === "stdio") {
      if (!command.trim()) {
        toast.error(t("command_required_stdio"));
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
        toast.error(t("url_required_http"));
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
          <DialogTitle>{t("add_mcp_server")}</DialogTitle>
          <DialogDescription>
            {t("add_mcp_server_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5 text-start">
            <Label htmlFor="mcp-name">{t("name_label")}</Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-mcp-server" dir="auto" />
          </div>
          <div className="grid gap-1.5 text-start">
            <Label>{t("transport_label")}</Label>
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
              <div className="grid gap-1.5 text-start">
                <Label htmlFor="mcp-command">{t("command")}</Label>
                <Input id="mcp-command" dir="ltr" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono text-xs text-start" />
              </div>
              <div className="grid gap-1.5 text-start">
                <Label htmlFor="mcp-args">{t("args_label")}</Label>
                <Input id="mcp-args" dir="ltr" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" className="font-mono text-xs text-start" />
              </div>
              <div className="grid gap-1.5 text-start">
                <Label htmlFor="mcp-env">{t("env_label")}</Label>
                <textarea
                  id="mcp-env"
                  dir="ltr"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder={"API_KEY=abc123\nNODE_ENV=production"}
                  className="font-mono text-xs min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 text-start"
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5 text-start">
                <Label htmlFor="mcp-url">{t("url_label")}</Label>
                <Input id="mcp-url" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className="font-mono text-xs text-start" />
              </div>
              <div className="grid gap-1.5 text-start">
                <Label htmlFor="mcp-headers">{t("headers_label")}</Label>
                <textarea
                  id="mcp-headers"
                  dir="ltr"
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={"Authorization: Bearer xyz"}
                  className="font-mono text-xs min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 text-start"
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> {t("adding")}
              </>
            ) : (
              t("add_server")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

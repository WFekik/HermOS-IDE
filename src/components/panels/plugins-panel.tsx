"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Puzzle, Plus, Trash2, Search, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import type { PluginDTO } from "@/lib/types";

export function PluginsPanel() {
  const plugins = useAppStore((s) => s.plugins);
  const install = useAppStore((s) => s.installPlugin);
  const toggle = useAppStore((s) => s.togglePlugin);
  const remove = useAppStore((s) => s.deletePlugin);

  const [query, setQuery] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return plugins;
    const q = query.toLowerCase();
    return plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q),
    );
  }, [plugins, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <Puzzle className="size-4 text-brand" />
          <span className="text-sm font-medium">Plugins</span>
          <Badge variant="secondary" className="text-[10px]">{plugins.length}</Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search plugins…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Installed
            </div>
            {filtered.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {query ? "No matches" : "No plugins installed. Use the Add button to install one from a URL or local manifest."}
              </div>
            ) : (
              <div className="space-y-1.5">
                {filtered.map((p) => (
                  <PluginRow
                    key={p.id}
                    plugin={p}
                    onToggle={(v) => toggle(p.id, v)}
                    onDelete={() => {
                      remove(p.id);
                      toast.success(`${p.name} removed`);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      <AddPluginDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreate={async (opts) => {
          const created = await install(opts);
          if (created) {
            toast.success(`${created.name} added`);
            setAddOpen(false);
          }
        }}
      />
    </div>
  );
}

function PluginRow({
  plugin,
  onToggle,
  onDelete,
}: {
  plugin: PluginDTO;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.15 }}
      className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5"
    >
      <Package className="size-3.5 text-brand shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{plugin.name}</span>
          <Badge variant="outline" className="text-[9px] h-3.5">{plugin.type}</Badge>
          <span className="text-[10px] text-muted-foreground font-mono">v{plugin.version}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {plugin.description || plugin.source}
        </div>
      </div>
      <Switch checked={plugin.enabled} onCheckedChange={onToggle} aria-label={`Toggle ${plugin.name}`} />
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 hover:text-destructive"
        onClick={onDelete}
        aria-label="Remove"
      >
        <Trash2 className="size-3" />
      </Button>
    </motion.div>
  );
}

function AddPluginDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (opts: {
    name: string;
    description: string;
    type: "plugin" | "skill";
    version: string;
    source: string;
    manifest?: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<"plugin" | "skill">("plugin");
  const [manifest, setManifest] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setType("plugin");
      setManifest("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    let parsedManifest: Record<string, unknown> | undefined;
    if (manifest.trim()) {
      try {
        parsedManifest = JSON.parse(manifest) as Record<string, unknown>;
      } catch {
        toast.error("Manifest JSON is invalid");
        return;
      }
    }
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        type,
        version: "1.0.0",
        source: "local",
        manifest: parsedManifest,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add plugin</DialogTitle>
          <DialogDescription>
            Register a local plugin or skill. Provide a name and optional manifest JSON.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="plug-name">Name</Label>
            <Input id="plug-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-plugin" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plug-desc">Description</Label>
            <Input id="plug-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does" />
          </div>
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as "plugin" | "skill")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plugin">plugin</SelectItem>
                <SelectItem value="skill">skill</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plug-manifest">Manifest JSON (optional)</Label>
            <textarea
              id="plug-manifest"
              value={manifest}
              onChange={(e) => setManifest(e.target.value)}
              placeholder={'{\n  "version": "1.0.0",\n  "commands": []\n}'}
              className="font-mono text-xs min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import pkg from "../../../package.json";
import * as React from "react";
import { motion } from "framer-motion";
import {
  KeyRound,
  Palette,
  Bot,
  Plug,
  Puzzle,
  ShieldCheck,
  Info,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Lock,
  UserCog,
  BarChart3,
  SlidersHorizontal,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENT_MODES } from "@/lib/agent-modes";
import { useAppStore, DEFAULT_SYSTEM_PROMPT } from "@/stores/app-store";
import { useTheme } from "@/components/theme/theme-provider";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { AgentMode, ProviderId } from "@/lib/types";
import { PermissionsSettings } from "@/components/settings/permissions-settings";
import { UsageSettings } from "@/components/settings/usage-settings";
import { DEFAULT_CONTEXT_CONFIG } from "@/lib/ai/context";
import { openExternalUrl } from "@/lib/open-external";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tab: string;
  onTabChange: (t: string) => void;
}

const TABS: { value: string; label: string; icon: React.ElementType }[] = [
  { value: "providers", label: "Providers", icon: KeyRound },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "agent", label: "Agent", icon: Bot },
  { value: "mcp", label: "MCP", icon: Plug },
  { value: "plugins", label: "Plugins", icon: Puzzle },
  { value: "security", label: "Security", icon: ShieldCheck },
  { value: "permissions", label: "Permissions", icon: UserCog },
  { value: "usage", label: "Usage", icon: BarChart3 },
  { value: "context", label: "Context", icon: SlidersHorizontal },
  { value: "about", label: "About", icon: Info },
];

// The Providers tab is the heaviest tab (per-provider key forms, model
// lists, custom-provider form) — code-split it so the dialog shell paints
// instantly and the chunk streams in behind a skeleton. React.lazy caches
// the module, so after the first open (or the idle prefetch in ide-shell)
// subsequent opens are instant.
const ProvidersTab = React.lazy(() =>
  import("@/components/settings/tabs/providers-tab").then((m) => ({ default: m.ProvidersTab })),
);

/** Skeleton shown while a lazy tab chunk loads. */
function TabSkeleton() {
  return (
    <div className="p-4 sm:p-6 space-y-4" aria-busy="true">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-40 rounded-md" />
      </div>
      <div className="grid gap-2.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, tab, onTabChange }: SettingsDialogProps) {
  // Non-blocking tab switch: the shell stays interactive while a lazy tab
  // chunk (providers) loads behind its skeleton.
  const switchTab = (t: string) => React.startTransition(() => onTabChange(t));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">Settings</DialogTitle>
      <DialogContent className="sm:max-w-4xl h-[85vh] p-0 flex overflow-hidden" showCloseButton>
        <aside className="w-44 sm:w-52 border-r bg-muted/30 p-2 hidden sm:block shrink-0">
          <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </div>
          <nav className="space-y-0.5">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => switchTab(t.value)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  tab === t.value
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="flex-1 min-w-0 flex flex-col">
          {/* mobile tab select */}
          <div className="sm:hidden border-b px-3 py-2 overflow-x-auto">
            <div className="flex gap-1">
              {TABS.map((t) => (
                <Button
                  key={t.value}
                  variant={tab === t.value ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => switchTab(t.value)}
                >
                  <t.icon className="size-3" />
                  {t.label}
                </Button>
              ))}
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <React.Suspense fallback={<TabSkeleton />}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                className="p-4 sm:p-6 min-w-0"
              >
                {tab === "providers" && <ProvidersTab />}
                {tab === "appearance" && <AppearanceTab />}
                {tab === "agent" && <AgentTab />}
                {tab === "mcp" && <RedirectTab label="MCP servers" hint="Open the MCP tab in the right panel to manage servers." tab="mcp" />}
                {tab === "plugins" && <RedirectTab label="Plugins & skills" hint="Open the Plugins tab in the right panel to manage plugins." tab="plugins" />}
                {tab === "security" && <SecurityTab />}
                {tab === "permissions" && <PermissionsSettings />}
                {tab === "usage" && <UsageSettings />}
                {tab === "context" && <ContextTab />}
                {tab === "about" && <AboutTab />}
              </motion.div>
            </React.Suspense>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RedirectTab({ label, hint, tab }: { label: string; hint: string; tab: string }) {
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  return (
    <div className="max-w-md">
      <h3 className="text-base font-semibold mb-1">{label}</h3>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => {
          setRightPanelTab(tab as "mcp" | "plugins" | "skills" | "terminal");
          setSettingsOpen(false);
        }}
      >
        Open {label}
      </Button>
    </div>
  );
}


/* ----------------------------- Appearance ----------------------------- */
function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const density = useAppStore((s) => s.density);
  const fontSize = useAppStore((s) => s.fontSize);
  const setDensity = useAppStore((s) => s.setDensity);
  const setFontSize = useAppStore((s) => s.setFontSize);
  return (
    <div className="space-y-5 max-w-md">
      <div>
        <h3 className="text-base font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground mt-0.5">Theme, density, and typography.</p>
      </div>

      <div>
        <Label className="text-sm">Theme</Label>
        <RadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v)}
          className="grid grid-cols-3 gap-2 mt-2"
        >
          {(["light", "dark", "system"] as const).map((t) => (
            <Label
              key={t}
              htmlFor={`theme-${t}`}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-md border p-3 cursor-pointer text-xs capitalize hover:bg-accent/50 transition-colors",
                theme === t && "border-brand bg-brand/[0.05]",
              )}
            >
              <RadioGroupItem id={`theme-${t}`} value={t} className="sr-only" />
              <ThemeSwatch theme={t} />
              {t}
            </Label>
          ))}
        </RadioGroup>
      </div>

      <Separator />

      <DensityRow density={density} setDensity={setDensity} />

      <Separator />

      <div>
        <Label className="text-sm">Font size</Label>
        <FontSizeSlider fontSize={fontSize} setFontSize={setFontSize} />
        <p className="text-[11px] text-muted-foreground mt-1">
          Affects UI text scale. Code blocks remain at a fixed size for legibility.
        </p>
      </div>
    </div>
  );
}

function ThemeSwatch({ theme }: { theme: "light" | "dark" | "system" }) {
  return (
    <div className="size-8 rounded-md border overflow-hidden">
      {theme === "light" && <div className="size-full bg-white" />}
      {theme === "dark" && <div className="size-full bg-zinc-900" />}
      {theme === "system" && (
        <div className="size-full grid grid-cols-2">
          <div className="bg-white" />
          <div className="bg-zinc-900" />
        </div>
      )}
    </div>
  );
}

function DensityRow({ density, setDensity }: { density: "comfortable" | "compact"; setDensity: (d: "comfortable" | "compact") => void }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <Label className="text-sm">Density</Label>
        <p className="text-[11px] text-muted-foreground">Compact reduces paddings in lists.</p>
      </div>
      <ToggleGroup
        type="single"
        value={density}
        onValueChange={(v) => {
          if (v === "comfortable" || v === "compact") setDensity(v);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="comfortable" className="text-xs px-3">
          Comfortable
        </ToggleGroupItem>
        <ToggleGroupItem value="compact" className="text-xs px-3">
          Compact
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

function FontSizeSlider({ fontSize, setFontSize }: { fontSize: number; setFontSize: (s: number) => void }) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <span className="text-[11px] font-mono text-muted-foreground">12</span>
      <Slider min={12} max={18} step={1} value={[fontSize]} onValueChange={(v) => setFontSize(v[0] ?? 14)} className="flex-1" />
      <span className="text-[11px] font-mono text-muted-foreground">18</span>
      <span className="text-xs font-mono w-8 text-right">{fontSize}px</span>
    </div>
  );
}

/* ----------------------------- Agent ----------------------------- */
function AgentTab() {
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const composerMode = useAppStore((s) => s.composerMode);
  const setComposerMode = useAppStore((s) => s.setComposerMode);
  const systemPrompt = useAppStore((s) => s.systemPrompt);
  const setSystemPrompt = useAppStore((s) => s.setSystemPrompt);
  const applyChatModelSelection = useAppStore((s) => s.applyChatModelSelection);
  const providers = useAppStore((s) => s.providers);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const enabledTools = useAppStore((s) => s.enabledTools);
  const setEnabledTools = useAppStore((s) => s.setEnabledTools);

  const allTools = React.useMemo(() => {
    return mcpServers.flatMap((s) => s.tools?.map((t) => ({ ...t, server: s.name })) ?? []);
  }, [mcpServers]);

  const currentModels = React.useMemo(() => {
    return providers.find((p) => p.id === selectedProvider)?.models ?? [];
  }, [providers, selectedProvider]);

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold">Agent Configuration</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure default provider, model, mode, system prompt, and tool access.
        </p>
      </div>

      <div className="rounded-md border border-brand/30 bg-brand/[0.03] p-3 text-xs space-y-1">
        <div className="font-semibold text-brand flex items-center gap-1.5">
          <Bot className="size-3.5" /> Auto-driven Context & Rules
        </div>
        <p className="text-muted-foreground">
          System prompt is dynamically assembled per turn: <strong>Agent Persona</strong> + <strong>System Prompt</strong> + <strong>Workspace Rules</strong> (auto-driven from <code className="font-mono text-foreground">AGENTS.md</code> & <code className="font-mono text-foreground">.agents/rules</code> in workspace root).
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Default provider</Label>
          <Select
            value={selectedProvider}
            onValueChange={(v) => {
              const newProv = v as ProviderId;
              const provModels = providers.find((p) => p.id === newProv)?.models ?? [];
              const newModel = provModels.length > 0 ? provModels[0].id : selectedModel;
              void applyChatModelSelection(newProv, newModel);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Default model</Label>
          <Select
            value={selectedModel}
            onValueChange={(v) => void applyChatModelSelection(selectedProvider, v)}
          >
            <SelectTrigger className="w-full font-mono text-xs">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {currentModels.map((m) => (
                <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">Default mode</Label>
        <ToggleGroup
          type="single"
          value={composerMode}
          onValueChange={(v) => {
            if (v) setComposerMode(v as AgentMode);
          }}
          variant="outline"
          size="sm"
          className="w-fit"
        >
          {AGENT_MODES.map((m) => {
            const Icon = m.icon;
            return (
              <ToggleGroupItem
                key={m.value}
                value={m.value}
                className="text-xs gap-1.5 px-3 h-8"
              >
                <Icon className="size-3.5 text-muted-foreground" />
                {m.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="sysprompt" className="text-xs">System prompt instructions</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] gap-1"
            onClick={() => {
              setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
              toast.success("System prompt reset to default");
            }}
          >
            <RotateCcw className="size-3" /> Reset to default
          </Button>
        </div>
        <Textarea
          id="sysprompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          className="min-h-[100px] text-xs font-mono"
        />
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">Enabled tools</Label>
        {allTools.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No MCP tools available. Connect a server to expose tools.
          </p>
        ) : (
          <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
            {allTools.map((t) => {
              const checked = enabledTools.includes(t.name);
              return (
                <Label
                  key={t.name + t.server}
                  htmlFor={`tool-${t.name}`}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent/40 cursor-pointer"
                >
                  <Switch
                    id={`tool-${t.name}`}
                    checked={checked}
                    onCheckedChange={(v) => {
                      if (v) setEnabledTools([...enabledTools, t.name]);
                      else setEnabledTools(enabledTools.filter((x) => x !== t.name));
                    }}
                  />
                  <span className="font-mono">{t.name}</span>
                  <span className="text-[10px] text-muted-foreground">via {t.server}</span>
                </Label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Security & Privacy ----------------------------- */
function SecurityTab() {
  const sec = useAppStore((s) => s.securitySettings);
  const setSec = useAppStore((s) => s.setSecuritySettings);
  const [rotateOpen, setRotateOpen] = React.useState(false);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-base font-semibold">Security & Privacy Guardrails</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pre-flight credential scrubbing, enforced server-side on the agent executor before any payload leaves the IDE.
        </p>
      </div>

      {/* Pillar 2: Pre-flight Secret & Credential Redaction */}
      <div className="rounded-xl border p-4 space-y-4 bg-card">
        <div className="flex items-center gap-2 border-b pb-2">
          <Lock className="size-4 text-brand" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-brand">Secret Scrubbing & Pre-Flight Redaction</h4>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="text-xs font-medium cursor-pointer" htmlFor="autoScrubSecrets">
              Auto-Scrub API Keys & Credentials
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Redacts API keys (<code className="font-mono text-foreground">sk-...</code>, <code className="font-mono text-foreground">ghp_...</code>), private keys, database connection URIs, and JWTs before LLM payloads hit the network. Applied to the conversation history, system prompts, subagents, and context compaction on the server.
            </p>
          </div>
          <Switch
            id="autoScrubSecrets"
            checked={sec.autoScrubSecrets}
            onCheckedChange={(v) => {
              setSec({ autoScrubSecrets: v });
              toast.success(v ? "Pre-flight secret scrubbing enabled" : "Secret scrubbing disabled");
            }}
          />
        </div>

        <div className="grid gap-1.5 pt-1">
          <Label className="text-xs">Custom Redaction Regex Pattern (optional)</Label>
          <Input
            placeholder="e.g. COMPANY_TOKEN_[A-Z0-9]+"
            value={sec.customRedactionRegex}
            onChange={(e) => setSec({ customRedactionRegex: e.target.value })}
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            Matching text in prompt context is replaced with <code className="font-mono text-foreground">[REDACTED_CUSTOM_SECRET]</code>. Invalid expressions are rejected before being saved.
          </p>
        </div>
      </div>

      {/* Pillar 4: Destructive Action Safety & Encryption */}
      <div className="rounded-xl border p-4 space-y-4 bg-card">
        <div className="flex items-center gap-2 border-b pb-2">
          <ShieldCheck className="size-4 text-brand" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-brand">Destructive Action Safety & Encryption</h4>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-medium">Auto-Checkpoint Before Destructive Actions</div>
            <p className="text-[11px] text-muted-foreground">
              A workspace snapshot is always created before batch/multi-file modifications, so destructive changes can be rolled back.
            </p>
          </div>
          <Badge variant="outline" className="text-[11px] px-2 py-0.5">
            Always on
          </Badge>
        </div>

        <div className="pt-2 border-t flex items-center justify-between">
          <div>
            <div className="text-xs font-medium">Master Key Encryption (AES-256-GCM)</div>
            <div className="text-[11px] text-muted-foreground">Keys stored at rest are encrypted with server-side environment key.</div>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setRotateOpen(true)}>
            <RefreshCw className="size-3" /> Rotate Master Key
          </Button>
        </div>

        {rotateOpen && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-1">
            <p className="font-medium text-amber-600 dark:text-amber-400">Server Key Rotation Instructions:</p>
            <p className="text-muted-foreground text-[11px]">
              Update <code className="font-mono text-foreground">ENCRYPTION_KEY</code> in environment variables, then run:
            </p>
            <pre className="font-mono text-[11px] bg-muted/60 p-1.5 rounded">bun run scripts/rotate-keys.ts</pre>
            <Button size="sm" variant="ghost" className="h-6 text-[11px] mt-1" onClick={() => setRotateOpen(false)}>
              Close
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- About ----------------------------- */
function AboutTab() {
  const [checkingUpdate, setCheckingUpdate] = React.useState(false);
  const [appInfo, setAppInfo] = React.useState<{
    version: string;
    channel: string;
    buildHash: string;
    repoUrl: string;
  } | null>(null);

  React.useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((data) => {
        if (data?.version) {
          setAppInfo({
            version: data.version,
            channel: data.channel || "stable",
            buildHash: data.buildHash || "local",
            repoUrl: data.repoUrl || "https://github.com/WFekik/HermOS-IDE",
          });
        }
      })
      .catch(() => {
        /* fallback to bundled pkg */
      });
  }, []);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const { checkForUpdates } = await import("@/lib/updater");
      const res = await checkForUpdates(false);
      if (res.status === "up-to-date") {
        toast.success(`HermOS IDE is up to date (v${res.currentVersion}).`);
      } else if (res.status === "available") {
        toast.info(`New version v${res.latestVersion} is available!`, {
          id: "app-update-available",
          duration: 20000,
          action: res.releaseUrl
            ? {
                label: "View Release",
                onClick: () => openExternalUrl(res.releaseUrl!),
              }
            : {
                label: "Update Now",
                onClick: () => {
                  checkForUpdates(true);
                },
              },
        });
      } else if (res.status === "error") {
        toast.error(`Update check failed: ${res.message}`);
      }
    } catch (e) {
      toast.error("Failed to check for updates");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const displayVersion = appInfo?.version ?? (pkg as any).version ?? "1.0.0";
  const displayChannel = appInfo?.channel ?? "stable";
  const displayHash = appInfo?.buildHash ?? "local";
  const repoUrl = appInfo?.repoUrl ?? "https://github.com/WFekik/HermOS-IDE";

  return (
    <div className="space-y-5 max-w-md">
      <div>
        <h3 className="text-base font-semibold">About HermOS</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Enterprise-grade local-first agentic IDE. MIT licensed.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border p-2.5 space-y-1">
          <div className="text-muted-foreground flex items-center justify-between">
            <span>Version</span>
            <Badge variant="outline" className="text-[10px] uppercase font-mono px-1 py-0 h-4">
              {displayChannel}
            </Badge>
          </div>
          <div className="font-mono font-medium text-sm">v{displayVersion}</div>
          {displayHash !== "local" && (
            <div className="text-[10px] text-muted-foreground font-mono">commit: {displayHash}</div>
          )}
        </div>
        <div className="rounded-md border p-2.5 space-y-1">
          <div className="text-muted-foreground">License</div>
          <div className="font-mono font-medium text-sm">MIT</div>
          <div className="text-[10px] text-muted-foreground">Open-Source</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={handleCheckUpdate}
          disabled={checkingUpdate}
        >
          <RefreshCw className={cn("size-3.5", checkingUpdate && "animate-spin")} />
          {checkingUpdate ? "Checking updates..." : "Check for updates"}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 pt-1">
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(repoUrl);
          }}
          className="text-sm text-brand hover:underline inline-flex items-center gap-1.5 cursor-pointer"
        >
          <ExternalLink className="size-3.5" /> Source on GitHub
        </a>
        <a
          href={`${repoUrl}/releases`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(`${repoUrl}/releases`);
          }}
          className="text-sm text-brand hover:underline inline-flex items-center gap-1.5 cursor-pointer"
        >
          <ExternalLink className="size-3.5" /> Release Notes & Changelogs
        </a>
      </div>
      <Separator />
      <p className="text-[11px] text-muted-foreground">
        Built with Next.js, Prisma, and the Model Context Protocol. Bring your own keys to OpenRouter, OpenAI, Anthropic, Groq, Mistral, Together AI, and more.
      </p>
    </div>
  );
}

/* ----------------------------- Context governance ----------------------------- */
function ContextTab() {
  const cfg = useAppStore((s) => s.contextConfig);
  const setCfg = useAppStore((s) => s.setContextConfig);

  return (
    <div className="space-y-5 max-w-md">
      <div>
        <h3 className="text-base font-semibold">Context governance</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Retention policies control how the agent manages its context window. Higher values preserve more history at the cost of token usage.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Protection window (tokens)</Label>
            <span className="text-xs font-mono text-muted-foreground">{cfg.pruneProtectTokens.toLocaleString()}</span>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Recent tool outputs within this window are kept intact. Older outputs are replaced with a placeholder.
          </p>
          <Slider
            min={5000}
            max={200000}
            step={5000}
            value={[cfg.pruneProtectTokens]}
            onValueChange={(v) => setCfg({ pruneProtectTokens: v[0]! })}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>5K</span>
            <span className="text-brand">{DEFAULT_CONTEXT_CONFIG.pruneProtectTokens.toLocaleString()} default</span>
            <span>200K</span>
          </div>
        </div>

        <Separator />

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Compaction buffer (tokens)</Label>
            <span className="text-xs font-mono text-muted-foreground">{cfg.compactionBuffer.toLocaleString()}</span>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Extra headroom reserved beyond the output limit before compaction triggers.
          </p>
          <Slider
            min={2000}
            max={80000}
            step={2000}
            value={[cfg.compactionBuffer]}
            onValueChange={(v) => setCfg({ compactionBuffer: v[0]! })}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>2K</span>
            <span className="text-brand">{DEFAULT_CONTEXT_CONFIG.compactionBuffer.toLocaleString()} default</span>
            <span>80K</span>
          </div>
        </div>

        <Separator />

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Tail turns</Label>
            <span className="text-xs font-mono text-muted-foreground">{cfg.tailTurns}</span>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Number of recent user&harr;assistant exchanges always preserved during truncation.
          </p>
          <Slider
            min={1}
            max={10}
            step={1}
            value={[cfg.tailTurns]}
            onValueChange={(v) => setCfg({ tailTurns: v[0]! })}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>1</span>
            <span className="text-brand">{DEFAULT_CONTEXT_CONFIG.tailTurns} default</span>
            <span>10</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1"
          onClick={() => {
            setCfg({ ...DEFAULT_CONTEXT_CONFIG });
            toast.success("Context settings reset to defaults");
          }}
        >
          <RotateCcw className="size-3" /> Reset to defaults
        </Button>
      </div>
    </div>
  );
}

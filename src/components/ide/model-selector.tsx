"use client";

import * as React from "react";
import { Check, ChevronDown, Cpu, KeyRound, Plus, Search, Sparkles, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useTranslation } from "@/hooks/use-translation";
import type { ProviderId, ProviderInfo, ProviderKeyDTO } from "@/lib/types";

interface ModelSelectorProps {
  compact?: boolean;
}

export function formatModelDisplayName(rawId: string, t?: (k: string) => string): string {
  if (!rawId) return "";
  if (rawId === "auto") return t ? t("auto_best_model") : "Auto (Best Model)";
  const name = rawId.includes("/") ? rawId.split("/").pop()! : rawId;
  return name
    .replace(/-instruct$/i, "")
    .replace(/-chat$/i, "")
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(\d+)b\b/gi, "$1B")
    .replace(/\b(\d+)k\b/gi, "$1K")
    .replace(/\bv(\d+)/gi, "V$1")
    .replace(/Deepseek/gi, "DeepSeek")
    .replace(/Openai/gi, "OpenAI")
    .replace(/Gpt/gi, "GPT")
    .replace(/Codegemma/gi, "CodeGemma")
    .replace(/Starcoder/gi, "StarCoder")
    .replace(/Dbrx/gi, "DBRX")
    .replace(/Sea Lion/gi, "SEA-LION")
    .trim();
}


/** Filter a provider's model list by a search query. Returns null if the
 *  provider itself doesn't match at all and none of its models do. */
function filterProvider(
  provider: ProviderInfo,
  query: string,
  t?: (k: string) => string,
): ProviderInfo | null {
  if (!query) return provider;
  const q = query.toLowerCase();
  const providerMatches = provider.name.toLowerCase().includes(q);
  const filteredModels = provider.models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      formatModelDisplayName(m.id, t).toLowerCase().includes(q),
  );
  if (providerMatches) return provider; // show all models when provider name matches
  if (filteredModels.length === 0) return null;
  return { ...provider, models: filteredModels };
}

export function ModelSelector(_props: ModelSelectorProps) {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const providerKeys = useAppStore((s) => s.providerKeys);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  const keyFor = (id: ProviderId) => providerKeys.find((k) => k.provider === id);
  const currentProvider = providers.find((p) => p.id === selectedProvider);

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Auto-focus the search box when the popover opens; clear on close.
  React.useEffect(() => {
    if (open) {
      // Small delay to let the popover animate in before focusing.
      const t = window.setTimeout(() => searchRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    } else {
      setSearch("");
    }
  }, [open]);

  const grouped = React.useMemo(() => {
    const free: ProviderInfo[] = [];
    const tokenRequired: ProviderInfo[] = [];
    const byokConfigured: ProviderInfo[] = [];
    for (const p of providers) {
      const keyInfo = providerKeys.find((k) => k.provider === p.id);
      const config = keyInfo?.modelsConfig;
      let rawList: string[] = [];

      if (config && config.length > 0) {
        rawList = config.filter((m: any) => m.enabled !== false).map((m: any) => m.id);
      } else if (keyInfo?.models && keyInfo.models.length > 0) {
        rawList = keyInfo.models;
      } else if (p.models && p.models.length > 0) {
        rawList = p.models.map((m: any) => (typeof m === "string" ? m : m.id));
      }

      // Prepend "auto" as the default option if models exist
      const finalModelIds = rawList.length > 0
        ? Array.from(new Set(["auto", ...rawList]))
        : [];

      const models = finalModelIds.map((id: string) => ({ id, name: formatModelDisplayName(id, t) }));

      if (p.free && p.requiresKey) {
        tokenRequired.push({ ...p, models });
      } else if (p.free) {
        free.push({ ...p, models });
      } else if (keyInfo?.hasKey) {
        byokConfigured.push({ ...p, models });
      }
    }
    return { free, tokenRequired, byokConfigured };
  }, [providers, providerKeys, t]);

  // Apply search filter
  const filtered = React.useMemo(() => {
    const free = grouped.free
      .map((p) => filterProvider(p, search, t))
      .filter(Boolean) as ProviderInfo[];
    const tokenRequired = grouped.tokenRequired
      .map((p) => filterProvider(p, search, t))
      .filter(Boolean) as ProviderInfo[];
    const byokConfigured = grouped.byokConfigured
      .map((p) => filterProvider(p, search, t))
      .filter(Boolean) as ProviderInfo[];
    return { free, tokenRequired, byokConfigured };
  }, [grouped, search, t]);

  const noResults = search.length > 0 && filtered.free.length === 0 && filtered.tokenRequired.length === 0 && filtered.byokConfigured.length === 0;

  const pick = async (p: ProviderInfo, modelId: string) => {
    await useAppStore.getState().applyChatModelSelection(p.id, modelId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-6.5 px-1.5 gap-1 font-sans text-[11px] min-w-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 border-0 font-medium",
            _props.compact ? "max-w-[140px] sm:max-w-[190px]" : "max-w-[180px] sm:max-w-[240px]"
          )}
          aria-label={t("select_provider_and_model")}
          title={`${currentProvider?.name ?? "Provider"} / ${formatModelDisplayName(selectedModel, t)}`}
        >
          <ProviderLogo providerId={selectedProvider} modelId={selectedModel} size={14} />
          <span className="hidden xl:inline max-w-[70px] truncate min-w-0 font-medium text-muted-foreground">
            {currentProvider?.name ?? t("select")}
          </span>
          <span className="text-muted-foreground/50 shrink-0 hidden xl:inline">/</span>
          <span className="max-w-[100px] sm:max-w-[130px] truncate text-foreground font-mono text-[11px] min-w-0">
            {formatModelDisplayName(selectedModel, t)}
          </span>
          <ChevronDown className="size-3 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[360px] p-0 flex flex-col"
        align="start"
      >
        {/* Header */}
        <div className="px-3 py-2 border-b shrink-0 flex items-center justify-between">
          <div className="text-xs font-semibold">{t("provider_and_model")}</div>
        </div>

        {/* Search box */}
        <div className="px-2 py-1.5 border-b shrink-0">
          <div className="relative">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (search) {
                    e.stopPropagation();
                    setSearch("");
                  }
                }
              }}
              placeholder={t("search_providers_or_models")}
              className="h-7 ps-7 pe-7 text-xs font-sans"
              aria-label={t("search_models")}
              spellCheck={false}
              autoComplete="off"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
                className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t("clear_search")}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Model list */}
        <div className="flex-1 min-h-0 max-h-[380px] overflow-y-auto">
          {noResults ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
              <Search className="size-5 text-muted-foreground/50" />
              <p className="text-xs font-medium text-muted-foreground">{t("no_models_found")}</p>
              <p className="text-[11px] text-muted-foreground/70">
                {t("try_different_search_term")}
              </p>
            </div>
          ) : (
            <div className="p-1.5">
              {filtered.tokenRequired.length > 0 && (
                <ProviderGroup
                  label={t("requires_free_account_token")}
                  providers={filtered.tokenRequired}
                  keyFor={keyFor}
                  selectedProvider={selectedProvider}
                  selectedModel={selectedModel}
                  onPick={pick}
                  searchQuery={search}
                />
              )}
              {filtered.free.length > 0 && (
                <>
                  {filtered.tokenRequired.length > 0 && <Separator className="my-1.5" />}
                  <ProviderGroup
                    label={t("free_tier")}
                    providers={filtered.free}
                    keyFor={keyFor}
                    selectedProvider={selectedProvider}
                    selectedModel={selectedModel}
                    onPick={pick}
                    searchQuery={search}
                  />
                </>
              )}
              {filtered.byokConfigured.length > 0 && (
                <>
                  {(filtered.free.length > 0 || filtered.tokenRequired.length > 0) && <Separator className="my-1.5" />}
                  <ProviderGroup
                    label={t("byok_configured")}
                    providers={filtered.byokConfigured}
                    keyFor={keyFor}
                    selectedProvider={selectedProvider}
                    selectedModel={selectedModel}
                    onPick={pick}
                    searchQuery={search}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ProviderGroupProps {
  label: string;
  providers: ProviderInfo[];
  keyFor: (id: ProviderId) => ProviderKeyDTO | undefined;
  selectedProvider: ProviderId;
  selectedModel: string;
  onPick: (p: ProviderInfo, modelId: string) => void;
  searchQuery?: string;
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-muted text-foreground rounded-[2px] px-[1px] not-italic font-medium">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function ProviderGroup({
  label,
  providers,
  keyFor,
  selectedProvider,
  selectedModel,
  onPick,
  searchQuery = "",
}: ProviderGroupProps) {
  const { t } = useTranslation();
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  if (providers.length === 0) return null;
  return (
    <div>
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {providers.map((p) => {
        const key = keyFor(p.id);
        const isTokenRequired = Boolean(p.free && p.requiresKey);
        const requiresKey = Boolean(p.requiresKey);
        const keyMissing = requiresKey && !key?.hasKey;
        const handleAddKey = (e: React.MouseEvent) => {
          e.stopPropagation();
          setSettingsTab("providers");
          setSettingsOpen(true);
        };
        return (
          <div key={p.id} className="px-1.5 py-1">
            <div className="flex items-center gap-1.5 px-1 py-1">
              <ProviderLogo providerId={p.id} size={15} />
              <span className="text-xs font-semibold">
                <HighlightMatch text={p.name} query={searchQuery} />
              </span>
              {isTokenRequired ? (
                key?.hasKey ? (
                  <Badge variant="outline" className="text-[10px] h-4 text-brand border-brand/40 gap-0.5">
                    <KeyRound className="size-2.5" /> {t("token_badge")}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] h-4 border-amber-500/40 text-amber-600">
                    {t("token_required_badge")}
                  </Badge>
                )
              ) : p.free ? (
                <Badge variant="secondary" className="text-[10px] h-4">{t("free_badge")}</Badge>
              ) : key?.hasKey ? (
                <Badge variant="outline" className="text-[10px] h-4 text-brand border-brand/40 gap-0.5">
                  <KeyRound className="size-2.5" /> {t("key_badge")}
                </Badge>
              ) : requiresKey ? (
                <Badge variant="outline" className="text-[10px] h-4 text-muted-foreground">
                  {t("no_key_badge")}
                </Badge>
              ) : null}
              {keyMissing && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto h-5 px-1.5 text-[10px] gap-0.5"
                  onClick={handleAddKey}
                >
                  <Plus className="size-2.5" /> {t("add_key")}
                </Button>
              )}
            </div>
            <div className="ms-3 space-y-0.5 border-s ps-2 my-0.5">
              {p.models.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-muted-foreground italic">
                  {isTokenRequired ? t("add_token_to_load_models") : t("no_models_configured")}
                </div>
              ) : (
                p.models.map((m) => {
                  const active = p.id === selectedProvider && m.id === selectedModel;
                  const displayName = formatModelDisplayName(m.id, t);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onPick(p, m.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-accent transition-colors min-w-0",
                        active && "bg-accent font-medium",
                        keyMissing && "opacity-60",
                      )}
                    >
                      <Check className={cn("size-3.5 text-brand shrink-0", !active && "opacity-0")} />
                      <ProviderLogo providerId={p.id} modelId={m.id} size={15} />
                      <span className="truncate min-w-0 flex-1 font-sans text-xs">
                        <HighlightMatch text={displayName} query={searchQuery} />
                      </span>
                      {m.contextWindow && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {formatContext(m.contextWindow)}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

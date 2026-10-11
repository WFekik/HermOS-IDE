"use client";

import * as React from "react";
import {
  ExternalLink,
  Save,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/stores/app-store";
import { useTranslation } from "@/hooks/use-translation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ProviderId, ProviderInfo, ProviderKeyDTO, SaveKeyRequest } from "@/lib/types";
import { ProviderModels } from "@/components/settings/provider-models";
import { ProviderLogo } from "@/components/brand/provider-logo";

/**
 * Providers (BYOK) settings tab — the heaviest tab in the settings dialog
 * (per-provider key forms, model lists and the custom-provider form). Kept
 * in its own module so the dialog can code-split it behind a Suspense
 * skeleton (see SettingsDialog in settings-dialog.tsx).
 */
/**
 * Fetch a provider's live model list (`GET {baseUrl}/models` via
 * POST /api/providers/models) and persist it onto the key row, then refresh
 * the store so the chat model picker shows the models immediately. Shared by
 * the per-card save flow and the add-custom flow — a saved provider with no
 * models is invisible-but-unusable in the picker.
 * Returns the number of models stored (0 when the endpoint returned none).
 */
async function fetchAndPersistModels(
  providerId: ProviderId,
  providerName: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<number> {
  const loadId = toast.loading(t("auto_fetching_models", { provider: providerName }));
  try {
    const { apiPost, apiPatch } = await import("@/lib/api-client");
    const res = await apiPost<{
      models?: Array<{ id: string; name?: string }>;
      keptStale?: boolean;
    }>("/api/providers/models", { provider: providerId });
    if (res?.keptStale) {
      // Endpoint silent: server kept the stored config (did NOT wipe it).
      // Just sync the store so the picker reflects known data; never PATCH
      // the echoed list back (that would reset enabled/thinking overrides).
      toast.dismiss(loadId);
      await useAppStore.getState().refreshProviderKeys();
      await useAppStore.getState().refreshProviders();
      return res.models?.length ?? 0;
    }
    if (res && res.models && res.models.length > 0) {
      const modelsToSave = res.models.map((m) => ({
        id: m.id,
        enabled: true,
        thinkingLevel: "default",
      }));
      await apiPatch(`/api/providers/keys/${encodeURIComponent(providerId)}`, {
        models: modelsToSave,
      });
      await useAppStore.getState().refreshProviderKeys();
      await useAppStore.getState().refreshProviders();
      toast.success(t("models_loaded_count", { count: res.models.length }), { id: loadId });
      return res.models.length;
    }
    toast.dismiss(loadId);
    return 0;
  } catch (err) {
    console.error("Failed to auto-fetch models:", err);
    toast.dismiss(loadId);
    return 0;
  }
}

export function ProvidersTab() {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const providerKeys = useAppStore((s) => s.providerKeys);
  const saveKey = useAppStore((s) => s.saveProviderKey);

  const [addCustomOpen, setAddCustomOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customUrl, setCustomUrl] = React.useState("");
  const [customKey, setCustomKey] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [filterCategory, setFilterCategory] = React.useState<"all" | "configured" | "free" | "custom">("all");

  const allProviders = React.useMemo(() => {
    const list: ProviderInfo[] = [...providers];
    for (const pk of providerKeys) {
      if (pk.provider.startsWith("custom") && !list.some((p) => p.id === pk.provider)) {
        const name = pk.provider.includes(":")
          ? pk.provider.split(":")[1]
          : pk.provider === "custom"
          ? "Custom OpenAI-compatible"
          : pk.provider;
        list.push({
          id: pk.provider as ProviderId,
          name: name,
          description: `Custom OpenAI-compatible endpoint (${pk.baseUrl || "Custom URL"})`,
          requiresKey: true,
          baseUrl: pk.baseUrl || "",
          supportsVision: true,
          models: [],
        });
      }
    }
    return list;
  }, [providers, providerKeys]);

  const handleAddCustom = async () => {
    // Collapse whitespace runs: the id is `custom:<name>` and display code
    // splits on ":" — inner multi-spaces would look broken in the picker.
    const cleanName = customName.trim().replace(/\s+/g, " ");
    const cleanUrl = customUrl.trim();
    const cleanKey = customKey.trim() || "sk-custom-key";
    if (!cleanName) {
      toast.error(t("provider_name_required"));
      return;
    }
    if (!cleanUrl) {
      toast.error(t("base_url_required"));
      return;
    }

    setAdding(true);
    const providerId = `custom:${cleanName}` as ProviderId;
    try {
      await saveKey({
        provider: providerId,
        apiKey: cleanKey,
        baseUrl: cleanUrl,
      });
      toast.success(t("custom_provider_added", { name: cleanName }));
      setCustomName("");
      setCustomUrl("");
      setCustomKey("");
      setAddCustomOpen(false);
      await useAppStore.getState().refreshProviderKeys();
      await useAppStore.getState().refreshProviders();
      // A custom endpoint with no models can't be picked in the chat
      // panel — pull its OpenAI-compatible model list now (same as the
      // per-card save flow). Failure keeps the provider; models can be
      // added manually in its card.
      await fetchAndPersistModels(providerId, cleanName, t);
    } catch (e: any) {
      toast.error(e?.message || t("custom_provider_failed"));
    } finally {
      setAdding(false);
    }
  };

  const keyFor = (id: ProviderId) => providerKeys.find((k) => k.provider === id);

  const counts = React.useMemo(() => {
    const configured = allProviders.filter((p) => keyFor(p.id)?.hasKey).length;
    const free = allProviders.filter((p) => p.free).length;
    const custom = allProviders.filter((p) => p.id.startsWith("custom")).length;
    return { all: allProviders.length, configured, free, custom };
  }, [allProviders, providerKeys]);

  const filteredProviders = React.useMemo(() => {
    let list = [...allProviders].sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1;
      const ak = providerKeys.find((k) => k.provider === a.id)?.hasKey ? 1 : 0;
      const bk = providerKeys.find((k) => k.provider === b.id)?.hasKey ? 1 : 0;
      return bk - ak;
    });

    if (filterCategory === "configured") {
      list = list.filter((p) => keyFor(p.id)?.hasKey);
    } else if (filterCategory === "free") {
      list = list.filter((p) => p.free);
    } else if (filterCategory === "custom") {
      list = list.filter((p) => p.id.startsWith("custom"));
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.description && p.description.toLowerCase().includes(q)),
      );
    }

    return list;
  }, [allProviders, providerKeys, filterCategory, searchQuery]);

  return (
    <div className="space-y-4">
      {/* pe-10: clears room for the floating dialog X (absolute top-4
          end-4) so the action button never slides underneath it. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pe-10">
        <div>
          <h3 className="text-base font-semibold">{t("providers_byok")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("providers_byok_desc")}
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 gap-1.5 bg-brand text-white hover:bg-brand/90 text-xs shrink-0"
          onClick={() => setAddCustomOpen(true)}
        >
          <Save className="size-3.5" />
          {t("add_custom_provider")}
        </Button>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <Search className="size-3.5 text-muted-foreground absolute start-2.5 top-1/2 -translate-y-1/2" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("search_providers_placeholder")}
            className="h-8 ps-8 text-xs bg-muted/30"
          />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          {(
            [
              { id: "all", label: t("filter_all"), count: counts.all },
              { id: "configured", label: t("filter_connected"), count: counts.configured },
              { id: "free", label: t("filter_free_tier"), count: counts.free },
              { id: "custom", label: t("filter_custom"), count: counts.custom },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterCategory(tab.id)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5",
                filterCategory === tab.id
                  ? "bg-brand/10 text-brand border border-brand/30"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border border-transparent",
              )}
            >
              <span>{tab.label}</span>
              <span className="text-[10px] opacity-70 font-mono">(<bdi>{tab.count}</bdi>)</span>
            </button>
          ))}
        </div>
      </div>

      {addCustomOpen && (
        <div className="rounded-xl border border-brand/40 bg-brand/[0.02] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-brand">{t("add_openai_provider")}</h4>
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" onClick={() => setAddCustomOpen(false)}>
              <XCircle className="size-4" />
            </Button>
          </div>
          <div className="grid sm:grid-cols-2 gap-2.5">
            <div className="grid gap-1">
              <Label className="text-xs">{t("provider_name")}</Label>
              <Input
                placeholder={t("custom_provider_name_hint")}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">{t("base_url")}</Label>
              <Input
                placeholder={t("custom_provider_url_hint")}
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">{t("api_key_optional")}</Label>
              <Input
                type="password"
                placeholder={t("custom_provider_key_hint")}
                value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddCustomOpen(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" className="h-7 text-xs bg-brand text-white hover:bg-brand/90 gap-1" onClick={handleAddCustom} disabled={adding}>
              {adding ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
              {t("save_provider")}
            </Button>
          </div>
        </div>
      )}

      {filteredProviders.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center space-y-2">
          <p className="text-xs text-muted-foreground">{t("no_providers_found")} &ldquo;{searchQuery}&rdquo;</p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setSearchQuery(""); setFilterCategory("all"); }}>
            {t("reset_filters")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2.5">
          {filteredProviders.map((p) => (
            <ProviderCard key={p.id} provider={p} keyInfo={keyFor(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCard({ provider, keyInfo }: { provider: ProviderInfo; keyInfo?: ProviderKeyDTO }) {
  const { t } = useTranslation();
  const save = useAppStore((s) => s.saveProviderKey);
  const remove = useAppStore((s) => s.removeProviderKey);
  const test = useAppStore((s) => s.testProviderKey);

  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(keyInfo?.baseUrl ?? provider.baseUrl ?? "");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  const featured = provider.id === "openrouter" || provider.id === "nvidia" || provider.id === "zen";

  const saveKey = async () => {
    if (!apiKey.trim()) {
      toast.error(t("enter_api_key"));
      return;
    }
    setSaving(true);
    try {
      const req: SaveKeyRequest = {
        provider: provider.id,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
      };
      await save(req);
      toast.success(t("provider_key_saved", { name: provider.name }));
      setApiKey("");

      // Automatically fetch models from the provider and save them so they are synced
      await fetchAndPersistModels(provider.id, provider.name, t);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("provider_key_save_failed"));
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await test(provider.id);
      setTestResult(r);
      if (r.ok) {
        toast.success(t("provider_reachable", { name: provider.name, latency: r.latencyMs ?? "?" }));
      } else {
        toast.error(t("provider_test_failed", { error: r.error ?? t("unknown_error") }));
      }
    } finally {
      setTesting(false);
    }
  };


  return (
    <div className={cn("rounded-xl border p-3.5", featured && "border-brand/30 bg-brand/[0.03]")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <ProviderLogo providerId={provider.id} size={18} />
            <span className="text-sm font-medium">{provider.name}</span>
            {provider.free && provider.requiresKey ? (
              <Badge variant="outline" className="text-[10px] h-4 border-amber-500/40 text-amber-600">{t("token_required")}</Badge>
            ) : provider.free ? (
              <Badge variant="secondary" className="text-[10px] h-4">{t("filter_free_tier")}</Badge>
            ) : null}
            {featured && (
              <Badge variant="outline" className="text-[10px] h-4 text-brand border-brand/40">
                {t("featured")}
              </Badge>
            )}
            {keyInfo?.hasKey && (
              <Badge variant="outline" className="text-[10px] h-4 text-brand border-brand/40">
                <CheckCircle2 className="size-2.5" /> {t("filter_connected")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{(() => { const k = `provider_desc_${provider.id}`; const v = t(k); return v !== k ? v : provider.description; })()}</p>
          {keyInfo?.keyHint && (
            <p className="text-[11px] font-mono text-muted-foreground mt-1">
              {t("key_hint_prefix", { hint: keyInfo.keyHint })}
            </p>
          )}
        </div>
        {provider.docsUrl && (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-brand hover:underline inline-flex items-center gap-1 shrink-0"
          >
            {t("docs")} <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {provider.id === "puter" ? (
        <div className="mt-3 grid gap-2">
          {keyInfo?.hasKey ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[11px] gap-1.5">
                <CheckCircle2 className="size-3" /> {t("filter_connected")}
              </Badge>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={testKey} disabled={testing}>
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t("test_connection")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs hover:text-destructive"
                disabled={removing}
                onClick={async () => {
                  if (removing) return;
                  setRemoving(true);
                  try {
                    await remove(provider.id);
                    toast.success(t("puter_disconnected"));
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : t("provider_key_remove_failed"));
                  } finally {
                    setRemoving(false);
                  }
                }}
              >
                {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                {t("remove_key")}
              </Button>
              {testResult && (
                <span className={cn("text-[11px] inline-flex items-center gap-1", testResult.ok ? "text-brand" : "text-destructive")}>
                  {testResult.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                  {testResult.ok
                    ? t("provider_test_ok", { latency: testResult.latencyMs ?? "?" })
                    : t("provider_test_failed_short")}
                </span>
              )}
            </div>
          ) : (
            <div className="grid gap-2">
              <p className="text-[11px] text-muted-foreground">
                {/* Site labels (Account / Create token) intentionally stay in
                    English — they mirror puter.com's own UI labels. */}
                {t("puter_help_go")}{" "}
                <a href="https://puter.com/dashboard#account" target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  puter.com/dashboard
                </a>{" "}
                {t("puter_help_then")}
              </p>
              <div className="flex gap-1.5">
                <Input
                  id={`key-${provider.id}`}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t("puter_token_placeholder")}
                  className="h-8 text-xs font-mono flex-1"
                />
                <Button size="sm" className="h-8 bg-brand text-white hover:bg-brand/90" onClick={saveKey} disabled={saving}>
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {t("save")}
                </Button>
              </div>
            </div>
          )}
          <ProviderModels provider={provider.id} keyInfo={keyInfo} />
        </div>
      ) : provider.requiresKey && (
        <div className="mt-3 grid gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`key-${provider.id}`} className="text-[11px]">
              {provider.requiresKey ? t("api_key_required") : t("api_key_optional")}
            </Label>
            <div className="flex gap-1.5">
              <Input
                id={`key-${provider.id}`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyInfo?.hasKey ? `•••••••• (${t("saved")})` : t("paste_api_key")}
                className="h-8 text-xs font-mono"
              />
              <Button size="sm" className="h-8 bg-brand text-white hover:bg-brand/90" onClick={saveKey} disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {t("save")}
              </Button>
            </div>
          </div>
          {(provider.id === "custom" || !provider.baseUrl) && (
            <div className="grid gap-1">
              <Label htmlFor={`base-${provider.id}`} className="text-[11px]">
                {t("base_url")}
              </Label>
              <Input
                id={`base-${provider.id}`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={provider.baseUrl ?? "https://api.example.com/v1"}
                className="h-8 text-xs font-mono"
              />
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={testKey}
              disabled={testing || !keyInfo?.hasKey}
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {t("test_connection")}
            </Button>
            {keyInfo?.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs hover:text-destructive"
                disabled={removing}
                  onClick={async () => {
                    if (removing) return;
                    setRemoving(true);
                    try {
                      await remove(provider.id);
                      toast.success(t("provider_key_removed", { name: provider.name }));
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : t("provider_key_remove_failed"));
                    } finally {
                      setRemoving(false);
                    }
                  }}
              >
                {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                {t("remove_key")}
              </Button>
            )}
            {testResult && (
              <span className={cn("text-[11px] inline-flex items-center gap-1", testResult.ok ? "text-brand" : "text-destructive")}>
                {testResult.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                {testResult.ok
                  ? t("provider_test_ok", { latency: testResult.latencyMs ?? "?" })
                  : t("provider_test_failed_short")}
              </span>
            )}
          </div>
          <ProviderModels provider={provider.id} keyInfo={keyInfo} />
        </div>
      )}
    </div>
  );
}
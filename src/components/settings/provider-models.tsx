"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  RefreshCw,
  Loader2,
  Save,
  AlertTriangle,
  Cpu,
  BrainCircuit,
  Check,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Search,
  CheckSquare,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import { apiPost, apiPatch, ApiRequestError } from "@/lib/api-client";
import {
  getReasoningLevels,
  normalizeThinkingLevel,
  type ModelReasoningCapabilities,
  type ThinkingLevel,
  type ThinkingLevelOption,
} from "@/lib/reasoning";
import { cn } from "@/lib/utils";
import type { ProviderId, ProviderKeyDTO } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * ProviderModels — per-model enable/disable + thinking-level config.
 *
 * Rendered inside the existing Providers settings tab, beneath each
 * provider card that has a saved key. The list of models is fetched
 * on demand from POST /api/providers/models and the per-model config
 * is saved via PATCH /api/providers/keys/[provider].
 * ------------------------------------------------------------------ */

export interface ModelRow {
  id: string;
  name: string;
  enabled: boolean;
  thinkingLevel: ThinkingLevel;
}

interface RemoteModel {
  id: string;
  name?: string;
  /**
   * Live per-model reasoning capabilities (OpenRouter `/models`
   * `reasoning` metadata, normalized by the reasoning module). Absent
   * (undefined) = unknown — levels resolve from the provider scheme
   * alone and the selector still shows.
   */
  reasoning?: ModelReasoningCapabilities;
}

/**
 * `ModelInfo` (src/lib/types.ts) already carries the optional `reasoning`
 * field the backend merges into the provider catalog; the alias just keeps
 * the row-level access typed.
 */
interface CatalogModel {
  id: string;
  name: string;
  reasoning?: ModelReasoningCapabilities;
}

interface ModelsResponse {
  models?: RemoteModel[];
  ok?: false;
  error?: string;
}

/* --------------------------- Normalization ---------------------------- */

/**
 * Normalize the `models` field on a ProviderKeyDTO into ModelRow[].
 *
 * The field may be:
 *   - undefined / null  → no saved config
 *   - string[]          → legacy: list of enabled model ids
 *   - JSON string       → parsed into [{ id, enabled, thinkingLevel }]
 *   - array of objects  → used as-is (defensive cast)
 */
export function normalizeSavedModels(
  raw: ProviderKeyDTO["models"] | ProviderKeyDTO["modelsConfig"],
): { id: string; enabled?: boolean; thinkingLevel?: ThinkingLevel }[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeSavedModels(
        parsed as unknown as ProviderKeyDTO["models"],
      );
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item === "string") {
        return [{ id: item, enabled: true, thinkingLevel: normalizeThinkingLevel(undefined) }];
      }
      if (item && typeof item === "object" && "id" in item) {
        const obj = item as {
          id: string;
          enabled?: boolean;
          thinkingLevel?: ThinkingLevel;
        };
        return [
          {
            id: String(obj.id),
            enabled: obj.enabled ?? true,
            thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
          },
        ];
      }
      return [];
    });
  }
  return [];
}

/* ------------------------------ Helpers ------------------------------- */

async function fetchProviderModels(
  provider: ProviderId,
): Promise<ModelsResponse> {
  return apiPost<ModelsResponse>("/api/providers/models", { provider });
}

async function patchProviderModels(
  provider: ProviderId,
  models: ModelRow[],
): Promise<{ key: ProviderKeyDTO }> {
  return apiPatch<{ key: ProviderKeyDTO }>(
    `/api/providers/keys/${encodeURIComponent(provider)}`,
    {
      models: models.map((m) => ({
        id: m.id,
        enabled: m.enabled,
        thinkingLevel: m.thinkingLevel,
      })),
    },
  );
}

function mergeModels(
  catalogIds: { id: string; name: string }[],
  saved: ReturnType<typeof normalizeSavedModels>,
  fetched?: RemoteModel[],
): ModelRow[] {
  const savedMap = new Map(saved.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows: ModelRow[] = [];

  // Fetched list takes priority (it reflects the live provider catalog).
  if (fetched && fetched.length > 0) {
    for (const m of fetched) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const s = savedMap.get(m.id);
      rows.push({
        id: m.id,
        name: m.name ?? m.id,
        enabled: s?.enabled ?? true,
        thinkingLevel: s?.thinkingLevel ?? "default",
      });
    }
    return rows;
  }

  // Fall back to: saved config first, then catalog models the user hasn't seen.
  for (const s of saved) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const cat = catalogIds.find((c) => c.id === s.id);
    rows.push({
      id: s.id,
      name: cat?.name ?? s.id,
      enabled: s.enabled ?? true,
      thinkingLevel: s.thinkingLevel ?? "default",
    });
  }
  for (const c of catalogIds) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    rows.push({
      id: c.id,
      name: c.name,
      enabled: true,
      thinkingLevel: "default",
    });
  }
  return rows;
}

/* ------------------------------ Component ----------------------------- */

export function ProviderModels({
  provider,
  keyInfo,
}: {
  provider: ProviderId;
  keyInfo?: ProviderKeyDTO;
}) {
  const providers = useAppStore((s) => s.providers);
  const refreshProviderKeys = useAppStore((s) => s.refreshProviderKeys);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const catalog = providers.find((p) => p.id === provider);

  const hasKey = !!keyInfo?.hasKey;

  const [rows, setRows] = React.useState<ModelRow[]>([]);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const initialized = React.useRef(false);

  /**
   * Map of model id → live reasoning capabilities, derived from the
   * provider catalog (and merged with the live-fetched list when the
   * user clicks Refresh). Models absent from the catalog (or with the
   * field undefined) resolve levels from the provider scheme alone.
   */
  const [reasoningMap, setReasoningMap] = React.useState<
    Map<string, ModelReasoningCapabilities | undefined>
  >(() => {
    const map = new Map<string, ModelReasoningCapabilities | undefined>();
    for (const m of catalog?.models ?? []) {
      const cm = m as CatalogModel;
      map.set(cm.id, cm.reasoning);
    }
    return map;
  });

  // Re-derive the map when the catalog changes (e.g. on first load or
  // when the user switches providers). Preserves any live-fetched
  // entries the previous catalog didn't list by overlaying them on top
  // of the new catalog values.
  React.useEffect(() => {
    setReasoningMap((prev) => {
      const map = new Map<string, ModelReasoningCapabilities | undefined>();
      for (const m of catalog?.models ?? []) {
        const cm = m as CatalogModel;
        map.set(cm.id, cm.reasoning);
      }
      // Overlay previously-known values for ids the new catalog doesn't
      // list (e.g. a live-fetched model the catalog doesn't enumerate).
      for (const [k, v] of prev) {
        if (!map.has(k)) map.set(k, v);
      }
      return map;
    });
  }, [catalog]);

  // Initialize rows once, from saved config + catalog.
  React.useEffect(() => {
    if (initialized.current) return;
    if (!hasKey) {
      initialized.current = true;
      return;
    }
    const catalogModels =
      catalog?.models.map((m) => ({ id: m.id, name: m.name })) ?? [];
    const saved = normalizeSavedModels(keyInfo?.modelsConfig || keyInfo?.models);
    const initial = mergeModels(catalogModels, saved);
    setRows(initial);
    initialized.current = true;
  }, [hasKey, catalog, keyInfo]);

  const refreshMut = useMutation({
    mutationFn: () => fetchProviderModels(provider),
    onSuccess: (data) => {
      if (data && data.ok === false && data.error) {
        setFetchError(data.error);
        toast.error(`Failed to list models: ${data.error}`);
        return;
      }
      const fetched = data.models ?? [];
      setFetchError(null);
      if (fetched.length === 0) {
        toast.info("No remote models returned. Add custom model IDs below.");
      } else {
        toast.success(`Loaded ${fetched.length} models from provider`);
      }
      const catalogModels =
        catalog?.models.map((m) => ({ id: m.id, name: m.name })) ?? [];
      const saved = normalizeSavedModels(keyInfo?.modelsConfig || keyInfo?.models);
      // Merge the live fetched list's `reasoning` capabilities into the
      // catalog map so freshly-fetched models that the catalog didn't
      // list also get the right selector behaviour.
      setReasoningMap((prev) => {
        const map = new Map(prev);
        for (const m of fetched) {
          if (m && m.reasoning) {
            map.set(m.id, m.reasoning);
          }
        }
        return map;
      });
      setRows((cur) => {
        // Preserve user edits for models that still exist.
        const curMap = new Map(cur.map((r) => [r.id, r]));
        const merged = mergeModels(catalogModels, saved, fetched);
        return merged.map((r) => {
          const c = curMap.get(r.id);
          return c
            ? { ...r, enabled: c.enabled, thinkingLevel: c.thinkingLevel }
            : r;
        });
      });
      // The fetch persisted the freshly-captured reasoning capabilities to
      // the DB — sync the provider catalog so the composer's thinking
      // selector picks them up without an app reload.
      void refreshProviders();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiRequestError ? e.message : "Failed to fetch models";
      setFetchError(msg);
      toast.error(msg);
    },
  });

  const saveMut = useMutation({
    mutationFn: (toSave: ModelRow[]) => patchProviderModels(provider, toSave),
    onSuccess: () => {
      toast.success("Model configuration saved");
      setDirty(false);
      void refreshProviderKeys();
      void refreshProviders();
    },
    onError: (e) => {
      toast.error(
        e instanceof ApiRequestError
          ? e.message
          : "Failed to save model configuration",
      );
    },
  });

  const [isOpen, setIsOpen] = React.useState(false);
  const [modelFilter, setModelFilter] = React.useState("");

  const filteredRows = React.useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.id.toLowerCase().includes(q) || (r.name && r.name.toLowerCase().includes(q)),
    );
  }, [rows, modelFilter]);

  const enabledCount = rows.filter((r) => r.enabled).length;

  const handleToggleAll = (enable: boolean) => {
    setRows((cur) => cur.map((r) => ({ ...r, enabled: enable })));
    setDirty(true);
  };

  const [customModelId, setCustomModelId] = React.useState("");

  const handleAddModel = () => {
    const clean = customModelId.trim();
    if (!clean) return;
    if (rows.some((r) => r.id === clean)) {
      toast.error(`Model '${clean}' already exists.`);
      return;
    }
    setRows((cur) => [
      ...cur,
      { id: clean, name: clean, enabled: true, thinkingLevel: "default" },
    ]);
    setCustomModelId("");
    setDirty(true);
  };

  const handleRemoveModel = (id: string) => {
    setRows((cur) => cur.filter((r) => r.id !== id));
    setDirty(true);
  };

  const setRowEnabled = (id: string, enabled: boolean) => {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, enabled } : r)));
    setDirty(true);
  };

  const setRowThinking = (id: string, thinkingLevel: ThinkingLevel) => {
    setRows((cur) =>
      cur.map((r) => (r.id === id ? { ...r, thinkingLevel } : r)),
    );
    setDirty(true);
  };

  const levelsFor = (row: ModelRow): ThinkingLevelOption[] =>
    getReasoningLevels({ providerId: provider, caps: reasoningMap.get(row.id) });

  const handleSave = () => {
    if (!dirty || rows.length === 0) return;
    void saveMut.mutate(rows);
  };

  if (!hasKey) {
    return (
      <div className="mt-2.5 rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Cpu className="size-3.5 text-muted-foreground" />
          <span className="font-medium">Models</span>
        </div>
        <p className="mt-1 text-[11px]">Add an API key above to manage models.</p>
      </div>
    );
  }

  return (
    <div className="mt-2.5 rounded-lg border border-border/80 bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between gap-2 p-2.5">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-left flex-1 min-w-0 hover:opacity-80 transition-opacity"
        >
          <Cpu className="size-3.5 text-brand shrink-0" />
          <span className="text-xs font-medium truncate">Models</span>
          <Badge
            variant="secondary"
            className="h-4 px-1.5 text-[9px] font-mono shrink-0"
          >
            {enabledCount}/{rows.length} active
          </Badge>
          {isOpen ? (
            <ChevronUp className="size-3.5 text-muted-foreground ml-auto shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground ml-auto shrink-0" />
          )}
        </button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 text-[10px] px-2 shrink-0"
          onClick={() => {
            if (!isOpen) setIsOpen(true);
            refreshMut.mutate();
          }}
          disabled={refreshMut.isPending}
          aria-label="Refresh models from provider"
        >
          {refreshMut.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Fetch models
        </Button>
      </div>

      {fetchError && (
        <div className="mx-2.5 mb-2 flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/20 p-2 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <div className="flex-1">
            <p>{fetchError}</p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 h-5 px-2 text-[10px]"
              onClick={() => refreshMut.mutate()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {isOpen && (
        <div className="p-2.5 pt-0 border-t border-border/40 space-y-2 mt-1">
          {rows.length > 0 && (
            <div className="flex items-center gap-1.5 pt-1.5">
              <div className="relative flex-1">
                <Search className="size-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
                <Input
                  type="text"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="Filter models (claude, gpt, llama, deepseek)..."
                  className="h-7 pl-6 text-[11px]"
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[10px] px-2 text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => handleToggleAll(true)}
              >
                Enable all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[10px] px-2 text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => handleToggleAll(false)}
              >
                Disable all
              </Button>
            </div>
          )}

          <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
            {rows.length === 0 ? (
              <div className="space-y-1.5 py-2">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
                <p className="text-[11px] text-muted-foreground">
                  Click &ldquo;Fetch models&rdquo; to load available models from this provider.
                </p>
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                No models matching &ldquo;{modelFilter}&rdquo;
              </div>
            ) : (
              filteredRows.map((row) => (
                <ModelRowView
                  key={row.id}
                  row={row}
                  levels={levelsFor(row)}
                  onToggleEnabled={(v) => setRowEnabled(row.id, v)}
                  onChangeThinking={(tl) => setRowThinking(row.id, tl)}
                  onDelete={() => handleRemoveModel(row.id)}
                />
              ))
            )}
          </div>

          <div className="flex items-center gap-1.5 pt-1">
            <Input
              type="text"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              placeholder="Add custom model ID..."
              className="h-7 text-[11px] font-mono flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddModel();
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] gap-1 shrink-0"
              onClick={handleAddModel}
              disabled={!customModelId.trim()}
            >
              <Plus className="size-3" /> Add
            </Button>
          </div>

          {rows.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                className="h-7 gap-1 bg-brand text-brand-foreground hover:bg-brand/90 text-xs"
                onClick={handleSave}
                disabled={!dirty || saveMut.isPending}
              >
                {saveMut.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
                Save model config
              </Button>
              {dirty && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  Unsaved changes
                </span>
              )}
              {!dirty && (
                <span className="inline-flex items-center gap-1 text-[11px] text-brand">
                  <Check className="size-3" /> Saved
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRowView({
  row,
  levels,
  onToggleEnabled,
  onChangeThinking,
  onDelete,
}: {
  row: ModelRow;
  levels: ThinkingLevelOption[];
  onToggleEnabled: (v: boolean) => void;
  onChangeThinking?: (tl: ThinkingLevel) => void;
  onDelete: () => void;
}) {
  const normalized = normalizeThinkingLevel(row.thinkingLevel);
  const current =
    levels.some((t) => t.value === normalized)
      ? normalized
      : levels.find((t) => t.value === "default")?.value ?? levels[0]?.value ?? "default";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5",
        !row.enabled && "opacity-60",
      )}
    >
      <Switch
        checked={row.enabled}
        onCheckedChange={onToggleEnabled}
        aria-label={`Toggle ${row.id}`}
        id={`model-${row.id}`}
      />
      <div className="min-w-0 flex-1">
        <Label
          htmlFor={`model-${row.id}`}
          className="block truncate font-mono text-[11px] cursor-pointer"
          title={row.id}
        >
          {row.name}
        </Label>
        <div className="truncate text-[10px] text-muted-foreground" title={row.id}>
          {row.id}
        </div>
      </div>
      {levels.length > 0 && (
        <Select
          value={current}
          onValueChange={(v) => onChangeThinking?.(v as ThinkingLevel)}
          aria-label={`Thinking level for ${row.id}`}
        >
          <SelectTrigger className="h-6 w-[7.5rem] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levels.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-6 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        title="Remove model"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}

"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Save,
  RotateCcw,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  BookOpen,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  permissionsKeys,
  PERMISSION_ACTIONS,
  DEFAULT_CONFIG,
  fetchPermissions,
  savePermissions,
  type PermissionMode,
  type PermissionsConfig,
} from "@/components/permissions/types";

/* ------------------------------------------------------------------ *
 * PermissionsSettings — rendered inside the Settings dialog as a
 * dedicated tab. Loads the current config from GET /api/permissions
 * and saves via PUT /api/permissions.
 * ------------------------------------------------------------------ */

export function PermissionsSettings() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <PermissionsSettingsInner />
    </QueryClientProvider>
  );
}

function PermissionsSettingsInner() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: permissionsKeys.all,
    queryFn: fetchPermissions,
  });

  // Local working copy — initialized once the server config arrives.
  const [draft, setDraft] = React.useState<PermissionsConfig | null>(null);
  // Last-loaded config snapshot kept in state so the "dirty" comparison
  // can happen during render without reading a ref.
  const [lastLoaded, setLastLoaded] = React.useState<string | null>(null);
  const serializedQuery = query.data
    ? JSON.stringify(query.data.config)
    : null;

  React.useEffect(() => {
    if (!serializedQuery) return;
    setDraft(query.data!.config);
    setLastLoaded(serializedQuery);
  }, [serializedQuery, query.data]);

  const saveMut = useMutation({
    mutationFn: (cfg: PermissionsConfig) => savePermissions(cfg),
    onSuccess: (data) => {
      const serialized = JSON.stringify(data.config);
      setDraft(data.config);
      setLastLoaded(serialized);
      toast.success("Permissions saved");
      void queryClient.invalidateQueries({ queryKey: permissionsKeys.all });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to save permissions");
    },
  });

  const setRuleMode = (action: string, mode: PermissionMode) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const others = cur.rules.filter((r) => r.action !== action);
      return { ...cur, rules: [...others, { action, mode }] };
    });
  };

  const setAutoAllowReadonly = (v: boolean) => {
    setDraft((cur) => (cur ? { ...cur, autoAllowReadonly: v } : cur));
  };

  const handleSave = () => {
    if (!draft) return;
    void saveMut.mutate(draft);
  };

  const handleReset = () => {
    setDraft(DEFAULT_CONFIG);
    toast.info("Reverted to default config — click Save to persist");
  };

  if (query.isLoading || !draft) {
    return <PermissionsSkeleton />;
  }
  if (query.isError && !draft) {
    return (
      <div className="max-w-2xl space-y-3">
        <Header />
        <div className="rounded-md border border-amber-400/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p>
                {query.error instanceof Error
                  ? query.error.message
                  : "Failed to load permissions config."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-xs"
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const dirty = !!draft && JSON.stringify(draft) !== lastLoaded;

  return (
    <div className="max-w-2xl space-y-5">
      <Header />

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Action rules
        </div>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSION_ACTIONS.map((def) => {
                const rule = draft.rules.find((r) => r.action === def.action);
                const mode = rule?.mode ?? "ask";
                return (
                  <tr
                    key={def.action}
                    className="border-t hover:bg-accent/30"
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <code className="font-mono text-[11px] text-foreground">
                          {def.action}
                        </code>
                        {def.readonly && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="h-4 px-1 text-[9px] text-muted-foreground"
                              >
                                read-only
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              Read-only actions are auto-allowed when
                              &ldquo;Auto-allow read-only&rdquo; is on.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {def.description}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex justify-end">
                        <ModeToggle
                          value={mode}
                          onChange={(m) => setRuleMode(def.action, m)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label
                htmlFor="auto-readonly"
                className="text-xs font-medium"
              >
                Auto-allow read-only actions
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                When on, <code className="font-mono">file.read</code>,{" "}
                <code className="font-mono">web.fetch</code>, and{" "}
                <code className="font-mono">web.search</code> are allowed
                even if the default mode is Ask or Deny.
              </p>
            </div>
            <Switch
              id="auto-readonly"
              checked={draft.autoAllowReadonly}
              onCheckedChange={setAutoAllowReadonly}
              aria-label="Auto-allow read-only actions"
            />
          </div>
        </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={handleSave}
          disabled={!dirty || saveMut.isPending}
        >
          {saveMut.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={handleReset}
          disabled={saveMut.isPending}
        >
          <RotateCcw className="size-3.5" />
          Reset to defaults
        </Button>
        {dirty && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            Unsaved changes
          </span>
        )}
        {!dirty && lastLoaded && (
          <span className="inline-flex items-center gap-1 text-[11px] text-brand">
            <Check className="size-3" /> In sync with server
          </span>
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-brand" />
        <h3 className="text-base font-semibold">Permissions</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Control what agents are allowed to do. Changes apply to all agents in
        your workspace.
      </p>
      <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
        <BookOpen className="mt-0.5 size-3 shrink-0" />
        <span>
          Allow runs without prompting, Ask requires approval per invocation,
          Deny blocks the action outright.
        </span>
      </p>
    </div>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange: (m: PermissionMode) => void;
}) {
  const modes: { value: PermissionMode; label: string }[] = [
    { value: "allow", label: "Allow" },
    { value: "ask", label: "Ask" },
    { value: "deny", label: "Deny" },
  ];
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border"
      role="group"
      aria-label="Permission mode"
    >
      {modes.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          aria-pressed={value === m.value}
          className={cn(
            "px-2 py-1 text-[11px] transition-colors",
            value === m.value
              ? m.value === "allow"
                ? "bg-brand text-brand-foreground"
                : m.value === "deny"
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-primary text-primary-foreground"
              : "hover:bg-accent",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function PermissionsSkeleton() {
  return (
    <div className="max-w-2xl space-y-4">
      <Header />
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}

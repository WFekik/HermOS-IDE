"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  Coins,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/* ----------------------------- API contracts ----------------------------- */
/* GET /api/stats/usage  → { totals: {conversations, messages, tokens, toolExecutions},
 *                            byProvider: [{provider, count}],
 *                            byModel: [{model, count}] }                  */
/* GET /api/stats/tokens  → { days: [{date: "YYYY-MM-DD", tokensIn, tokensOut, total}] } */

interface UsageResponse {
  totals: {
    conversations: number;
    messages: number;
    tokens: number;
    toolExecutions: number;
  };
  byProvider: { provider: string; count: number }[];
  byModel: { model: string; count: number }[];
}

interface TokenDay {
  date: string;
  tokensIn: number;
  tokensOut: number;
  total: number;
}

interface TokensResponse {
  days: TokenDay[];
}

/* ------------------------------- helpers --------------------------------- */

/** Brand color single source of truth referencing CSS variable. */
const BRAND = "var(--brand)";
/** Muted neutral used for the "out" stack and chart grid lines. */
const MUTED = "oklch(0.55 0.005 106)";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shortWeekday(isoDate: string): string {
  // isoDate is YYYY-MM-DD; construct at UTC noon to avoid DST edges.
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return WEEKDAYS[d.getUTCDay()];
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtAxis(value: number): string {
  if (value === 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

/** Chart tooltip — show in/out/total for the hovered day. */
function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const inbound = payload.find((p) => p.name === "tokensIn")?.value ?? 0;
  const outbound = payload.find((p) => p.name === "tokensOut")?.value ?? 0;
  return (
    <div className="rounded-md border bg-popover/95 backdrop-blur-sm px-2.5 py-2 text-[11px] shadow-md">
      <div className="font-mono text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="size-2 rounded-sm" style={{ background: BRAND }} />
        <span className="text-muted-foreground">in</span>
        <span className="ml-auto font-mono tabular-nums">
          {inbound.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="size-2 rounded-sm" style={{ background: MUTED }} />
        <span className="text-muted-foreground">out</span>
        <span className="ml-auto font-mono tabular-nums">
          {outbound.toLocaleString()}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t pt-1">
        <span className="text-muted-foreground">total</span>
        <span className="ml-auto font-mono tabular-nums">
          {(inbound + outbound).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------- sections -------------------------------- */

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
}

function StatCard({ label, value, icon: Icon }: StatCardProps) {
  return (
    <Card className="p-4 gap-0 transition-transform hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <Icon className="size-4 text-brand" aria-hidden="true" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </Card>
  );
}

function TotalsRow({ totals }: { totals: UsageResponse["totals"] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Conversations"
        value={totals.conversations.toLocaleString()}
        icon={MessageSquare}
      />
      <StatCard
        label="Messages"
        value={totals.messages.toLocaleString()}
        icon={FileText}
      />
      <StatCard
        label="Tokens used"
        value={totals.tokens.toLocaleString()}
        icon={Coins}
      />
      <StatCard
        label="Tool executions"
        value={totals.toolExecutions.toLocaleString()}
        icon={Wrench}
      />
    </div>
  );
}

function TotalsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} className="p-4 gap-0">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="size-4 rounded-sm" />
          </div>
          <Skeleton className="mt-3 h-7 w-16" />
        </Card>
      ))}
    </div>
  );
}

function TokenChart({ days }: { days: TokenDay[] }) {
  const allZero = days.every((d) => d.total === 0);
  const data = React.useMemo(
    () =>
      days.map((d) => ({
        date: shortWeekday(d.date),
        tokensIn: d.tokensIn,
        tokensOut: d.tokensOut,
        total: d.total,
      })),
    [days],
  );

  return (
    <Card className="p-4 gap-0">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">
          Token usage · last 7 days
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{ background: BRAND }}
              aria-hidden="true"
            />
            input
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{ background: MUTED }}
              aria-hidden="true"
            />
            output
          </span>
        </div>
      </div>

      <div className="mt-3" style={{ height: 220 }}>
        {allZero ? (
          <div
            className="flex h-full items-center justify-center text-center"
            role="status"
          >
            <div className="max-w-xs space-y-1">
              <BarChart3 className="mx-auto size-5 text-muted-foreground/60" />
              <p className="text-xs text-muted-foreground">
                No usage yet. Start a conversation to see your stats.
              </p>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 4, right: 4, bottom: 0, left: -16 }}
              barCategoryGap="22%"
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="oklch(0.92 0 0)"
                strokeOpacity={0.6}
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: "oklch(0.55 0 0)" }}
                tickMargin={6}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: "oklch(0.55 0 0)" }}
                tickFormatter={fmtAxis}
                width={44}
              />
              <Tooltip
                cursor={{ fill: "oklch(0.5 0 0 / 0.06)" }}
                content={<ChartTooltip />}
              />
              <Bar
                dataKey="tokensIn"
                stackId="tokens"
                fill={BRAND}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="tokensOut"
                stackId="tokens"
                fill={MUTED}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function ChartSkeleton() {
  return (
    <Card className="p-4 gap-0">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="mt-3 h-[220px] w-full" />
    </Card>
  );
}

interface BreakdownRow {
  label: string;
  count: number;
}

function BreakdownList({
  rows,
  emptyHint,
  max,
}: {
  rows: BreakdownRow[];
  emptyHint: string;
  max: number;
}) {
  if (rows.length === 0) return null;
  const top = rows.slice(0, max);
  const maxCount = top[0]?.count ?? 1;
  return (
    <div className="space-y-1.5">
      {top.map((r) => {
        const pct = maxCount > 0 ? (r.count / maxCount) * 100 : 0;
        return (
          <div key={r.label} className="flex items-center gap-2">
            <div className="w-28 shrink-0 truncate font-mono text-[11px] text-foreground/80">
              {r.label}
            </div>
            <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-muted/60">
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${pct}%`, background: BRAND }}
                aria-hidden="true"
              />
            </div>
            <div className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
              {r.count.toLocaleString()}
            </div>
          </div>
        );
      })}
      {rows.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground italic">
          {emptyHint}
        </p>
      )}
    </div>
  );
}

function BreakdownSkeleton() {
  return (
    <div className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- component ------------------------------- */

export function UsageSettings() {
  const usageQuery = useQuery<UsageResponse>({
    queryKey: ["stats", "usage"],
    queryFn: () => apiGet<UsageResponse>("/api/stats/usage"),
  });

  const tokensQuery = useQuery<TokensResponse>({
    queryKey: ["stats", "tokens"],
    queryFn: () => apiGet<TokensResponse>("/api/stats/tokens"),
  });

  const refresh = () => {
    void usageQuery.refetch();
    void tokensQuery.refetch();
  };

  const refreshing = usageQuery.isFetching || tokensQuery.isFetching;

  const usageError = usageQuery.error;
  const tokensError = tokensQuery.error;
  const hasError = Boolean(usageError || tokensError);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Usage</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Aggregate activity across all your conversations. Tokens combine
            input and output across every message.
          </p>
        </div>
        <UITooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh usage stats"
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-[11px]">
            Reload stats from the server
          </TooltipContent>
        </UITooltip>
      </div>

      {/* Totals row */}
      {usageQuery.isLoading ? (
        <TotalsSkeleton />
      ) : usageQuery.data ? (
        <TotalsRow totals={usageQuery.data.totals} />
      ) : null}

      {/* 7-day token chart */}
      {tokensQuery.isLoading ? (
        <ChartSkeleton />
      ) : tokensQuery.data ? (
        <TokenChart days={tokensQuery.data.days} />
      ) : null}

      {/* Breakdowns — provider + model. Hidden entirely when empty. */}
      <div className="grid gap-5 sm:grid-cols-2">
        <Card className="p-4 gap-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            By provider
          </div>
          <div className="mt-3">
            {usageQuery.isLoading ? (
              <BreakdownSkeleton />
            ) : usageQuery.data && usageQuery.data.byProvider.length > 0 ? (
              <BreakdownList
                rows={usageQuery.data.byProvider.map((p) => ({
                  label: p.provider,
                  count: p.count,
                }))}
                emptyHint="No provider activity yet."
                max={8}
              />
            ) : (
              <p className="px-1 py-1 text-[11px] text-muted-foreground italic">
                No provider activity yet.
              </p>
            )}
          </div>
        </Card>

        <Card className="p-4 gap-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            By model · top 5
          </div>
          <div className="mt-3">
            {usageQuery.isLoading ? (
              <BreakdownSkeleton />
            ) : usageQuery.data && usageQuery.data.byModel.length > 0 ? (
              <BreakdownList
                rows={usageQuery.data.byModel.map((m) => ({
                  label: m.model,
                  count: m.count,
                }))}
                emptyHint="No model activity yet."
                max={5}
              />
            ) : (
              <p className="px-1 py-1 text-[11px] text-muted-foreground italic">
                No model activity yet.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Error banner — shown only when a fetch fails AND we have no data. */}
      {hasError && (
        <div
          role="alert"
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs",
          )}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-destructive">
              Couldn&apos;t load usage stats.
            </span>
            <button
              type="button"
              onClick={refresh}
              className="ml-auto text-[11px] text-brand hover:underline"
            >
              Try again
            </button>
          </div>
          {(usageError || tokensError) instanceof Error && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {(usageError ?? tokensError)?.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

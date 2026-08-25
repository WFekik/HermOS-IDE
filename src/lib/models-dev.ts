import * as path from "path";
import * as os from "os";
import * as fsSync from "fs";
import { promises as fs } from "fs";
import {
  reasoningCapsFromRegistryEntry,
  type RegistryReasoningInfo,
} from "@/lib/reasoning/registry-caps";
export { reasoningCapsFromRegistryEntry, type RegistryReasoningInfo };

interface ModelEntry {
  limit?: { context?: number; output?: number };
  /** Official per-model reasoning support flag from the models.dev registry. */
  reasoning?: boolean;
  /** models.dev `reasoning_options`: [{type:"effort", values:[...]}] or [] = no advertised control. */
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
  /** models.dev `interleaved.field` (e.g. "reasoning_content") — the field used
   *  to echo reasoning content back on assistant messages. */
  interleaved?: { field?: string };
}

interface ProviderEntry {
  models?: Record<string, ModelEntry>;
}

type RegistryEntry = {
  contextWindow: number;
  maxOutput?: number;
  reasoning?: boolean;
  /** Effort values from models.dev `reasoning_options` (`[]` = no user-controllable options). */
  reasoningOptions?: string[];
  interleavedField?: string;
};

type Registry = Map<string, RegistryEntry>;

const CACHE_PATH = path.join(os.tmpdir(), ".hermos", "models-dev-v4.json");
const TTL = 5 * 60 * 1000;

interface DiskCache {
  /** Epoch ms when this cache was written (enforces the TTL on load). */
  ts: number;
  entries: [string, RegistryEntry][];
}

let cached: { registry: Registry; normalizedIndex: Map<string, string[]>; ts: number } | null = null;
let fetchInFlight: Promise<Registry> | null = null;

/** Resets in-memory and disk registry caches for test isolation. */
export function resetRegistryCache(): void {
  cached = null;
  fetchInFlight = null;
  try {
    fsSync.unlinkSync(CACHE_PATH);
  } catch {}
}

/** Scopes provider ID for reasoning capabilities; gateways map to "custom" to avoid invalid vendor facts. */
function registryScopeProvider(providerId?: string): string | undefined {
  if (providerId === "nvidia" || providerId === "zen") return "custom";
  return providerId;
}

/** Scopes provider ID for core capacity (context window / max output); allows real gateway entries like nvidia. */
function registryCoreScopeProvider(providerId?: string): string | undefined {
  if (providerId === "nvidia") return "nvidia";
  return registryScopeProvider(providerId);
}

async function loadDiskCache(): Promise<{ registry: Registry; normalizedIndex: Map<string, string[]> } | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DiskCache>;
    // Ignore stale (past TTL) or unversioned disk payloads.
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > TTL) return null;
    if (!Array.isArray(parsed.entries)) return null;
    const registry = new Map(parsed.entries);
    const normalizedIndex = buildNormalizedIndex(registry);
    return { registry, normalizedIndex };
  } catch {
    return null;
  }
}

async function saveDiskCache(registry: Registry): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const payload: DiskCache = { ts: Date.now(), entries: [...registry] };
    await fs.writeFile(CACHE_PATH, JSON.stringify(payload), "utf-8");
  } catch { /* best-effort */ }
}

/** Normalizes a model ID by stripping organization prefixes and lowercasing for cross-provider matching. */
export function normalizeModelId(id: string): string {
  const slashIndex = id.indexOf("/");
  const modelPart = slashIndex >= 0 ? id.slice(slashIndex + 1) : id;
  return modelPart.toLowerCase();
}

/** Builds an index of composite registry keys mapped by normalized model ID to avoid cross-provider collisions. */
function buildNormalizedIndex(registry: Registry): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const key of registry.keys()) {
    // Composite keys are `${providerId}/${id}` — the id may itself contain
    // slashes (`thinkingmachines/inkling`), so strip only the provider part.
    const slashIndex = key.indexOf("/");
    const idPart = slashIndex >= 0 ? key.slice(slashIndex + 1) : key;
    const normalized = normalizeModelId(idPart);
    const list = index.get(normalized) ?? [];
    list.push(key);
    index.set(normalized, list);
  }
  return index;
}

async function fetchRegistry(): Promise<Registry> {
  const resp = await fetch("https://models.dev/api.json", {
    headers: { "User-Agent": "HermOS/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`models.dev returned ${resp.status}`);
  const data = await resp.json() as Record<string, ProviderEntry>;
  const map: Registry = new Map();
  for (const [providerId, p] of Object.entries(data)) {
    for (const [id, m] of Object.entries(p.models || {})) {
      // Composite key `${providerId}/${id}` preserves per-provider model facts.
      const key = `${providerId}/${id}`;
      const entry: RegistryEntry = {
        contextWindow: m.limit?.context && m.limit.context > 0 ? m.limit.context : 0,
        maxOutput: m.limit?.output && m.limit.output > 0 ? m.limit.output : undefined,
      };
      if (typeof m.reasoning === "boolean") entry.reasoning = m.reasoning;
      // Extract effort values; an empty list indicates no user-controllable options.
      if (Array.isArray(m.reasoning_options)) {
        entry.reasoningOptions = m.reasoning_options
          .filter((o) => o?.type === "effort" && Array.isArray(o.values))
          .flatMap((o) => o.values ?? []);
      }
      if (typeof m.interleaved?.field === "string" && m.interleaved.field.trim()) {
        entry.interleavedField = m.interleaved.field;
      }
      if (entry.contextWindow > 0 || entry.reasoning !== undefined || entry.reasoningOptions !== undefined) {
        map.set(key, entry);
      }
    }
  }
  return map;
}

/** Fetches models.dev registry, deduplicating concurrent requests via a shared in-flight promise. */
function fetchRegistryShared(): Promise<Registry> {
  if (!fetchInFlight) {
    fetchInFlight = fetchRegistry().finally(() => {
      fetchInFlight = null;
    });
  }
  return fetchInFlight;
}

/** Install a freshly-fetched registry into the memory + disk caches. */
async function installRegistry(registry: Registry): Promise<void> {
  cached = { registry, normalizedIndex: buildNormalizedIndex(registry), ts: Date.now() };
  await saveDiskCache(registry);
}

/** Asynchronously warms the registry cache without blocking caller execution. */
export function warmRegistryCache(): void {
  void fetchRegistryShared()
    .then(installRegistry)
    .catch(() => { /* keep whatever caches hold; retry on next warm */ });
}

/** Registry lookup result — every field optional; `{}` means unknown. */
export interface RegistryModelInfo extends RegistryReasoningInfo {
  contextWindow?: number;
  maxOutput?: number;
}

function resolveEntry(
  registry: Registry,
  normalizedIndex: Map<string, string[]>,
  modelId: string,
  providerId?: string,
  core?: boolean,
): RegistryModelInfo | null {
  const toOut = (e: RegistryEntry): RegistryModelInfo => ({
    contextWindow: e.contextWindow > 0 ? e.contextWindow : undefined,
    maxOutput: e.maxOutput,
    reasoning: e.reasoning,
    reasoningOptions: e.reasoningOptions,
    interleavedField: e.interleavedField,
  });
  const scope = core ? registryCoreScopeProvider(providerId) : registryScopeProvider(providerId);
  // 1. Exact provider-scoped match (fast path)
  if (providerId) {
    const exact = registry.get(`${scope}/${modelId}`);
    if (exact) return core ? coreOnly(toOut(exact)) : toOut(exact);
  }
  // 2. Normalized match for case/separator differences; provider-scoped match takes priority.
  const normalized = normalizeModelId(modelId);
  const candidates = normalizedIndex.get(normalized);
  if (candidates) {
    if (providerId) {
      const providerKey = candidates.find((k) => k.startsWith(`${scope}/`));
      if (providerKey) {
        const e = registry.get(providerKey);
        if (e) return core ? coreOnly(toOut(e)) : toOut(e);
      }
    }
    if (candidates.length === 1) {
      const e = registry.get(candidates[0]);
      if (e) return core ? coreOnly(toOut(e)) : toOut(e);
    }
    // 3. Core capacity fallback: pick candidate entry with the highest context window.
    if (core && candidates.length > 0) {
      let best: RegistryEntry | null = null;
      for (const k of candidates) {
        const e = registry.get(k);
        if (e && e.contextWindow > 0) {
          if (!best || e.contextWindow > best.contextWindow) {
            best = e;
          }
        }
      }
      if (best) return coreOnly(toOut(best));
    }
  }
  return null;
}

/** Keep only the core capacity facts of a registry entry (context window + max output). */
function coreOnly(info: RegistryModelInfo): RegistryModelInfo {
  const out: RegistryModelInfo = {};
  if (info.contextWindow !== undefined) out.contextWindow = info.contextWindow;
  if (info.maxOutput !== undefined) out.maxOutput = info.maxOutput;
  return out;
}

/** Non-blocking registry lookup against memory/disk caches; warms cache in background if cold. */
export async function peekModelInRegistry(
  modelId: string,
  providerId?: string,
  opts?: { core?: boolean },
): Promise<RegistryModelInfo> {
  const now = Date.now();

  // Memory cache still fresh
  if (cached && now - cached.ts < TTL) {
    return resolveEntry(cached.registry, cached.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
  }

  // Disk cache still fresh (fast file read, never network)
  const disk = await loadDiskCache();
  if (disk) {
    cached = { registry: disk.registry, normalizedIndex: disk.normalizedIndex, ts: now };
    return resolveEntry(disk.registry, disk.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
  }

  // Cold — warm in the background (one shared download for all concurrent
  // cold peeks, see fetchRegistryShared) and return unknown now.
  warmRegistryCache();
  return {};
}

/** Looks up model info in the models.dev registry, performing a blocking fetch if caches are cold. */
export async function lookupModelInRegistry(
  modelId: string,
  providerId?: string,
  opts?: { core?: boolean },
): Promise<RegistryModelInfo> {
  const now = Date.now();

  // Memory cache still fresh
  if (cached && now - cached.ts < TTL) {
    return resolveEntry(cached.registry, cached.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
  }

  // Disk cache still fresh
  const disk = await loadDiskCache();
  if (disk) {
    cached = { registry: disk.registry, normalizedIndex: disk.normalizedIndex, ts: now };
    return resolveEntry(disk.registry, disk.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
  }

  // Fetch from remote, sharing in-flight download promise across concurrent callers.
  try {
    const registry = await fetchRegistryShared();
    await installRegistry(registry);
    return resolveEntry(registry, cached!.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
  } catch {
    // Remote failed — use whatever we have cached
    if (cached) {
      return resolveEntry(cached.registry, cached.normalizedIndex, modelId, registryScopeProvider(providerId), opts?.core) ?? {};
    }
    return {};
  }
}

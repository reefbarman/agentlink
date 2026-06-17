/**
 * Host-neutral catalog of Anthropic model capabilities.
 *
 * Owns the dynamic model data fetched from the Anthropic SDK's `models.list()`,
 * merged over a static base, and read through synchronous getters by
 * AnthropicProvider. Imports **no** `vscode` — persistence is injected via a port
 * so this module stays host-neutral and unit-testable (external-agent-core RFC).
 *
 * Design: plans/target-a-anthropic-dynamic-model-capabilities.md
 */

import type {
  ModelCapabilities,
  ModelInfo,
  ReasoningEffort,
} from "../types.js";

/** Anthropic-specific capability shape used by the provider (adds thinking-mode flags). */
export interface AnthropicModelCapabilities extends ModelCapabilities {
  supportsThinking: boolean;
  /** Whether the model supports the "adaptive" thinking request shape. */
  supportsAdaptiveThinking?: boolean;
}

/** A static model entry (id + display name + capabilities) used as merge base + fallback. */
export interface StaticModelEntry {
  id: string;
  displayName: string;
  capabilities: AnthropicModelCapabilities;
}

/**
 * Minimal subset of the Anthropic SDK `CapabilitySupport`/`ModelInfo` shapes we
 * read. Declared locally so the catalog does not depend on SDK type identity and
 * stays trivially mockable.
 */
interface SdkCapabilitySupport {
  supported: boolean;
}

interface SdkEffortCapability {
  supported: boolean;
  low?: SdkCapabilitySupport | null;
  medium?: SdkCapabilitySupport | null;
  high?: SdkCapabilitySupport | null;
  max?: SdkCapabilitySupport | null;
  xhigh?: SdkCapabilitySupport | null;
}

interface SdkThinkingCapability {
  supported: boolean;
  types?: {
    adaptive?: SdkCapabilitySupport | null;
    enabled?: SdkCapabilitySupport | null;
  } | null;
}

interface SdkModelCapabilities {
  image_input?: SdkCapabilitySupport | null;
  effort?: SdkEffortCapability | null;
  thinking?: SdkThinkingCapability | null;
}

export interface SdkModelInfo {
  id: string;
  display_name?: string | null;
  capabilities?: SdkModelCapabilities | null;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
}

/** Persisted snapshot of the dynamic catalog. Versioned so stale schemas are ignored. */
export interface AnthropicModelCatalogSnapshot {
  schemaVersion: number;
  fetchedAt: number;
  models: Array<{
    id: string;
    displayName: string;
    capabilities: AnthropicModelCapabilities;
  }>;
}

/** Injected persistence port (e.g. backed by VS Code globalState in the host layer). */
export interface ModelCatalogPersistence {
  load(): AnthropicModelCatalogSnapshot | undefined;
  save(snapshot: AnthropicModelCatalogSnapshot): void;
}

/** Async SDK surface the catalog needs (a thin slice of `client.models`). */
export interface AnthropicModelsApi {
  list(): Promise<{ data: SdkModelInfo[] }> | AsyncIterable<SdkModelInfo>;
}

export const ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION = 1;

/** Default auto-refresh TTL (Q2: 6h). Stale only gates refresh, never read. */
export const ANTHROPIC_MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Model IDs returned by `models.list()` that we must NOT surface in the picker
 * or background routing, because they exist platform-wide but are not callable
 * for typical accounts (e.g. ZDR / Covered Model entitlement gaps). The Anthropic
 * Models API has no per-account availability field, so this is a manual list.
 *
 * `claude-fable-5` is a "Covered Model" requiring 30-day data retention and is
 * unavailable under zero-data-retention; calling it returns an error pointing to
 * Opus 4.8. It was also temporarily disabled around release due to a US national
 * security review.
 *
 * TODO: revisit — recheck availability over time and drop entries once these
 * models are generally callable (ideally replace this with a real entitlement
 * signal or a learn-from-failure mechanism if the API still lacks one).
 */
export const ANTHROPIC_MODEL_BLOCKLIST = new Set<string>([
  "claude-fable-5",
  "claude-mythos-5",
]);

const SDK_EFFORT_TO_REASONING: Array<{
  key: keyof Omit<SdkEffortCapability, "supported">;
  effort: ReasoningEffort;
}> = [
  { key: "low", effort: "low" },
  { key: "medium", effort: "medium" },
  { key: "high", effort: "high" },
  { key: "xhigh", effort: "xhigh" },
  { key: "max", effort: "max" },
];

function isSupported(value: SdkCapabilitySupport | null | undefined): boolean {
  return Boolean(value && value.supported);
}

/**
 * Map SDK effort capability flags to our `ReasoningEffort[]`.
 *
 * Preserves current UI semantics (design §3.4):
 * - returns `undefined` when capabilities are absent / effort or thinking
 *   unsupported (matches today's Haiku, which has no `reasoningEfforts`);
 * - otherwise returns `["none", ...supported levels]`.
 */
export function mapReasoningEfforts(
  capabilities: SdkModelCapabilities | null | undefined,
): ReasoningEffort[] | undefined {
  if (!capabilities) return undefined;
  const { effort, thinking } = capabilities;
  if (!effort || !effort.supported) return undefined;
  if (!thinking || !thinking.supported) return undefined;

  const levels: ReasoningEffort[] = ["none"];
  for (const { key, effort: mapped } of SDK_EFFORT_TO_REASONING) {
    if (isSupported(effort[key])) {
      levels.push(mapped);
    }
  }
  // Only "none" means no real reasoning levels were advertised — omit to match
  // current non-thinking UI semantics rather than emitting a ["none"]-only list.
  return levels.length > 1 ? levels : undefined;
}

/**
 * Translate an SDK model into our Anthropic capability shape, falling back to a
 * static base entry for fields the SDK does not express or returns null for
 * (merge precedence — design §3.4/§3.5).
 */
export function mapSdkModelToCapabilities(
  sdk: SdkModelInfo,
  staticBase: AnthropicModelCapabilities | undefined,
): AnthropicModelCapabilities {
  const base: AnthropicModelCapabilities = staticBase
    ? { ...staticBase }
    : {
        supportsThinking: false,
        supportsCaching: true,
        supportsImages: true,
        supportsToolUse: true,
        contextWindow: 200_000,
        maxOutputTokens: 128_000,
      };

  const caps = sdk.capabilities ?? null;

  // Token envelopes: trust SDK directly (Q4), never let null clobber static.
  const contextWindow =
    typeof sdk.max_input_tokens === "number"
      ? sdk.max_input_tokens
      : base.contextWindow;
  const maxInputTokens =
    typeof sdk.max_input_tokens === "number"
      ? sdk.max_input_tokens
      : base.maxInputTokens;
  const maxOutputTokens =
    typeof sdk.max_tokens === "number" ? sdk.max_tokens : base.maxOutputTokens;

  // Capability flags: overlay only when the SDK expresses them.
  const supportsImages = caps?.image_input
    ? isSupported(caps.image_input)
    : base.supportsImages;
  const supportsThinking = caps?.thinking
    ? Boolean(caps.thinking.supported)
    : base.supportsThinking;
  const supportsAdaptiveThinking = caps?.thinking?.types?.adaptive
    ? isSupported(caps.thinking.types.adaptive)
    : base.supportsAdaptiveThinking;

  const mappedEfforts = mapReasoningEfforts(caps);
  const reasoningEfforts = mappedEfforts ?? base.reasoningEfforts;

  return {
    supportsThinking,
    supportsAdaptiveThinking,
    supportsCaching: base.supportsCaching,
    supportsImages,
    supportsToolUse: base.supportsToolUse,
    contextWindow,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    maxOutputTokens,
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(base.defaultReasoningEffort
      ? { defaultReasoningEffort: base.defaultReasoningEffort }
      : {}),
  };
}

interface CatalogEntry {
  id: string;
  displayName: string;
  capabilities: AnthropicModelCapabilities;
  /** Present in the most recent successful `models.list()`. */
  listed: boolean;
}

export interface AnthropicModelCatalogOptions {
  providerId: string;
  staticModels: StaticModelEntry[];
  persistence?: ModelCatalogPersistence;
  ttlMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * Owns the merged static+dynamic model set and exposes synchronous reads plus an
 * async refresh. Sync getters never trigger network; refresh is lazy/coalesced.
 */
export class AnthropicModelCatalog {
  private readonly providerId: string;
  private readonly staticEntries: Map<string, StaticModelEntry>;
  private readonly persistence?: ModelCatalogPersistence;
  private readonly ttlMs: number;
  private readonly log?: (msg: string) => void;
  private readonly now: () => number;

  /** Dynamic merged entries keyed by model id. Empty until first refresh/seed. */
  private dynamic = new Map<string, CatalogEntry>();
  private lastRefreshedAt: number | undefined;
  private inFlight: Promise<ModelInfo[]> | undefined;

  constructor(options: AnthropicModelCatalogOptions) {
    this.providerId = options.providerId;
    this.staticEntries = new Map(
      options.staticModels.map((entry) => [entry.id, entry]),
    );
    this.persistence = options.persistence;
    this.ttlMs = options.ttlMs ?? ANTHROPIC_MODEL_CATALOG_TTL_MS;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.seedFromSnapshot();
  }

  /** Seed sync getters from a persisted snapshot if schema matches. No network. */
  private seedFromSnapshot(): void {
    const snapshot = this.persistence?.load();
    if (!snapshot) return;
    if (snapshot.schemaVersion !== ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION) {
      this.log?.(
        `[anthropic] ignoring model catalog snapshot: schema ${snapshot.schemaVersion} != ${ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION}`,
      );
      return;
    }
    for (const model of snapshot.models) {
      // Don't resurrect blocklisted models from an older snapshot.
      if (ANTHROPIC_MODEL_BLOCKLIST.has(model.id)) continue;
      this.dynamic.set(model.id, {
        id: model.id,
        displayName: model.displayName,
        capabilities: model.capabilities,
        listed: true,
      });
    }
    this.lastRefreshedAt = snapshot.fetchedAt;
  }

  /** True when the catalog has no fresh dynamic data (drives lazy refresh). */
  hasFreshData(): boolean {
    if (this.lastRefreshedAt === undefined) return false;
    return this.now() - this.lastRefreshedAt < this.ttlMs;
  }

  /** Whether any dynamic data is present (regardless of TTL — last-good is valid). */
  hasDynamicData(): boolean {
    return this.dynamic.size > 0;
  }

  /**
   * Synchronous capability read: merged dynamic entry if present, else static,
   * else undefined (provider applies its own DEFAULT fallback).
   */
  getCapabilities(model: string): AnthropicModelCapabilities | undefined {
    return (
      this.dynamic.get(model)?.capabilities ??
      this.staticEntries.get(model)?.capabilities
    );
  }

  /**
   * Synchronous, picker-visible model list (design Q6: pure `list()`-driven).
   * When dynamic data exists, returns only the models present in the most
   * recent successful `models.list()`. Static models omitted by `list()` are
   * hidden from the picker but remain routable via `listRoutableModelIds()`
   * (§0.2). Before any refresh, returns the static set.
   */
  listModels(): ModelInfo[] {
    if (this.dynamic.size === 0) {
      return [...this.staticEntries.values()].map((entry) =>
        this.toModelInfo(entry.id, entry.displayName, entry.capabilities),
      );
    }

    const result: ModelInfo[] = [];
    for (const entry of this.dynamic.values()) {
      if (!entry.listed) continue;
      result.push(
        this.toModelInfo(entry.id, entry.displayName, entry.capabilities),
      );
    }
    return result;
  }

  /**
   * All model IDs that must remain routable: the picker-visible set plus every
   * static model as a routing floor so persisted-session IDs always resolve
   * even when omitted from a successful `list()` (§0.2).
   */
  listRoutableModelIds(): string[] {
    const ids = new Set<string>(this.staticEntries.keys());
    for (const entry of this.dynamic.values()) {
      if (entry.listed) ids.add(entry.id);
    }
    return [...ids];
  }

  private toModelInfo(
    id: string,
    displayName: string,
    capabilities: AnthropicModelCapabilities,
  ): ModelInfo {
    return { id, displayName, provider: this.providerId, capabilities };
  }

  /** Whether the named model supports adaptive thinking (dynamic, static fallback). */
  supportsAdaptiveThinking(model: string): boolean {
    const dynamic = this.dynamic.get(model);
    if (
      dynamic &&
      dynamic.capabilities.supportsAdaptiveThinking !== undefined
    ) {
      return Boolean(dynamic.capabilities.supportsAdaptiveThinking);
    }
    const staticEntry = this.staticEntries.get(model);
    return Boolean(staticEntry?.capabilities.supportsAdaptiveThinking);
  }

  /**
   * Refresh from the SDK. Coalesces concurrent calls into one in-flight promise.
   * On failure/empty, keeps last-good dynamic data (or static via getters).
   * Returns the merged model list.
   */
  async refresh(modelsApi: AnthropicModelsApi): Promise<ModelInfo[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh(modelsApi).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(modelsApi: AnthropicModelsApi): Promise<ModelInfo[]> {
    let sdkModels: SdkModelInfo[];
    try {
      sdkModels = await collectSdkModels(modelsApi);
    } catch (err) {
      this.log?.(
        `[anthropic] model catalog refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.listModels();
    }

    if (sdkModels.length === 0) {
      this.log?.(
        "[anthropic] model catalog refresh returned no models; keeping last-good/static",
      );
      return this.listModels();
    }

    const next = new Map<string, CatalogEntry>();
    const listedIds = new Set<string>();
    for (const sdk of sdkModels) {
      if (!sdk.id) continue;
      // Skip models that are listed platform-wide but not callable for the
      // account (e.g. claude-fable-5). They must not reach the picker, the
      // routing floor, or background model routing.
      if (ANTHROPIC_MODEL_BLOCKLIST.has(sdk.id)) {
        this.log?.(
          `[anthropic] model "${sdk.id}" is blocklisted (not callable for this account); hiding from picker/routing`,
        );
        continue;
      }
      listedIds.add(sdk.id);
      const staticBase = this.staticEntries.get(sdk.id)?.capabilities;
      const staticName = this.staticEntries.get(sdk.id)?.displayName;
      next.set(sdk.id, {
        id: sdk.id,
        displayName: sdk.display_name?.trim() || staticName || sdk.id,
        capabilities: mapSdkModelToCapabilities(sdk, staticBase),
        listed: true,
      });
    }

    // Retired detection (Q3, log-only): static IDs missing from a successful list.
    for (const entry of this.staticEntries.values()) {
      if (!listedIds.has(entry.id)) {
        this.log?.(
          `[anthropic] model "${entry.id}" not in models.list(); treating as retired (still routable)`,
        );
      }
    }

    this.dynamic = next;
    this.lastRefreshedAt = this.now();
    this.persist();
    return this.listModels();
  }

  private persist(): void {
    if (!this.persistence) return;
    const snapshot: AnthropicModelCatalogSnapshot = {
      schemaVersion: ANTHROPIC_MODEL_CATALOG_SCHEMA_VERSION,
      fetchedAt: this.lastRefreshedAt ?? this.now(),
      models: [...this.dynamic.values()].map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
      })),
    };
    try {
      this.persistence.save(snapshot);
    } catch (err) {
      this.log?.(
        `[anthropic] failed to persist model catalog snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Normalize the SDK list result to an array. The Anthropic SDK page-promise is
 * both promise-like and async-iterable (auto-paginating). Prefer async
 * iteration so paginated model lists are fully collected; fall back to the
 * `{ data }` page shape for simpler mocks.
 */
async function collectSdkModels(
  modelsApi: AnthropicModelsApi,
): Promise<SdkModelInfo[]> {
  const result = modelsApi.list();

  if (isAsyncIterable<SdkModelInfo>(result)) {
    const models: SdkModelInfo[] = [];
    for await (const model of result) {
      models.push(model);
    }
    return models;
  }

  // Page-promise / plain promise shape: `{ data: SdkModelInfo[] }`.
  if (isPromiseLike<{ data: SdkModelInfo[] }>(result)) {
    const page = await result;
    return Array.isArray(page?.data) ? page.data : [];
  }

  return [];
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

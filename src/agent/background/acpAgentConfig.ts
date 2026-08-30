import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";

export const NATIVE_BACKGROUND_AGENT = "native:auto";
export const ACP_AGENT_PREFIX = "acp:";
export const MODEL_TARGET_PREFIX = "model:";
export const DEFAULT_ACP_INIT_TIMEOUT_MS = 10_000;

export interface AcpBackgroundAgentConfig {
  id: string;
  label: string;
  provider?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  initTimeoutMs: number;
  readonlyOnly: boolean;
}

/** Provider-map key used when the foreground provider has no explicit entry. */
export const REVIEW_TARGET_DEFAULT_KEY = "default";

export interface BackgroundReviewTargetEntry {
  target: string;
  effort?: string;
}

/**
 * Machine-scoped review backend selector, keyed by the lowercased foreground
 * provider ID with an optional `default` entry. Target and effort values are
 * kept raw so a typo only fails review routing instead of every background
 * spawn.
 */
export type BackgroundReviewTargetSetting = Readonly<
  Record<string, BackgroundReviewTargetEntry>
>;

export interface BackgroundAgentSettings {
  defaultAgent: string;
  reviewAgent: string;
  reviewTarget: BackgroundReviewTargetSetting;
  acpAgents: AcpBackgroundAgentConfig[];
}

export interface RawBackgroundAgentSettings {
  defaultAgent?: unknown;
  reviewAgent?: unknown;
  reviewTarget?: unknown;
  acpAgents?: unknown;
}

/** Resolved review backend selected by settings. */
export type BackgroundReviewTarget =
  | { kind: "native"; effort?: CoreReasoningEffort }
  | { kind: "acp"; reference: string }
  | { kind: "model"; modelId: string; effort?: CoreReasoningEffort }
  | { kind: "invalid"; value: string; reason?: string };

export function isAcpBackgroundAgentReference(
  value: string | undefined,
): value is `${typeof ACP_AGENT_PREFIX}${string}` {
  return Boolean(value?.trim().startsWith(ACP_AGENT_PREFIX));
}

export function isModelBackgroundTargetReference(
  value: string | undefined,
): value is `${typeof MODEL_TARGET_PREFIX}${string}` {
  return Boolean(value?.trim().startsWith(MODEL_TARGET_PREFIX));
}

export function parseAcpBackgroundAgentId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(ACP_AGENT_PREFIX)) return undefined;
  const id = trimmed.slice(ACP_AGENT_PREFIX.length).trim();
  return id || undefined;
}

export function parseModelBackgroundTargetId(
  value: string,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(MODEL_TARGET_PREFIX)) return undefined;
  const id = trimmed.slice(MODEL_TARGET_PREFIX.length).trim();
  return id || undefined;
}

export function parseBackgroundReviewTarget(
  settings: BackgroundAgentSettings,
  foregroundProvider?: string,
): BackgroundReviewTarget {
  // The map expresses preferences, not a whitelist: an unmapped foreground
  // provider uses the optional default entry, then the legacy review agent.
  const providerKey = foregroundProvider?.trim().toLowerCase();
  const entry =
    (providerKey ? settings.reviewTarget[providerKey] : undefined) ??
    settings.reviewTarget[REVIEW_TARGET_DEFAULT_KEY];
  if (!entry) {
    return settings.reviewAgent === NATIVE_BACKGROUND_AGENT
      ? { kind: "native" }
      : { kind: "acp", reference: settings.reviewAgent };
  }
  return parseReviewTargetEntry(entry);
}

function parseReviewTargetEntry(
  entry: BackgroundReviewTargetEntry,
): BackgroundReviewTarget {
  const { target } = entry;
  if (entry.effort !== undefined && !isCoreReasoningEffort(entry.effort)) {
    return {
      kind: "invalid",
      value: target,
      reason: `Unsupported effort "${entry.effort}".`,
    };
  }
  const effort = entry.effort as CoreReasoningEffort | undefined;

  if (target === NATIVE_BACKGROUND_AGENT) {
    return { kind: "native", ...(effort ? { effort } : {}) };
  }
  if (isAcpBackgroundAgentReference(target)) {
    if (!parseAcpBackgroundAgentId(target)) {
      return { kind: "invalid", value: target };
    }
    if (effort) {
      return {
        kind: "invalid",
        value: target,
        reason:
          "ACP review agents control their own reasoning effort; remove effort.",
      };
    }
    return { kind: "acp", reference: target };
  }
  if (isModelBackgroundTargetReference(target)) {
    const modelId = parseModelBackgroundTargetId(target);
    return modelId
      ? { kind: "model", modelId, ...(effort ? { effort } : {}) }
      : { kind: "invalid", value: target };
  }
  return { kind: "invalid", value: target };
}

function normalizeReviewTarget(value: unknown): BackgroundReviewTargetSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const map: Record<string, BackgroundReviewTargetEntry> = {};
  for (const [provider, entry] of Object.entries(value)) {
    const key = provider.trim().toLowerCase();
    if (!key) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `agentlink.background.reviewTarget.${provider} must be an object with a target.`,
      );
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.target !== "string" || !raw.target.trim()) {
      throw new Error(
        `agentlink.background.reviewTarget.${provider}.target must be a non-empty string.`,
      );
    }
    if (raw.effort !== undefined && typeof raw.effort !== "string") {
      throw new Error(
        `agentlink.background.reviewTarget.${provider}.effort must be a string.`,
      );
    }
    map[key] = {
      target: raw.target.trim(),
      ...(raw.effort === undefined ? {} : { effort: raw.effort.trim() }),
    };
  }
  return map;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `ACP background agent ${field} must be an array of strings.`,
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(
        `ACP background agent ${field}[${index}] must be a string.`,
      );
    }
    return item;
  });
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACP background agent env must be an object of strings.");
  }

  const out: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      throw new Error(`ACP background agent env.${key} must be a string.`);
    }
    out[key] = envValue;
  }
  return out;
}

function normalizeInitTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_ACP_INIT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      "ACP background agent initTimeoutMs must be a positive number.",
    );
  }
  return Math.trunc(value);
}

function normalizeReadonlyOnly(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new Error("ACP background agent readonlyOnly must be a boolean.");
  }
  return value;
}

function normalizeAcpAgent(
  raw: unknown,
  index: number,
): AcpBackgroundAgentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`ACP background agent entry ${index} must be an object.`);
  }

  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) throw new Error(`ACP background agent entry ${index} requires id.`);
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(
      `ACP background agent id "${id}" may only contain letters, numbers, dot, underscore, or dash.`,
    );
  }

  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!command) {
    throw new Error(`ACP background agent "${id}" requires command.`);
  }

  const label =
    typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : id;
  const provider =
    typeof obj.provider === "string" && obj.provider.trim()
      ? obj.provider.trim().toLowerCase()
      : undefined;

  return {
    id,
    label,
    ...(provider ? { provider } : {}),
    command,
    args: normalizeStringArray(obj.args, "args"),
    env: normalizeEnv(obj.env),
    initTimeoutMs: normalizeInitTimeoutMs(obj.initTimeoutMs),
    readonlyOnly: normalizeReadonlyOnly(obj.readonlyOnly),
  };
}

export function normalizeBackgroundAgentSettings(
  raw: RawBackgroundAgentSettings,
): BackgroundAgentSettings {
  const normalizeAgentReference = (
    value: unknown,
    setting: "defaultAgent" | "reviewAgent",
  ): string => {
    const reference =
      typeof value === "string" && value.trim()
        ? value.trim()
        : NATIVE_BACKGROUND_AGENT;
    if (
      reference !== NATIVE_BACKGROUND_AGENT &&
      !isAcpBackgroundAgentReference(reference)
    ) {
      const label =
        setting === "defaultAgent" ? "default agent" : "review agent";
      throw new Error(
        `Unsupported background ${label} "${reference}". Use "native:auto" or "acp:<agent-id>".`,
      );
    }
    return reference;
  };

  const defaultAgent = normalizeAgentReference(
    raw.defaultAgent,
    "defaultAgent",
  );
  const reviewAgent = normalizeAgentReference(raw.reviewAgent, "reviewAgent");
  const reviewTarget = normalizeReviewTarget(raw.reviewTarget);

  const rawAgents = raw.acpAgents ?? [];
  if (!Array.isArray(rawAgents)) {
    throw new Error("agentlink.background.acpAgents must be an array.");
  }

  const acpAgents = rawAgents.map(normalizeAcpAgent);
  const seen = new Set<string>();
  for (const agent of acpAgents) {
    if (seen.has(agent.id)) {
      throw new Error(`Duplicate ACP background agent id "${agent.id}".`);
    }
    seen.add(agent.id);
  }

  return { defaultAgent, reviewAgent, reviewTarget, acpAgents };
}

export function resolveAcpBackgroundAgent(
  settings: BackgroundAgentSettings,
  reference: string,
): AcpBackgroundAgentConfig {
  const id = parseAcpBackgroundAgentId(reference);
  if (!id) {
    throw new Error(`Invalid ACP background agent reference "${reference}".`);
  }

  const agent = settings.acpAgents.find((candidate) => candidate.id === id);
  if (!agent) {
    throw new Error(`Unknown ACP background agent "${id}".`);
  }
  return agent;
}

export function redactAcpBackgroundAgentConfig(
  agent: AcpBackgroundAgentConfig,
): Omit<AcpBackgroundAgentConfig, "env"> & { env: Record<string, string> } {
  return {
    ...agent,
    env: Object.fromEntries(Object.keys(agent.env).map((key) => [key, "***"])),
  };
}

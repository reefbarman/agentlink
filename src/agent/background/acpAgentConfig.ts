export const NATIVE_BACKGROUND_AGENT = "native:auto";
export const ACP_AGENT_PREFIX = "acp:";
export const DEFAULT_ACP_INIT_TIMEOUT_MS = 10_000;

export interface AcpBackgroundAgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  initTimeoutMs: number;
  readonlyOnly: boolean;
}

export interface BackgroundAgentSettings {
  defaultAgent: string;
  acpAgents: AcpBackgroundAgentConfig[];
}

export interface RawBackgroundAgentSettings {
  defaultAgent?: unknown;
  acpAgents?: unknown;
}

export function isAcpBackgroundAgentReference(
  value: string | undefined,
): value is `${typeof ACP_AGENT_PREFIX}${string}` {
  return Boolean(value?.trim().startsWith(ACP_AGENT_PREFIX));
}

export function parseAcpBackgroundAgentId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(ACP_AGENT_PREFIX)) return undefined;
  const id = trimmed.slice(ACP_AGENT_PREFIX.length).trim();
  return id || undefined;
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

  return {
    id,
    label,
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
  const defaultAgent =
    typeof raw.defaultAgent === "string" && raw.defaultAgent.trim()
      ? raw.defaultAgent.trim()
      : NATIVE_BACKGROUND_AGENT;

  if (
    defaultAgent !== NATIVE_BACKGROUND_AGENT &&
    !isAcpBackgroundAgentReference(defaultAgent)
  ) {
    throw new Error(
      `Unsupported background default agent "${defaultAgent}". Use "native:auto" or "acp:<agent-id>".`,
    );
  }

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

  return { defaultAgent, acpAgents };
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

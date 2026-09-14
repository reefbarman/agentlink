import {
  isCodexModelServedOnChatgptBackend,
  listCodexModels,
} from "@agentlink/core/codex";
import {
  AGENTLINK_SHARED_KEYCHAIN_SERVICE,
  createKeychainSecretStorage,
} from "@agentlink/node-host";
import type { CliCompatibleProvider, CliConfig } from "./types.js";

import { promises as fs } from "node:fs";
import path from "node:path";

export const OPENAI_API_KEY_ACCOUNT = "openai-api-key:default";
export const COMPATIBLE_API_KEY_PREFIX = "openai-compatible-api-key:";

export const DEFAULT_CODEX_MODELS = listCodexModels("codex", "oauth")
  .filter((model) => isCodexModelServedOnChatgptBackend(model.id))
  .map((model) => model.id);
export const DEFAULT_OPENAI_MODELS = listCodexModels("openai", "apiKey").map(
  (model) => model.id,
);

const defaultConfig: CliConfig = {
  schemaVersion: 1,
  defaultModel: { providerId: "codex", modelId: "gpt-5.6-sol" },
  openAiModels: DEFAULT_OPENAI_MODELS,
  codexModels: DEFAULT_CODEX_MODELS,
  compatibleProviders: [],
};

export async function readCliConfig(dataRoot: string): Promise<CliConfig> {
  const configPath = path.join(dataRoot, "cli", "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return parseCliConfig(JSON.parse(raw));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return defaultConfig;
    throw error;
  }
}

export async function writeCliConfig(
  dataRoot: string,
  config: CliConfig,
): Promise<void> {
  const configPath = path.join(dataRoot, "cli", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.tmp.${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, configPath);
}

export async function getApiKey(account: string): Promise<string | undefined> {
  const storage = await createKeychainSecretStorage({ account });
  return (await storage.get())?.trim() || undefined;
}

export async function setApiKey(account: string, value: string): Promise<void> {
  const normalized = value.trim();
  if (!normalized) throw new Error("API key cannot be empty");
  const storage = await createKeychainSecretStorage({ account });
  await storage.store(normalized);
}

export function compatibleCredentialAccount(provider: { id: string }): string {
  return `${COMPATIBLE_API_KEY_PREFIX}${provider.id.trim()}`;
}

export function publicConfig(config: CliConfig): object {
  return {
    ...config,
    keychainService: AGENTLINK_SHARED_KEYCHAIN_SERVICE,
    openAiCredentialAccount: OPENAI_API_KEY_ACCOUNT,
  };
}

export function parseCliConfig(value: unknown): CliConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported AgentLink CLI configuration");
  }
  const defaultModel = value.defaultModel;
  if (
    !isRecord(defaultModel) ||
    typeof defaultModel.providerId !== "string" ||
    typeof defaultModel.modelId !== "string"
  ) {
    throw new Error("AgentLink CLI defaultModel is invalid");
  }
  return {
    schemaVersion: 1,
    defaultModel: {
      providerId: requiredText(
        defaultModel.providerId,
        "defaultModel.providerId",
      ),
      modelId: requiredText(defaultModel.modelId, "defaultModel.modelId"),
    },
    openAiModels: stringArray(value.openAiModels, "openAiModels"),
    codexModels: stringArray(value.codexModels, "codexModels"),
    compatibleProviders: compatibleProviders(value.compatibleProviders),
  };
}

function compatibleProviders(value: unknown): CliCompatibleProvider[] {
  if (!Array.isArray(value))
    throw new Error("compatibleProviders must be an array");
  return value.map((item, providerIndex) => {
    const label = `compatibleProviders[${providerIndex}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    const id = identifier(item.id, `${label}.id`);
    const baseURL = compatibleBaseUrl(item.baseURL, `${label}.baseURL`);
    const profile = optionalEnum(
      item.profile,
      ["generic", "openrouter"] as const,
      `${label}.profile`,
    );
    for (const key of ["noAuth", "allowInsecureHttp"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "boolean") {
        throw new Error(`${label}.${key} must be a boolean`);
      }
    }
    if (!Array.isArray(item.models) || item.models.length === 0) {
      throw new Error(`${label}.models must be a non-empty array`);
    }
    return {
      id,
      baseURL,
      ...(typeof item.displayName === "string" && item.displayName.trim()
        ? { displayName: item.displayName.trim() }
        : {}),
      ...(profile ? { profile } : {}),
      ...(item.noAuth === true ? { noAuth: true } : {}),
      ...(item.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
      models: item.models.map((model, modelIndex) =>
        compatibleModel(model, `${label}.models[${modelIndex}]`),
      ),
    };
  });
}

function compatibleModel(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const contextWindow = positiveInteger(
    value.contextWindow,
    `${label}.contextWindow`,
  );
  const maxOutputTokens = positiveInteger(
    value.maxOutputTokens,
    `${label}.maxOutputTokens`,
  );
  const maxInputTokens =
    value.maxInputTokens === undefined
      ? undefined
      : positiveInteger(value.maxInputTokens, `${label}.maxInputTokens`);
  if (maxInputTokens === undefined && contextWindow <= maxOutputTokens) {
    throw new Error(`${label}.contextWindow must exceed maxOutputTokens`);
  }
  for (const key of ["supportsToolUse", "supportsThinking"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  }
  return {
    id: identifier(value.id, `${label}.id`),
    ...(typeof value.model === "string" && value.model.trim()
      ? { model: value.model.trim() }
      : {}),
    ...(typeof value.displayName === "string" && value.displayName.trim()
      ? { displayName: value.displayName.trim() }
      : {}),
    contextWindow,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    maxOutputTokens,
    supportsToolUse: value.supportsToolUse === true,
    ...(value.supportsThinking === true ? { supportsThinking: true } : {}),
  };
}

function compatibleBaseUrl(value: unknown, label: string): string {
  const url = new URL(requiredText(value, label));
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${label} cannot contain credentials, a query, or a fragment`,
    );
  }
  return url.toString();
}

function identifier(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => requiredText(item, label));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must contain text`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

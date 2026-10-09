import type { WorkspaceProviderConfig } from "@agentlink/workspace-host";
import { createServerOriginPolicy } from "./requestGuard.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Standalone server configuration, read from one JSON file. Relative paths
 * resolve against the file's directory. Secrets never appear inline: API
 * keys come from a file or a systemd credential.
 */
export interface AssistantServerConfig {
  readonly schemaVersion: 1;
  /** Absolute. Holds access state (`server/`) and workspace data (`workspace/`). */
  readonly dataRoot: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly publicOrigins: readonly string[];
  readonly tls: { readonly certFile: string; readonly keyFile: string };
  readonly defaultModel: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly providers: readonly AssistantServerProviderConfig[];
  readonly projects: readonly AssistantServerProjectConfig[];
  /** Absolute ripgrep binary for `search_files`; built-in search otherwise. */
  readonly ripgrepPath?: string;
}

export interface AssistantServerProjectConfig {
  /** Stable URL identifier: lowercase letters, digits, and dashes. */
  readonly id: string;
  readonly label?: string;
  /** Absolute project directory. */
  readonly root: string;
}

/**
 * `file`: absolute path to a file holding only the key. `credential`: a
 * systemd credential name, read from `$CREDENTIALS_DIRECTORY/<name>`.
 */
export type AssistantServerSecretSource =
  | { readonly file: string }
  | { readonly credential: string };

export interface AssistantServerCompatibleModelConfig {
  readonly id: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly contextWindow: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens: number;
  readonly supportsToolUse: boolean;
  readonly supportsThinking?: boolean;
  readonly promptProfile?: "compatibility" | "reasoning";
}

export type AssistantServerProviderConfig =
  | {
      readonly type: "openai-compatible";
      readonly id: string;
      readonly displayName?: string;
      readonly baseURL: string;
      readonly profile?: "generic" | "openrouter";
      readonly apiKey?: AssistantServerSecretSource;
      readonly noAuth?: true;
      readonly allowInsecureHttp?: true;
      readonly meridianSessionAffinity?: true;
      readonly models: readonly AssistantServerCompatibleModelConfig[];
    }
  | {
      readonly type: "openai";
      readonly id?: string;
      readonly displayName?: string;
      readonly modelIds: readonly string[];
      readonly apiKey: AssistantServerSecretSource;
    };

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const MAX_SECRET_BYTES = 16 * 1024;

export async function loadAssistantServerConfig(
  configPath: string,
): Promise<AssistantServerConfig> {
  const absolute = path.resolve(configPath);
  let raw: string;
  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read server configuration ${absolute}: ${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Server configuration ${absolute} is not valid JSON`);
  }
  return parseAssistantServerConfig(parsed, path.dirname(absolute));
}

/** Validate a parsed configuration. Does not touch the filesystem. */
export function parseAssistantServerConfig(
  value: unknown,
  baseDirectory: string,
): AssistantServerConfig {
  const config = record(value, "configuration");
  if (config.schemaVersion !== 1) {
    throw new Error("Unsupported server configuration schemaVersion");
  }
  allowKeys(config, "configuration", [
    "schemaVersion",
    "dataRoot",
    "listen",
    "publicOrigins",
    "tls",
    "defaultModel",
    "providers",
    "projects",
    "ripgrepPath",
  ]);
  const resolvePath = (input: unknown, label: string) =>
    path.resolve(baseDirectory, text(input, label));

  const listen = record(config.listen, "listen");
  allowKeys(listen, "listen", ["host", "port"]);
  const port = listen.port;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("listen.port must be an integer from 1 to 65535");
  }

  if (!Array.isArray(config.publicOrigins)) {
    throw new Error("publicOrigins must be an array");
  }
  const publicOrigins = config.publicOrigins.map((origin, index) =>
    text(origin, `publicOrigins[${index}]`),
  );
  createServerOriginPolicy(publicOrigins);

  const tls = record(config.tls, "tls");
  allowKeys(tls, "tls", ["certFile", "keyFile"]);

  const defaultModel = record(config.defaultModel, "defaultModel");
  allowKeys(defaultModel, "defaultModel", ["providerId", "modelId"]);

  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error("providers must be a non-empty array");
  }
  const providers = config.providers.map((provider, index) =>
    parseProvider(provider, `providers[${index}]`, baseDirectory),
  );
  const providerIds = new Set<string>();
  for (const provider of providers) {
    const id = provider.id ?? provider.type;
    if (providerIds.has(id)) throw new Error(`Duplicate provider id: ${id}`);
    providerIds.add(id);
  }
  const parsedDefaultModel = {
    providerId: identifier(defaultModel.providerId, "defaultModel.providerId"),
    modelId: text(defaultModel.modelId, "defaultModel.modelId"),
  };
  if (!providerIds.has(parsedDefaultModel.providerId)) {
    throw new Error("defaultModel.providerId does not match a provider");
  }

  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw new Error("projects must be a non-empty array");
  }
  const projects = config.projects.map((project, index) => {
    const label = `projects[${index}]`;
    const item = record(project, label);
    allowKeys(item, label, ["id", "label", "root"]);
    const id = text(item.id, `${label}.id`);
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw new Error(
        `${label}.id must be lowercase letters, digits, and dashes`,
      );
    }
    return {
      id,
      ...(item.label === undefined
        ? {}
        : { label: text(item.label, `${label}.label`) }),
      root: resolvePath(item.root, `${label}.root`),
    };
  });
  const projectIds = new Set<string>();
  const projectRoots = new Set<string>();
  for (const project of projects) {
    if (projectIds.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    if (projectRoots.has(project.root)) {
      throw new Error(`Duplicate project root: ${project.root}`);
    }
    projectIds.add(project.id);
    projectRoots.add(project.root);
  }

  return {
    schemaVersion: 1,
    dataRoot: resolvePath(config.dataRoot, "dataRoot"),
    listen: { host: text(listen.host, "listen.host"), port: Number(port) },
    publicOrigins,
    tls: {
      certFile: resolvePath(tls.certFile, "tls.certFile"),
      keyFile: resolvePath(tls.keyFile, "tls.keyFile"),
    },
    defaultModel: parsedDefaultModel,
    providers,
    projects,
    ...(config.ripgrepPath === undefined
      ? {}
      : { ripgrepPath: resolvePath(config.ripgrepPath, "ripgrepPath") }),
  };
}

function parseProvider(
  value: unknown,
  label: string,
  baseDirectory: string,
): AssistantServerProviderConfig {
  const item = record(value, label);
  if (item.type === "openai") {
    allowKeys(item, label, ["type", "id", "displayName", "modelIds", "apiKey"]);
    if (!Array.isArray(item.modelIds) || item.modelIds.length === 0) {
      throw new Error(`${label}.modelIds must be a non-empty array`);
    }
    return {
      type: "openai",
      ...(item.id === undefined
        ? {}
        : { id: identifier(item.id, `${label}.id`) }),
      ...optionalDisplayName(item, label),
      modelIds: item.modelIds.map((id, index) =>
        text(id, `${label}.modelIds[${index}]`),
      ),
      apiKey: secretSource(item.apiKey, `${label}.apiKey`, baseDirectory),
    };
  }
  if (item.type !== "openai-compatible") {
    throw new Error(`${label}.type must be "openai-compatible" or "openai"`);
  }
  allowKeys(item, label, [
    "type",
    "id",
    "displayName",
    "baseURL",
    "profile",
    "apiKey",
    "noAuth",
    "allowInsecureHttp",
    "meridianSessionAffinity",
    "models",
  ]);
  for (const key of [
    "noAuth",
    "allowInsecureHttp",
    "meridianSessionAffinity",
  ] as const) {
    if (item[key] !== undefined && typeof item[key] !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  }
  const noAuth = item.noAuth === true;
  if (noAuth === (item.apiKey !== undefined)) {
    throw new Error(`${label} needs exactly one of apiKey or noAuth: true`);
  }
  if (
    item.profile !== undefined &&
    item.profile !== "generic" &&
    item.profile !== "openrouter"
  ) {
    throw new Error(`${label}.profile must be "generic" or "openrouter"`);
  }
  if (!Array.isArray(item.models) || item.models.length === 0) {
    throw new Error(`${label}.models must be a non-empty array`);
  }
  return {
    type: "openai-compatible",
    id: identifier(item.id, `${label}.id`),
    ...optionalDisplayName(item, label),
    baseURL: providerBaseUrl(item.baseURL, `${label}.baseURL`),
    ...(item.profile === undefined
      ? {}
      : { profile: item.profile as "generic" | "openrouter" }),
    ...(noAuth
      ? { noAuth: true as const }
      : {
          apiKey: secretSource(item.apiKey, `${label}.apiKey`, baseDirectory),
        }),
    ...(item.allowInsecureHttp === true
      ? { allowInsecureHttp: true as const }
      : {}),
    ...(item.meridianSessionAffinity === true
      ? { meridianSessionAffinity: true as const }
      : {}),
    models: item.models.map((model, index) =>
      compatibleModel(model, `${label}.models[${index}]`),
    ),
  };
}

function compatibleModel(
  value: unknown,
  label: string,
): AssistantServerCompatibleModelConfig {
  const item = record(value, label);
  allowKeys(item, label, [
    "id",
    "model",
    "displayName",
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "supportsToolUse",
    "supportsThinking",
    "promptProfile",
  ]);
  const contextWindow = positiveInteger(
    item.contextWindow,
    `${label}.contextWindow`,
  );
  const maxOutputTokens = positiveInteger(
    item.maxOutputTokens,
    `${label}.maxOutputTokens`,
  );
  const maxInputTokens =
    item.maxInputTokens === undefined
      ? undefined
      : positiveInteger(item.maxInputTokens, `${label}.maxInputTokens`);
  if (maxInputTokens === undefined && contextWindow <= maxOutputTokens) {
    throw new Error(`${label}.contextWindow must exceed maxOutputTokens`);
  }
  for (const key of ["supportsToolUse", "supportsThinking"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  }
  if (
    item.promptProfile !== undefined &&
    item.promptProfile !== "compatibility" &&
    item.promptProfile !== "reasoning"
  ) {
    throw new Error(`${label}.promptProfile is invalid`);
  }
  return {
    id: identifier(item.id, `${label}.id`),
    ...(item.model === undefined
      ? {}
      : { model: text(item.model, `${label}.model`) }),
    ...optionalDisplayName(item, label),
    contextWindow,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    maxOutputTokens,
    supportsToolUse: item.supportsToolUse === true,
    ...(item.supportsThinking === true ? { supportsThinking: true } : {}),
    ...(item.promptProfile === undefined
      ? {}
      : {
          promptProfile: item.promptProfile as "compatibility" | "reasoning",
        }),
  };
}

function secretSource(
  value: unknown,
  label: string,
  baseDirectory: string,
): AssistantServerSecretSource {
  const item = record(value, label);
  if (typeof item.file === "string" && item.credential === undefined) {
    allowKeys(item, label, ["file"]);
    return { file: path.resolve(baseDirectory, text(item.file, label)) };
  }
  if (typeof item.credential === "string" && item.file === undefined) {
    allowKeys(item, label, ["credential"]);
    const name = text(item.credential, `${label}.credential`);
    if (!CREDENTIAL_NAME_PATTERN.test(name)) {
      throw new Error(`${label}.credential contains unsupported characters`);
    }
    return { credential: name };
  }
  throw new Error(
    `${label} must be { "file": <path> } or { "credential": <name> }`,
  );
}

function providerBaseUrl(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(text(value, label));
  } catch {
    throw new Error(`${label} must be a URL`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
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

/** Resolve where a secret lives, honouring systemd's credential directory. */
export function secretSourcePath(
  source: AssistantServerSecretSource,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if ("file" in source) return source.file;
  const directory = env.CREDENTIALS_DIRECTORY;
  if (!directory) {
    throw new Error(
      `Credential "${source.credential}" needs CREDENTIALS_DIRECTORY (set by systemd LoadCredential=)`,
    );
  }
  return path.join(directory, source.credential);
}

/**
 * Check a secret file is readable, small, non-empty, and not accessible by
 * group or others. Returns a resolver that rereads it on each use, so a
 * rotated key takes effect without a restart.
 */
export async function prepareSecret(
  source: AssistantServerSecretSource,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<string>> {
  const file = secretSourcePath(source, env);
  const read = async () => {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > MAX_SECRET_BYTES) throw new Error(`${label} is too large`);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `${label} (${file}) must not be readable by group or others (chmod 600)`,
      );
    }
    const value = (await fs.readFile(file, "utf8")).trim();
    if (!value) throw new Error(`${label} (${file}) is empty`);
    return value;
  };
  try {
    await read();
  } catch (error) {
    throw new Error(`Cannot use ${label}: ${errorMessage(error)}`);
  }
  return read;
}

/** Map validated provider config to workspace-host providers. */
export async function resolveWorkspaceProviders(
  providers: readonly AssistantServerProviderConfig[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceProviderConfig[]> {
  const resolved: WorkspaceProviderConfig[] = [];
  for (const [index, provider] of providers.entries()) {
    const label = `providers[${index}].apiKey`;
    if (provider.type === "openai") {
      resolved.push({
        type: "openai",
        ...(provider.id ? { id: provider.id } : {}),
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        modelIds: provider.modelIds,
        resolveApiKey: await prepareSecret(provider.apiKey, label, env),
      });
      continue;
    }
    const { type: _type, apiKey, models, ...options } = provider;
    resolved.push({
      type: "openai-compatible",
      ...options,
      models: models.map((model) => ({ ...model })),
      ...(apiKey
        ? { resolveApiKey: await prepareSecret(apiKey, label, env) }
        : {}),
    });
  }
  return resolved;
}

function optionalDisplayName(item: Record<string, unknown>, label: string) {
  return item.displayName === undefined
    ? {}
    : { displayName: text(item.displayName, `${label}.displayName`) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Unknown keys are rejected so a typo cannot silently disable a setting. */
function allowKeys(
  item: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has unknown key "${key}"`);
    }
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must contain text`);
  }
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label);
  if (!IDENTIFIER_PATTERN.test(id)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

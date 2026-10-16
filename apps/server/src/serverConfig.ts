import {
  CODEX_MODEL_MAP,
  getCodexModelCapabilities,
  listCodexModels,
  type CoreModelCapabilities,
} from "@agentlink/core";
import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol";
import type {
  WorkspaceCodexProviderConfig,
  WorkspaceProviderConfig,
} from "@agentlink/workspace-host";

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
  readonly tls: AssistantServerTlsConfig;
  readonly defaultModel: AssistantServerModelReference;
  /**
   * Named model roles a client can ask for instead of an exact model, for
   * example `review` to run reviews on a different provider.
   */
  readonly modelRoles?: Readonly<
    Partial<Record<AssistantServerModelRole, AssistantServerModelReference>>
  >;
  readonly providers: readonly AssistantServerProviderConfig[];
  readonly projects: readonly AssistantServerProjectConfig[];
  /**
   * Absolute directory where projects created from the app are made, one
   * subdirectory each. Without it, the app cannot create projects. With a
   * command worker it must be inside the worker's roots (the same path).
   */
  readonly projectsRoot?: string;
  /**
   * Absolute ripgrep binary for `search_files`; built-in search otherwise.
   * With a command worker, ripgrep runs there, so this is the worker's path.
   */
  readonly ripgrepPath?: string;
  /**
   * Run `execute_command` (and ripgrep and git probes) on a separate command
   * worker. Without it, commands are disabled: the server never runs them
   * itself. Every command still needs the owner's approval.
   */
  readonly commandWorker?: AssistantServerCommandWorkerConfig;
  /** Web tools (`web_fetch`, `web_search`). */
  readonly web?: AssistantServerWebConfig;
  /** Push notifications to devices that turn them on. */
  readonly notifications?: AssistantServerNotificationsConfig;
  /**
   * The publisher (`agentlink-server publisher`), which holds the GitHub
   * connections and publishes coding tasks. Without it tasks stop at
   * `ready` and GitHub cannot be connected.
   */
  readonly publisher?: AssistantServerPublisherConfig;
  /**
   * Session runners: each coding task's session runs in its own container,
   * started by the runner manager (`agentlink-server runner-manager`). Needs
   * `projectsRoot` and `commandWorker`. Without it task sessions run in this
   * process and their commands on the shared command worker.
   */
  readonly runners?: AssistantServerRunnersConfig;
}

export interface AssistantServerRunnersConfig {
  /** The runner manager: a sibling container's name and its token. */
  readonly manager: AssistantServerPublisherConfig;
  /** Port this server answers runners' model and tool calls on. */
  readonly port: number;
  /** This server's name on the runners' network. */
  readonly controlHost: string;
  /** Minutes a runner may be idle before it is stopped. */
  readonly idleMinutes: number;
}

export interface AssistantServerPublisherConfig {
  /** Loopback, or a sibling container's name on a private network. */
  readonly host: string;
  readonly port: number;
  /** Shared token the publisher also reads. */
  readonly token: AssistantServerSecretSource;
}

export interface AssistantServerNotificationsConfig {
  /**
   * Contact the push services may use (the VAPID `sub`): a `mailto:` or
   * `https:` URL. Defaults to the AgentLink project page.
   */
  readonly contact?: string;
  /**
   * Put a finished run's first reply line in its notification. Off by
   * default: notifications carry the job name and a fixed description.
   */
  readonly includeSummary?: boolean;
}

export interface AssistantServerWebConfig {
  /**
   * Base URL of a SearXNG instance (with the JSON format enabled) for
   * `web_search` in chats on non-Codex models. The server calls it
   * directly, so it may be on a private network.
   */
  readonly searxngUrl?: string;
}

export interface AssistantServerCommandWorkerConfig {
  /** Loopback, or a sibling container's name on a private network. */
  readonly host: string;
  readonly port: number;
  /** Shared token the worker also reads. */
  readonly token: AssistantServerSecretSource;
  /** Absolute shell on the worker that runs each command (`-c`). */
  readonly shell: string;
  /**
   * `http://<host>:<port>` of the egress gateway, given to every command as
   * its HTTP(S) proxy. Without it commands get no proxy settings.
   */
  readonly egressProxy?: string;
  /**
   * Key shared with the egress gateway (`--policy-key-file`). With it, each
   * project's network preset is signed into its commands' proxy
   * credentials and enforced by the gateway; without it every project gets
   * the gateway's allowlist.
   */
  readonly egressPolicyKey?: AssistantServerSecretSource;
}

/** Default shell for commands on the worker. */
export const DEFAULT_COMMAND_WORKER_SHELL = "/bin/bash";

/**
 * Either an operator-provided certificate and key, or a server-managed,
 * name-constrained local CA under `<dataRoot>/tls`.
 */
export type AssistantServerTlsConfig =
  | { readonly certFile: string; readonly keyFile: string }
  | { readonly localCa: true };

export interface AssistantServerModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export const ASSISTANT_SERVER_MODEL_ROLES = ["review"] as const;
export type AssistantServerModelRole =
  (typeof ASSISTANT_SERVER_MODEL_ROLES)[number];

/** One model a client may select, as declared in the configuration. */
export interface AssistantServerModelChoice extends AssistantServerModelReference {
  readonly displayName?: string;
  readonly providerDisplayName?: string;
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly supportsImages?: boolean;
  /** Thinking levels the model accepts; absent means no thinking control. */
  readonly reasoningEfforts?: readonly CoreReasoningEffort[];
  readonly defaultReasoningEffort?: CoreReasoningEffort;
}

/**
 * The model IDs a `codex` or `openai` provider serves: the configured list,
 * or AgentLink's full maintained catalog (the same one the extension's
 * picker shows) when `modelIds` is omitted.
 */
export function responsesProviderModelIds(
  provider: Extract<
    AssistantServerProviderConfig,
    { type: "codex" | "openai" }
  >,
): readonly string[] {
  return (
    provider.modelIds ??
    listCodexModels(
      provider.id ?? provider.type,
      provider.type === "codex" ? "oauth" : "apiKey",
    ).map((model) => model.id)
  );
}

/** Every model the configuration declares, in configuration order. */
export function configuredModels(
  config: Pick<AssistantServerConfig, "providers">,
): AssistantServerModelChoice[] {
  const choices: AssistantServerModelChoice[] = [];
  for (const provider of config.providers) {
    const providerId = provider.id ?? provider.type;
    const providerDisplayName = provider.displayName
      ? { providerDisplayName: provider.displayName }
      : {};
    if (provider.type === "openai-compatible") {
      for (const model of provider.models) {
        choices.push({
          providerId,
          modelId: model.id,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          ...providerDisplayName,
          contextWindow: model.contextWindow,
          ...(model.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: model.maxInputTokens }),
          ...(model.supportsImages ? { supportsImages: true } : {}),
          ...(model.supportsThinking && model.reasoningEfforts?.length
            ? {
                reasoningEfforts: [...model.reasoningEfforts],
                defaultReasoningEffort:
                  model.defaultReasoningEffort ?? model.reasoningEfforts[0]!,
              }
            : {}),
        });
      }
    } else {
      const authMethod = provider.type === "codex" ? "oauth" : "apiKey";
      const catalog = new Map(
        listCodexModels(providerId, authMethod).map((model) => [
          model.id,
          model.displayName,
        ]),
      );
      for (const modelId of responsesProviderModelIds(provider)) {
        const capabilities: CoreModelCapabilities = getCodexModelCapabilities(
          modelId,
          authMethod,
        );
        const displayName = catalog.get(modelId);
        choices.push({
          providerId,
          modelId,
          ...(displayName ? { displayName } : {}),
          ...providerDisplayName,
          contextWindow: capabilities.contextWindow,
          ...(capabilities.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: capabilities.maxInputTokens }),
          supportsImages: capabilities.supportsImages,
          ...(capabilities.supportsThinking &&
          capabilities.reasoningEfforts?.length
            ? {
                reasoningEfforts: [...capabilities.reasoningEfforts],
                defaultReasoningEffort:
                  capabilities.defaultReasoningEffort ??
                  capabilities.reasoningEfforts[0]!,
              }
            : {}),
        });
      }
    }
  }
  return choices;
}

export function usesLocalCa(
  tls: AssistantServerTlsConfig,
): tls is { readonly localCa: true } {
  return "localCa" in tls;
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
  readonly reasoningEfforts?: readonly CoreReasoningEffort[];
  readonly defaultReasoningEffort?: CoreReasoningEffort;
  readonly supportsImages?: boolean;
  readonly promptProfile?: "compatibility" | "reasoning";
}

export const COMPATIBLE_REASONING_EFFORT_MODES = [
  "none",
  "reasoning_effort",
  "reasoning.effort",
  "output_config.effort",
] as const;

export type AssistantServerProviderConfig =
  | {
      readonly type: "openai-compatible";
      readonly id: string;
      readonly displayName?: string;
      readonly baseURL: string;
      readonly profile?: "generic" | "openrouter";
      /** How a thinking level is sent upstream (the extension's setting). */
      readonly reasoningEffortMode?: (typeof COMPATIBLE_REASONING_EFFORT_MODES)[number];
      readonly timeoutMs?: number;
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
      /** Omit for the full maintained catalog. */
      readonly modelIds?: readonly string[];
      readonly apiKey: AssistantServerSecretSource;
    }
  | {
      /**
       * ChatGPT sign-in. Tokens come from `agentlink-server codex-login`
       * and live in a private file under the data root, never in config.
       */
      readonly type: "codex";
      readonly id?: string;
      readonly displayName?: string;
      /** Omit for the full maintained catalog. */
      readonly modelIds?: readonly string[];
    };

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** A single DNS label (no dots), excluding `localhost` (handled as loopback). */
const CONTAINER_HOST_PATTERN = /^(?!localhost$)[a-z][a-z0-9-]{0,62}$/u;
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
    "modelRoles",
    "providers",
    "projects",
    "projectsRoot",
    "ripgrepPath",
    "commandWorker",
    "web",
    "notifications",
    "publisher",
    "runners",
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
  let parsedTls: AssistantServerTlsConfig;
  if ("localCa" in tls) {
    allowKeys(tls, "tls", ["localCa"]);
    if (tls.localCa !== true) {
      throw new Error("tls.localCa must be true when present");
    }
    parsedTls = { localCa: true };
  } else {
    allowKeys(tls, "tls", ["certFile", "keyFile"]);
    parsedTls = {
      certFile: resolvePath(tls.certFile, "tls.certFile"),
      keyFile: resolvePath(tls.keyFile, "tls.keyFile"),
    };
  }

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
  const declared = configuredModels({ providers });
  const modelReference = (
    input: unknown,
    label: string,
  ): AssistantServerModelReference => {
    const item = record(input, label);
    allowKeys(item, label, ["providerId", "modelId"]);
    const reference = {
      providerId: identifier(item.providerId, `${label}.providerId`),
      modelId: text(item.modelId, `${label}.modelId`),
    };
    if (!providerIds.has(reference.providerId)) {
      throw new Error(`${label}.providerId does not match a provider`);
    }
    if (
      !declared.some(
        (choice) =>
          choice.providerId === reference.providerId &&
          choice.modelId === reference.modelId,
      )
    ) {
      throw new Error(
        `${label}.modelId is not a model of provider "${reference.providerId}"`,
      );
    }
    return reference;
  };
  const parsedDefaultModel = modelReference(
    config.defaultModel,
    "defaultModel",
  );
  let modelRoles: AssistantServerConfig["modelRoles"];
  if (config.modelRoles !== undefined) {
    const roles = record(config.modelRoles, "modelRoles");
    allowKeys(roles, "modelRoles", ASSISTANT_SERVER_MODEL_ROLES);
    const parsedRoles: Partial<
      Record<AssistantServerModelRole, AssistantServerModelReference>
    > = {};
    for (const role of ASSISTANT_SERVER_MODEL_ROLES) {
      if (roles[role] !== undefined) {
        parsedRoles[role] = modelReference(roles[role], `modelRoles.${role}`);
      }
    }
    modelRoles = parsedRoles;
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
    tls: parsedTls,
    defaultModel: parsedDefaultModel,
    ...(modelRoles ? { modelRoles } : {}),
    providers,
    projects,
    ...(config.projectsRoot === undefined
      ? {}
      : { projectsRoot: resolvePath(config.projectsRoot, "projectsRoot") }),
    ...(config.ripgrepPath === undefined
      ? {}
      : { ripgrepPath: resolvePath(config.ripgrepPath, "ripgrepPath") }),
    ...(config.commandWorker === undefined
      ? {}
      : {
          commandWorker: parseCommandWorker(
            config.commandWorker,
            baseDirectory,
          ),
        }),
    ...(config.web === undefined ? {} : { web: parseWeb(config.web) }),
    ...(config.notifications === undefined
      ? {}
      : { notifications: parseNotifications(config.notifications) }),
    ...(config.publisher === undefined
      ? {}
      : { publisher: parsePublisher(config.publisher, baseDirectory) }),
    ...(config.runners === undefined
      ? {}
      : { runners: parseRunners(config.runners, baseDirectory) }),
  };
}

function parseRunners(
  value: unknown,
  baseDirectory: string,
): AssistantServerRunnersConfig {
  const label = "runners";
  const item = record(value, label);
  allowKeys(item, label, ["manager", "port", "controlHost", "idleMinutes"]);
  const manager = parsePublisher(
    item.manager,
    baseDirectory,
    "runners.manager",
  );
  const port = item.port ?? 7500;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${label}.port must be an integer from 1 to 65535`);
  }
  const controlHost =
    item.controlHost === undefined
      ? "assistant"
      : text(item.controlHost, `${label}.controlHost`);
  if (!isPrivateServiceHost(controlHost)) {
    throw new Error(
      `${label}.controlHost must be loopback or a container name on a private network`,
    );
  }
  const idleMinutes = item.idleMinutes ?? 10;
  if (
    typeof idleMinutes !== "number" ||
    !Number.isFinite(idleMinutes) ||
    idleMinutes < 1 ||
    idleMinutes > 24 * 60
  ) {
    throw new Error(`${label}.idleMinutes must be from 1 to 1440`);
  }
  return { manager, port: Number(port), controlHost, idleMinutes };
}

function parsePublisher(
  value: unknown,
  baseDirectory: string,
  label = "publisher",
): AssistantServerPublisherConfig {
  const item = record(value, label);
  allowKeys(item, label, ["host", "port", "token"]);
  const host = text(item.host, `${label}.host`);
  // Plain HTTP with a shared token: this machine or a private network only.
  if (!isPrivateServiceHost(host)) {
    throw new Error(
      `${label}.host must be loopback or a container name on a private network`,
    );
  }
  const port = item.port;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${label}.port must be an integer from 1 to 65535`);
  }
  return {
    host,
    port: Number(port),
    token: secretSource(item.token, `${label}.token`, baseDirectory),
  };
}

function parseNotifications(
  value: unknown,
): AssistantServerNotificationsConfig {
  const item = record(value, "notifications");
  allowKeys(item, "notifications", ["contact", "includeSummary"]);
  if (
    item.includeSummary !== undefined &&
    typeof item.includeSummary !== "boolean"
  ) {
    throw new Error("notifications.includeSummary must be true or false");
  }
  let contact: string | undefined;
  if (item.contact !== undefined) {
    const raw = text(item.contact, "notifications.contact");
    let url: URL | undefined;
    try {
      url = new URL(raw);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      (url.protocol === "mailto:"
        ? !/^[^@\s]+@[^@\s]+$/u.test(url.pathname)
        : url.protocol !== "https:")
    ) {
      throw new Error(
        "notifications.contact must be a mailto: or https: URL, like mailto:you@example.com",
      );
    }
    contact = raw;
  }
  return {
    ...(contact ? { contact } : {}),
    ...(item.includeSummary === undefined
      ? {}
      : { includeSummary: item.includeSummary }),
  };
}

function parseWeb(value: unknown): AssistantServerWebConfig {
  const item = record(value, "web");
  allowKeys(item, "web", ["searxngUrl"]);
  if (item.searxngUrl === undefined) return {};
  const raw = text(item.searxngUrl, "web.searxngUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("web.searxngUrl must be a URL like http://searxng:8080");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "web.searxngUrl must be an http(s) URL without credentials, query, or fragment",
    );
  }
  return { searxngUrl: url.href.replace(/\/+$/u, "") };
}

function parseCommandWorker(
  value: unknown,
  baseDirectory: string,
): AssistantServerCommandWorkerConfig {
  const label = "commandWorker";
  const item = record(value, label);
  allowKeys(item, label, [
    "host",
    "port",
    "token",
    "shell",
    "egressProxy",
    "egressPolicyKey",
  ]);
  const host = text(item.host, `${label}.host`);
  // The protocol is plain TCP with a shared token, so it must stay on this
  // machine or a private container network, like Meridian's HTTP.
  if (!isPrivateServiceHost(host)) {
    throw new Error(
      `${label}.host must be loopback or a container name on a private network`,
    );
  }
  const port = item.port;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${label}.port must be an integer from 1 to 65535`);
  }
  const shell =
    item.shell === undefined
      ? DEFAULT_COMMAND_WORKER_SHELL
      : text(item.shell, `${label}.shell`);
  if (!path.posix.isAbsolute(shell)) {
    throw new Error(`${label}.shell must be an absolute path on the worker`);
  }
  return {
    host,
    port: Number(port),
    token: secretSource(item.token, `${label}.token`, baseDirectory),
    shell,
    ...(item.egressProxy === undefined
      ? {}
      : { egressProxy: parseEgressProxy(item.egressProxy, label) }),
    ...(item.egressPolicyKey === undefined
      ? {}
      : {
          egressPolicyKey: secretSource(
            item.egressPolicyKey,
            `${label}.egressPolicyKey`,
            baseDirectory,
          ),
        }),
  };
}

function isPrivateServiceHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    CONTAINER_HOST_PATTERN.test(host)
  );
}

/** A plain `http://host:port` proxy on loopback or a container network. */
function parseEgressProxy(value: unknown, parent: string): string {
  const label = `${parent}.egressProxy`;
  const raw = text(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a URL like http://egress-gateway:3128`);
  }
  const host = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  if (
    url.protocol !== "http:" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isPrivateServiceHost(host)
  ) {
    throw new Error(
      `${label} must be http://<host>:<port> with a loopback or container host, like http://egress-gateway:3128`,
    );
  }
  return `http://${url.host}`;
}

function parseProvider(
  value: unknown,
  label: string,
  baseDirectory: string,
): AssistantServerProviderConfig {
  const item = record(value, label);
  if (item.type === "openai" || item.type === "codex") {
    allowKeys(item, label, [
      "type",
      "id",
      "displayName",
      "modelIds",
      ...(item.type === "openai" ? ["apiKey"] : []),
    ]);
    if (
      item.modelIds !== undefined &&
      (!Array.isArray(item.modelIds) || item.modelIds.length === 0)
    ) {
      throw new Error(
        `${label}.modelIds must be a non-empty array, or omitted for every model`,
      );
    }
    const common = {
      ...(item.id === undefined
        ? {}
        : { id: identifier(item.id, `${label}.id`) }),
      ...optionalDisplayName(item, label),
      ...(item.modelIds === undefined
        ? {}
        : {
            modelIds: (item.modelIds as unknown[]).map((id, index) => {
              const modelId = text(id, `${label}.modelIds[${index}]`);
              if (!CODEX_MODEL_MAP.has(modelId)) {
                throw new Error(
                  `${label}.modelIds[${index}] "${modelId}" is not a known model`,
                );
              }
              return modelId;
            }),
          }),
    };
    return item.type === "codex"
      ? { type: "codex", ...common }
      : {
          type: "openai",
          ...common,
          apiKey: secretSource(item.apiKey, `${label}.apiKey`, baseDirectory),
        };
  }
  if (item.type !== "openai-compatible") {
    throw new Error(
      `${label}.type must be "codex", "openai", or "openai-compatible"`,
    );
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
    "reasoningEffortMode",
    "timeoutMs",
    "models",
  ]);
  if (
    item.reasoningEffortMode !== undefined &&
    !(COMPATIBLE_REASONING_EFFORT_MODES as readonly unknown[]).includes(
      item.reasoningEffortMode,
    )
  ) {
    throw new Error(
      `${label}.reasoningEffortMode must be one of ${COMPATIBLE_REASONING_EFFORT_MODES.join(", ")}`,
    );
  }
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
    baseURL: providerBaseUrl(
      item.baseURL,
      `${label}.baseURL`,
      item.allowInsecureHttp === true,
    ),
    ...(item.profile === undefined
      ? {}
      : { profile: item.profile as "generic" | "openrouter" }),
    ...(item.reasoningEffortMode === undefined
      ? {}
      : {
          reasoningEffortMode:
            item.reasoningEffortMode as (typeof COMPATIBLE_REASONING_EFFORT_MODES)[number],
        }),
    ...(item.timeoutMs === undefined
      ? {}
      : { timeoutMs: positiveInteger(item.timeoutMs, `${label}.timeoutMs`) }),
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
    "reasoningEfforts",
    "defaultReasoningEffort",
    "supportsImages",
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
  for (const key of [
    "supportsToolUse",
    "supportsThinking",
    "supportsImages",
  ] as const) {
    if (item[key] !== undefined && typeof item[key] !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  }
  let reasoningEfforts: CoreReasoningEffort[] | undefined;
  if (item.reasoningEfforts !== undefined) {
    if (
      !Array.isArray(item.reasoningEfforts) ||
      item.reasoningEfforts.length === 0 ||
      !item.reasoningEfforts.every(isCoreReasoningEffort)
    ) {
      throw new Error(
        `${label}.reasoningEfforts must be a non-empty array of thinking levels`,
      );
    }
    reasoningEfforts = [...new Set(item.reasoningEfforts)];
  }
  if (
    item.defaultReasoningEffort !== undefined &&
    (!isCoreReasoningEffort(item.defaultReasoningEffort) ||
      !reasoningEfforts?.includes(item.defaultReasoningEffort))
  ) {
    throw new Error(
      `${label}.defaultReasoningEffort must be one of its reasoningEfforts`,
    );
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
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(item.defaultReasoningEffort === undefined
      ? {}
      : {
          defaultReasoningEffort:
            item.defaultReasoningEffort as CoreReasoningEffort,
        }),
    ...(item.supportsImages === true ? { supportsImages: true } : {}),
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

/**
 * HTTPS anywhere; plain HTTP to loopback; and, with `allowInsecureHttp`,
 * plain HTTP to a single-label host name, which is how a sibling container
 * on a private Docker network is addressed (`http://meridian:3456`). LAN
 * addresses and dotted names stay HTTPS-only so a key never crosses the
 * network in the clear.
 */
function providerBaseUrl(
  value: unknown,
  label: string,
  allowInsecureHttp: boolean,
): string {
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
  const containerName = CONTAINER_HOST_PATTERN.test(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (loopback || containerName))
  ) {
    throw new Error(
      `${label} must use HTTPS, loopback HTTP, or HTTP to a container name with allowInsecureHttp`,
    );
  }
  if (url.protocol === "http:" && containerName && !allowInsecureHttp) {
    throw new Error(
      `${label} uses plain HTTP to a container; set allowInsecureHttp: true to confirm it stays on a private network`,
    );
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
  options: {
    /** Required when a `codex` provider is configured. */
    readonly codexCredentialProvider?: WorkspaceCodexProviderConfig["credentialProvider"];
  } = {},
): Promise<WorkspaceProviderConfig[]> {
  const resolved: WorkspaceProviderConfig[] = [];
  for (const [index, provider] of providers.entries()) {
    const label = `providers[${index}].apiKey`;
    if (provider.type === "codex") {
      if (!options.codexCredentialProvider) {
        throw new Error(
          `providers[${index}] is a codex provider but no Codex sign-in store is available`,
        );
      }
      resolved.push({
        type: "codex",
        ...(provider.id ? { id: provider.id } : {}),
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        modelIds: responsesProviderModelIds(provider),
        credentialProvider: options.codexCredentialProvider,
      });
      continue;
    }
    if (provider.type === "openai") {
      resolved.push({
        type: "openai",
        ...(provider.id ? { id: provider.id } : {}),
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        modelIds: responsesProviderModelIds(provider),
        resolveApiKey: await prepareSecret(provider.apiKey, label, env),
      });
      continue;
    }
    const { type: _type, apiKey, models, ...compatible } = provider;
    resolved.push({
      type: "openai-compatible",
      ...compatible,
      models: models.map(({ reasoningEfforts, ...model }) => ({
        ...model,
        ...(reasoningEfforts
          ? { reasoningEfforts: [...reasoningEfforts] }
          : {}),
      })),
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

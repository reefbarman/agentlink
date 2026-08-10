import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "../../../core/modelCatalog.js";
import type { CoreModelCapabilities } from "../../../core/modelRuntime.js";
import type {
  OpenAiCompatibleModelFamily,
  OpenAiCompatibleProfileKind,
  OpenAiCompatibleReasoningEffortMode,
  OpenAiCompatibleRuntimeProfile,
} from "../../../core/model/providers/openaiCompatible/types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CONNECTIONS = 50;
const MAX_MODELS_PER_CONNECTION = 100;
const MAX_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_WIRE_MODEL_LENGTH = 1_024;
const MAX_AUTH_KEY_LENGTH = 256;
const MAX_TOKEN_LIMIT = 100_000_000;
const MAX_HEADERS = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_HEADER_BYTES = 32_768;

const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CREDENTIAL_HEADER_PATTERN =
  /(?:^|[-_])(?:api[-_]?key|auth(?:entication|orization)?|credential|secret|token)(?:$|[-_])/i;

const RESERVED_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "www-authenticate",
  "x-api-key",
  "x-openrouter-categories",
  "x-openrouter-title",
]);

export interface OpenAiCompatibleConfigIssue {
  path: string;
  message: string;
}

export interface OpenAiCompatibleBaseUrlValidationResult {
  baseUrl?: string;
  protocol?: "http:" | "https:";
  loopback?: boolean;
  issues: readonly OpenAiCompatibleConfigIssue[];
}

export interface OpenAiCompatibleConnectionDto {
  id: string;
  displayName: string;
  baseUrl: string;
  profile: OpenAiCompatibleProfileKind;
  reasoningEffortMode?: OpenAiCompatibleReasoningEffortMode;
  authKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  allowInsecureHttp?: boolean;
  auxiliaryModel?: string;
  models: OpenAiCompatibleModelDto[];
}

export interface OpenAiCompatibleModelDto {
  id: string;
  model: string;
  displayName: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsThinking?: boolean;
  reasoningEfforts?: CoreReasoningEffort[];
  defaultReasoningEffort?: CoreReasoningEffort;
  supportsImages?: boolean;
  modelFamily?: OpenAiCompatibleModelFamily;
}

export interface NormalizedOpenAiCompatibleModel {
  id: string;
  model: string;
  displayName: string;
  modelFamily?: OpenAiCompatibleModelFamily;
  capabilities: CoreModelCapabilities;
}

export interface NormalizedOpenAiCompatibleConnection {
  id: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  profile: OpenAiCompatibleProfileKind;
  reasoningEffortMode: OpenAiCompatibleReasoningEffortMode;
  authKey?: string;
  timeoutMs: number;
  headers?: Readonly<Record<string, string>>;
  allowInsecureHttp: boolean;
  auxiliaryModel?: string;
  models: readonly NormalizedOpenAiCompatibleModel[];
  runtimeProfile: OpenAiCompatibleRuntimeProfile;
}

export interface NormalizeOpenAiCompatibleConnectionsOptions {
  builtInModelIds?: Iterable<string>;
}

export interface NormalizeOpenAiCompatibleConnectionsResult {
  connections: readonly NormalizedOpenAiCompatibleConnection[];
  issues: readonly OpenAiCompatibleConfigIssue[];
  warnings: readonly OpenAiCompatibleConfigIssue[];
}

interface ParseContext {
  issues: OpenAiCompatibleConfigIssue[];
  warnings: OpenAiCompatibleConfigIssue[];
  connectionIds: Map<string, string>;
  modelIds: Map<string, string>;
  builtInModelIds: Set<string>;
}

export function validateOpenAiCompatibleBaseUrl(
  value: unknown,
): OpenAiCompatibleBaseUrlValidationResult {
  const issues: OpenAiCompatibleConfigIssue[] = [];
  const context: ParseContext = {
    issues,
    warnings: [],
    connectionIds: new Map(),
    modelIds: new Map(),
    builtInModelIds: new Set(),
  };
  const url = parseBaseUrl(value, "$", context);
  if (!url || issues.length > 0) return { issues };
  return {
    baseUrl: normalizeBaseUrl(url),
    protocol: url.protocol as "http:" | "https:",
    loopback: isLoopback(url),
    issues,
  };
}

export function normalizeOpenAiCompatibleConnections(
  raw: unknown,
  options: NormalizeOpenAiCompatibleConnectionsOptions = {},
): NormalizeOpenAiCompatibleConnectionsResult {
  const issues: OpenAiCompatibleConfigIssue[] = [];
  const warnings: OpenAiCompatibleConfigIssue[] = [];
  const context: ParseContext = {
    issues,
    warnings,
    connectionIds: new Map(),
    modelIds: new Map(),
    builtInModelIds: new Set(options.builtInModelIds ?? []),
  };

  if (!Array.isArray(raw)) {
    issue(context, "$", "Expected an array of OpenAI-compatible connections.");
    return { connections: [], issues, warnings };
  }
  if (raw.length > MAX_CONNECTIONS) {
    issue(
      context,
      "$",
      `At most ${MAX_CONNECTIONS} connections may be configured.`,
    );
  }

  const connections: NormalizedOpenAiCompatibleConnection[] = [];
  for (
    let index = 0;
    index < Math.min(raw.length, MAX_CONNECTIONS);
    index += 1
  ) {
    const connection = parseConnection(raw[index], `$[${index}]`, context);
    if (connection) {
      connections.push(connection);
    }
  }
  return { connections, issues, warnings };
}

export function toOpenAiCompatibleRuntimeProfile(
  connection: Omit<NormalizedOpenAiCompatibleConnection, "runtimeProfile">,
): OpenAiCompatibleRuntimeProfile {
  const headers = withProfileHeaders(connection.profile, connection.headers);
  return {
    providerId: connection.providerId,
    baseUrl: connection.baseUrl,
    profile: connection.profile,
    reasoningEffortMode: connection.reasoningEffortMode,
    ...(headers ? { headers } : {}),
    timeoutMs: connection.timeoutMs,
    authRequired: connection.authKey !== undefined,
    models: Object.fromEntries(
      connection.models.map((model) => [
        model.id,
        {
          id: model.id,
          model: model.model,
          ...(model.modelFamily ? { modelFamily: model.modelFamily } : {}),
          capabilities: model.capabilities,
        },
      ]),
    ),
  };
}

function parseConnection(
  raw: unknown,
  path: string,
  context: ParseContext,
): NormalizedOpenAiCompatibleConnection | undefined {
  const issueCount = context.issues.length;
  if (!isRecord(raw)) {
    issue(context, path, "Expected a connection object.");
    return undefined;
  }

  const id = readRequiredString(raw.id, `${path}.id`, context, MAX_ID_LENGTH);
  if (id !== undefined) {
    if (!CONNECTION_ID_PATTERN.test(id)) {
      issue(
        context,
        `${path}.id`,
        "Connection IDs must match [a-z0-9][a-z0-9._-]*.",
      );
    }
    const previousPath = context.connectionIds.get(id);
    if (previousPath) {
      issue(
        context,
        `${path}.id`,
        `Duplicate connection ID; first declared at ${previousPath}.`,
      );
    } else {
      context.connectionIds.set(id, `${path}.id`);
    }
  }

  const displayName = readRequiredString(
    raw.displayName,
    `${path}.displayName`,
    context,
    MAX_DISPLAY_NAME_LENGTH,
  );
  const baseUrl = parseBaseUrl(raw.baseUrl, `${path}.baseUrl`, context);
  const profile = parseProfile(raw.profile, `${path}.profile`, context);
  const reasoningEffortMode = parseReasoningEffortMode(
    raw.reasoningEffortMode,
    `${path}.reasoningEffortMode`,
    profile,
    context,
  );
  const authKey = readOptionalString(
    raw.authKey,
    `${path}.authKey`,
    context,
    MAX_AUTH_KEY_LENGTH,
  );
  const timeoutMs = readOptionalBoundedInteger(
    raw.timeoutMs,
    `${path}.timeoutMs`,
    context,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const headers = parseHeaders(raw.headers, `${path}.headers`, context);
  const allowInsecureHttp = readOptionalBoolean(
    raw.allowInsecureHttp,
    `${path}.allowInsecureHttp`,
    context,
  );
  const auxiliaryModel = readOptionalString(
    raw.auxiliaryModel,
    `${path}.auxiliaryModel`,
    context,
    MAX_ID_LENGTH,
  );

  if (!Array.isArray(raw.models)) {
    issue(context, `${path}.models`, "Expected a non-empty array of models.");
  } else if (raw.models.length === 0) {
    issue(context, `${path}.models`, "At least one model is required.");
  } else if (raw.models.length > MAX_MODELS_PER_CONNECTION) {
    issue(
      context,
      `${path}.models`,
      `At most ${MAX_MODELS_PER_CONNECTION} models may be configured per connection.`,
    );
  }

  const models: NormalizedOpenAiCompatibleModel[] = [];
  const localModelIds = new Set<string>();
  if (Array.isArray(raw.models)) {
    for (
      let index = 0;
      index < Math.min(raw.models.length, MAX_MODELS_PER_CONNECTION);
      index += 1
    ) {
      const model = parseModel(
        raw.models[index],
        `${path}.models[${index}]`,
        reasoningEffortMode,
        context,
      );
      if (model) {
        models.push(model);
        localModelIds.add(model.id);
      }
    }
  }

  if (auxiliaryModel !== undefined && !localModelIds.has(auxiliaryModel)) {
    issue(
      context,
      `${path}.auxiliaryModel`,
      "Auxiliary model must reference a valid model in the same connection.",
    );
  }

  if (
    baseUrl &&
    authKey &&
    baseUrl.protocol === "http:" &&
    !isLoopback(baseUrl)
  ) {
    if (allowInsecureHttp !== true) {
      issue(
        context,
        `${path}.baseUrl`,
        "Authenticated non-loopback HTTP requires allowInsecureHttp: true.",
      );
    } else {
      warning(
        context,
        `${path}.allowInsecureHttp`,
        "A stored credential will be sent over insecure non-loopback HTTP.",
      );
    }
  }

  if (
    context.issues.length !== issueCount ||
    id === undefined ||
    displayName === undefined ||
    baseUrl === undefined ||
    profile === undefined ||
    reasoningEffortMode === undefined
  ) {
    return undefined;
  }

  const normalizedBase = {
    id,
    providerId: `openai-compatible:${id}`,
    displayName,
    baseUrl: normalizeBaseUrl(baseUrl),
    profile,
    reasoningEffortMode,
    ...(authKey === undefined ? {} : { authKey }),
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    allowInsecureHttp: allowInsecureHttp ?? false,
    ...(auxiliaryModel === undefined ? {} : { auxiliaryModel }),
    models,
  } satisfies Omit<NormalizedOpenAiCompatibleConnection, "runtimeProfile">;

  return {
    ...normalizedBase,
    runtimeProfile: toOpenAiCompatibleRuntimeProfile(normalizedBase),
  };
}

function parseModel(
  raw: unknown,
  path: string,
  reasoningEffortMode: OpenAiCompatibleReasoningEffortMode | undefined,
  context: ParseContext,
): NormalizedOpenAiCompatibleModel | undefined {
  const issueCount = context.issues.length;
  if (!isRecord(raw)) {
    issue(context, path, "Expected a model object.");
    return undefined;
  }

  const id = readRequiredString(raw.id, `${path}.id`, context, MAX_ID_LENGTH);
  if (id !== undefined) {
    const previousPath = context.modelIds.get(id);
    if (previousPath) {
      issue(
        context,
        `${path}.id`,
        `Duplicate global model ID; first declared at ${previousPath}.`,
      );
    } else {
      context.modelIds.set(id, `${path}.id`);
    }
    if (context.builtInModelIds.has(id)) {
      issue(
        context,
        `${path}.id`,
        "Model ID collides with a built-in model ID.",
      );
    }
  }

  const model = readRequiredString(
    raw.model,
    `${path}.model`,
    context,
    MAX_WIRE_MODEL_LENGTH,
  );
  const displayName = readRequiredString(
    raw.displayName,
    `${path}.displayName`,
    context,
    MAX_DISPLAY_NAME_LENGTH,
  );
  const contextWindow = readRequiredBoundedInteger(
    raw.contextWindow,
    `${path}.contextWindow`,
    context,
    1,
    MAX_TOKEN_LIMIT,
  );
  const maxInputTokens = readOptionalBoundedInteger(
    raw.maxInputTokens,
    `${path}.maxInputTokens`,
    context,
    1,
    MAX_TOKEN_LIMIT,
  );
  const maxOutputTokens = readRequiredBoundedInteger(
    raw.maxOutputTokens,
    `${path}.maxOutputTokens`,
    context,
    1,
    MAX_TOKEN_LIMIT,
  );
  const supportsToolUse = readRequiredBoolean(
    raw.supportsToolUse,
    `${path}.supportsToolUse`,
    context,
  );
  const supportsThinking = readOptionalBoolean(
    raw.supportsThinking,
    `${path}.supportsThinking`,
    context,
  );
  const supportsImages = readOptionalBoolean(
    raw.supportsImages,
    `${path}.supportsImages`,
    context,
  );
  const modelFamily = parseModelFamily(
    raw.modelFamily,
    `${path}.modelFamily`,
    context,
  );
  const reasoningEfforts = parseReasoningEfforts(
    raw.reasoningEfforts,
    `${path}.reasoningEfforts`,
    context,
  );
  const defaultReasoningEffort = parseReasoningEffort(
    raw.defaultReasoningEffort,
    `${path}.defaultReasoningEffort`,
    context,
  );

  if (
    contextWindow !== undefined &&
    maxInputTokens !== undefined &&
    maxInputTokens > contextWindow
  ) {
    issue(
      context,
      `${path}.maxInputTokens`,
      "maxInputTokens cannot exceed contextWindow.",
    );
  }
  if (
    contextWindow !== undefined &&
    maxOutputTokens !== undefined &&
    maxOutputTokens > contextWindow
  ) {
    issue(
      context,
      `${path}.maxOutputTokens`,
      "maxOutputTokens cannot exceed contextWindow.",
    );
  }
  if (supportsThinking !== true) {
    if (reasoningEfforts !== undefined) {
      issue(
        context,
        `${path}.reasoningEfforts`,
        "reasoningEfforts requires supportsThinking: true.",
      );
    }
    if (defaultReasoningEffort !== undefined) {
      issue(
        context,
        `${path}.defaultReasoningEffort`,
        "defaultReasoningEffort requires supportsThinking: true.",
      );
    }
  }

  if (reasoningEffortMode === "none" && reasoningEfforts !== undefined) {
    issue(
      context,
      `${path}.reasoningEfforts`,
      "reasoningEfforts requires a connection reasoningEffortMode other than none.",
    );
  }
  if (reasoningEffortMode === "none" && defaultReasoningEffort !== undefined) {
    issue(
      context,
      `${path}.defaultReasoningEffort`,
      "defaultReasoningEffort requires a connection reasoningEffortMode other than none.",
    );
  }
  if (
    defaultReasoningEffort !== undefined &&
    (reasoningEfforts === undefined ||
      !reasoningEfforts.includes(defaultReasoningEffort))
  ) {
    issue(
      context,
      `${path}.defaultReasoningEffort`,
      "defaultReasoningEffort must be present in reasoningEfforts.",
    );
  }

  if (
    context.issues.length !== issueCount ||
    id === undefined ||
    model === undefined ||
    displayName === undefined ||
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    supportsToolUse === undefined
  ) {
    return undefined;
  }

  return {
    id,
    model,
    displayName,
    ...(modelFamily === undefined ? {} : { modelFamily }),
    capabilities: {
      supportsThinking: supportsThinking ?? false,
      supportsCaching: false,
      supportsImages: supportsImages ?? false,
      supportsToolUse,
      contextWindow,
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      maxOutputTokens,
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      ...(defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort }),
    },
  };
}

function parseBaseUrl(
  value: unknown,
  path: string,
  context: ParseContext,
): URL | undefined {
  const text = readRequiredString(value, path, context, 2_048);
  if (text === undefined) {
    return undefined;
  }
  if (text !== text.trim()) {
    issue(
      context,
      path,
      "Base URL cannot have leading or trailing whitespace.",
    );
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    issue(context, path, "Expected an absolute HTTP or HTTPS URL.");
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    issue(context, path, "Only HTTP and HTTPS base URLs are supported.");
  }
  if (url.username || url.password) {
    issue(context, path, "Base URL must not contain user information.");
  }
  if (url.search) {
    issue(context, path, "Base URL must not contain a query string.");
  }
  if (url.hash) {
    issue(context, path, "Base URL must not contain a fragment.");
  }
  return url;
}

function normalizeBaseUrl(url: URL): string {
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function parseProfile(
  value: unknown,
  path: string,
  context: ParseContext,
): OpenAiCompatibleProfileKind | undefined {
  if (value === "generic" || value === "openrouter") {
    return value;
  }
  issue(context, path, 'Expected profile "generic" or "openrouter".');
  return undefined;
}

function parseReasoningEffortMode(
  value: unknown,
  path: string,
  profile: OpenAiCompatibleProfileKind | undefined,
  context: ParseContext,
): OpenAiCompatibleReasoningEffortMode | undefined {
  if (value === undefined) {
    return profile === "openrouter" ? "reasoning.effort" : "none";
  }
  if (
    value === "none" ||
    value === "reasoning_effort" ||
    value === "reasoning.effort" ||
    value === "output_config.effort"
  ) {
    return value;
  }
  issue(
    context,
    path,
    'Expected "none", "reasoning_effort", "reasoning.effort", or "output_config.effort".',
  );
  return undefined;
}

function parseModelFamily(
  value: unknown,
  path: string,
  context: ParseContext,
): OpenAiCompatibleModelFamily | undefined {
  if (value === undefined) return undefined;
  if (value === "anthropic" || value === "openai") return value;
  issue(context, path, 'Expected "anthropic" or "openai".');
  return undefined;
}

function parseHeaders(
  value: unknown,
  path: string,
  context: ParseContext,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issue(context, path, "Expected a header-name to header-value object.");
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) {
    issue(context, path, `At most ${MAX_HEADERS} headers may be configured.`);
  }

  let totalBytes = 0;
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const [name, rawHeaderValue] of entries.slice(0, MAX_HEADERS)) {
    const headerPath = `${path}[${JSON.stringify(name)}]`;
    const lowerName = name.toLowerCase();
    totalBytes += utf8ByteLength(name);

    if (
      name.length === 0 ||
      name.length > MAX_HEADER_NAME_LENGTH ||
      !HEADER_NAME_PATTERN.test(name)
    ) {
      issue(
        context,
        headerPath,
        `Header names must be valid HTTP tokens of at most ${MAX_HEADER_NAME_LENGTH} characters.`,
      );
    }
    if (
      RESERVED_HEADERS.has(lowerName) ||
      lowerName.startsWith("proxy-") ||
      lowerName.startsWith("sec-") ||
      CREDENTIAL_HEADER_PATTERN.test(lowerName)
    ) {
      issue(
        context,
        headerPath,
        "This reserved or credential-bearing header is forbidden.",
      );
    }
    if (seenNames.has(lowerName)) {
      issue(context, headerPath, "Header names must be unique ignoring case.");
    }
    seenNames.add(lowerName);

    if (typeof rawHeaderValue !== "string") {
      issue(context, headerPath, "Header values must be strings.");
      continue;
    }
    totalBytes += utf8ByteLength(rawHeaderValue);
    if (rawHeaderValue.length > MAX_HEADER_VALUE_LENGTH) {
      issue(
        context,
        headerPath,
        `Header values may contain at most ${MAX_HEADER_VALUE_LENGTH} characters.`,
      );
    }
    if (
      [...rawHeaderValue].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint <= 0x08 ||
          (codePoint >= 0x0a && codePoint <= 0x1f) ||
          codePoint === 0x7f
        );
      })
    ) {
      issue(
        context,
        headerPath,
        "Header values must not contain CR, LF, or control characters.",
      );
    }
    headers[name] = rawHeaderValue;
  }
  if (totalBytes > MAX_HEADER_BYTES) {
    issue(
      context,
      path,
      `Header names and values may use at most ${MAX_HEADER_BYTES} UTF-8 bytes in total.`,
    );
  }
  return headers;
}

function withProfileHeaders(
  profile: OpenAiCompatibleProfileKind,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (profile === "openrouter") {
    return {
      ...headers,
      "X-OpenRouter-Title": "AgentLink",
      "X-OpenRouter-Categories": "ide-extension",
    };
  }
  return headers;
}

function parseReasoningEfforts(
  value: unknown,
  path: string,
  context: ParseContext,
): CoreReasoningEffort[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    issue(context, path, "Expected a non-empty array of reasoning efforts.");
    return undefined;
  }
  const efforts: CoreReasoningEffort[] = [];
  const seen = new Set<CoreReasoningEffort>();
  for (let index = 0; index < value.length; index += 1) {
    const effort = value[index];
    if (!isCoreReasoningEffort(effort)) {
      issue(context, `${path}[${index}]`, "Unknown reasoning effort.");
    } else if (seen.has(effort)) {
      issue(context, `${path}[${index}]`, "Reasoning efforts must be unique.");
    } else {
      seen.add(effort);
      efforts.push(effort);
    }
  }
  return efforts;
}

function parseReasoningEffort(
  value: unknown,
  path: string,
  context: ParseContext,
): CoreReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isCoreReasoningEffort(value)) {
    issue(context, path, "Unknown reasoning effort.");
    return undefined;
  }
  return value;
}

function readRequiredString(
  value: unknown,
  path: string,
  context: ParseContext,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issue(context, path, "Expected a non-empty string.");
    return undefined;
  }
  if (value.trim().length === 0) {
    issue(context, path, "Expected a non-whitespace string.");
    return undefined;
  }
  if (value.length > maxLength) {
    issue(context, path, `String may contain at most ${maxLength} characters.`);
    return undefined;
  }
  return value;
}

function readOptionalString(
  value: unknown,
  path: string,
  context: ParseContext,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredString(value, path, context, maxLength);
}

function readRequiredBoundedInteger(
  value: unknown,
  path: string,
  context: ParseContext,
  minimum: number,
  maximum: number,
): number | undefined {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    issue(
      context,
      path,
      `Expected an integer from ${minimum} through ${maximum}.`,
    );
    return undefined;
  }
  return Number(value);
}

function readOptionalBoundedInteger(
  value: unknown,
  path: string,
  context: ParseContext,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredBoundedInteger(value, path, context, minimum, maximum);
}

function readRequiredBoolean(
  value: unknown,
  path: string,
  context: ParseContext,
): boolean | undefined {
  if (typeof value !== "boolean") {
    issue(context, path, "Expected a boolean.");
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  path: string,
  context: ParseContext,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredBoolean(value, path, context);
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function issue(context: ParseContext, path: string, message: string): void {
  context.issues.push({ path, message });
}

function warning(context: ParseContext, path: string, message: string): void {
  context.warnings.push({ path, message });
}

import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";
import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  OpenAiCompatibleTimeoutError,
  createOpenAiCompatibleHttpError,
  toOpenAiCompatibleRequestError,
} from "../../../core/model/providers/openaiCompatible/errors.js";
import type {
  OpenAiCompatibleFetch,
  OpenAiCompatibleProfileKind,
} from "../../../core/model/providers/openaiCompatible/types.js";
import { validateOpenAiCompatibleBaseUrl } from "./config.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MODELS = 5_000;
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_TOKEN_LIMIT = 100_000_000;

export type OpenAiCompatibleDiscoveryProvenance = "discovered" | "default";

export interface DiscoveredOpenAiCompatibleModel {
  model: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsToolUse: boolean;
  supportsThinking: boolean;
  supportsImages: boolean;
  reasoningEfforts?: CoreReasoningEffort[];
  defaultReasoningEffort?: CoreReasoningEffort;
  provenance: {
    displayName: OpenAiCompatibleDiscoveryProvenance;
    contextWindow: OpenAiCompatibleDiscoveryProvenance;
    maxOutputTokens: OpenAiCompatibleDiscoveryProvenance;
    supportsToolUse: OpenAiCompatibleDiscoveryProvenance;
    supportsThinking: OpenAiCompatibleDiscoveryProvenance;
    supportsImages: OpenAiCompatibleDiscoveryProvenance;
    reasoningEfforts?: OpenAiCompatibleDiscoveryProvenance;
    defaultReasoningEffort?: OpenAiCompatibleDiscoveryProvenance;
  };
}

export interface DiscoverOpenAiCompatibleModelsOptions {
  baseUrl: string;
  profile: OpenAiCompatibleProfileKind;
  apiKey?: string;
  fetch?: OpenAiCompatibleFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxModels?: number;
}

export async function discoverOpenAiCompatibleModels(
  options: DiscoverOpenAiCompatibleModelsOptions,
): Promise<DiscoveredOpenAiCompatibleModel[]> {
  const validated = validateOpenAiCompatibleBaseUrl(options.baseUrl);
  if (!validated.baseUrl) {
    throw new OpenAiCompatibleRequestError({
      message:
        validated.issues[0]?.message ??
        "OpenAI-compatible model discovery requires a valid base URL",
      providerCode: "invalid_base_url",
      retryable: false,
      authentication: false,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = createDiscoveryAbort(options.signal, timeoutMs);
  const apiKey = options.apiKey?.trim() || undefined;
  try {
    if (abort.abortedByCaller()) throw new OpenAiCompatibleAbortError();
    const headers = new Headers({ Accept: "application/json" });
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    if (options.profile === "openrouter") {
      headers.set("X-OpenRouter-Title", "AgentLink");
      headers.set("X-OpenRouter-Categories", "ide-extension");
    }

    const response = await (options.fetch ?? globalThis.fetch)(
      `${validated.baseUrl}/models`,
      {
        method: "GET",
        headers,
        signal: abort.signal,
        redirect: "manual",
      },
    );
    if (isRedirect(response.status)) {
      throw new OpenAiCompatibleRequestError({
        message: `OpenAI-compatible model discovery returned forbidden redirect HTTP ${response.status}`,
        status: response.status,
        retryable: false,
        authentication: false,
      });
    }
    if (!response.ok) {
      throw await createOpenAiCompatibleHttpError(response, {
        sensitiveValues: apiKey ? [apiKey] : undefined,
      });
    }

    const value = await readBoundedJson(
      response,
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    );
    const models = parseCatalog(
      value,
      options.profile,
      options.maxModels ?? DEFAULT_MAX_MODELS,
    );
    if (models.length === 0) {
      throw new OpenAiCompatibleRequestError({
        message:
          "OpenAI-compatible model catalog did not contain usable models",
        providerCode: "empty_model_catalog",
        retryable: false,
        authentication: false,
      });
    }
    return models;
  } catch (error) {
    if (abort.timedOut()) throw new OpenAiCompatibleTimeoutError(timeoutMs);
    if (abort.abortedByCaller()) throw new OpenAiCompatibleAbortError();
    throw toOpenAiCompatibleRequestError(error, {
      sensitiveValues: apiKey ? [apiKey] : undefined,
    });
  } finally {
    abort.dispose();
  }
}

function parseCatalog(
  value: unknown,
  profile: OpenAiCompatibleProfileKind,
  maxModels: number,
): DiscoveredOpenAiCompatibleModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new OpenAiCompatibleRequestError({
      message: 'OpenAI-compatible model catalog must contain a "data" array',
      providerCode: "invalid_model_catalog",
      retryable: false,
      authentication: false,
    });
  }

  const models: DiscoveredOpenAiCompatibleModel[] = [];
  const ids = new Set<string>();
  for (const entry of value.data) {
    const model =
      profile === "openrouter"
        ? parseOpenRouterModel(entry)
        : parseGenericModel(entry);
    if (!model || ids.has(model.model)) continue;
    if (models.length >= maxModels) {
      throw new OpenAiCompatibleRequestError({
        message: `OpenAI-compatible model catalog exceeds the ${maxModels} model limit`,
        providerCode: "model_catalog_too_large",
        retryable: false,
        authentication: false,
      });
    }
    ids.add(model.model);
    models.push(model);
  }
  return models;
}

function parseOpenRouterModel(
  value: unknown,
): DiscoveredOpenAiCompatibleModel | undefined {
  if (!isRecord(value)) return undefined;
  const model = boundedString(value.id, MAX_MODEL_ID_LENGTH);
  if (!model) return undefined;

  const architecture = isRecord(value.architecture)
    ? value.architecture
    : undefined;
  const outputModalities = stringArray(architecture?.output_modalities);
  if (outputModalities && !outputModalities.includes("text")) return undefined;

  const topProvider = isRecord(value.top_provider)
    ? value.top_provider
    : undefined;
  const rootContext = positiveInteger(value.context_length);
  const providerContext = positiveInteger(topProvider?.context_length);
  const discoveredContext =
    rootContext && providerContext
      ? Math.min(rootContext, providerContext)
      : (rootContext ?? providerContext);
  const contextWindow = discoveredContext ?? DEFAULT_CONTEXT_WINDOW;

  const providerMaxOutput = positiveInteger(topProvider?.max_completion_tokens);
  const discoveredMaxOutput =
    providerMaxOutput && providerMaxOutput <= contextWindow
      ? providerMaxOutput
      : undefined;
  const maxOutputTokens =
    discoveredMaxOutput ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow);

  const parameters = stringArray(value.supported_parameters) ?? [];
  const supportsToolUse =
    parameters.includes("tools") && parameters.includes("tool_choice");
  const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined;
  const reasoningEfforts = uniqueReasoningEfforts(reasoning?.supported_efforts);
  const supportsThinking = reasoningEfforts.length > 0;
  const defaultReasoningEffort = supportsThinking
    ? reasoningEfforts.find((effort) => effort === reasoning?.default_effort)
    : undefined;
  const supportsImages =
    stringArray(architecture?.input_modalities)?.includes("image") ?? false;
  const discoveredDisplayName = boundedString(
    value.name,
    MAX_DISPLAY_NAME_LENGTH,
  );

  return {
    model,
    displayName: discoveredDisplayName ?? model,
    contextWindow,
    maxOutputTokens,
    supportsToolUse,
    supportsThinking,
    supportsImages,
    ...(supportsThinking ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    provenance: {
      displayName: discoveredDisplayName ? "discovered" : "default",
      contextWindow: discoveredContext ? "discovered" : "default",
      maxOutputTokens: discoveredMaxOutput ? "discovered" : "default",
      supportsToolUse: "discovered",
      supportsThinking: supportsThinking ? "discovered" : "default",
      supportsImages: "discovered",
      ...(supportsThinking ? { reasoningEfforts: "discovered" } : {}),
      ...(defaultReasoningEffort
        ? { defaultReasoningEffort: "discovered" }
        : {}),
    },
  };
}

function parseGenericModel(
  value: unknown,
): DiscoveredOpenAiCompatibleModel | undefined {
  if (!isRecord(value)) return undefined;
  const model = boundedString(value.id, MAX_MODEL_ID_LENGTH);
  if (!model) return undefined;
  const displayName = boundedString(value.name, MAX_DISPLAY_NAME_LENGTH);
  const discoveredContext = positiveInteger(value.context_length);
  const contextWindow = discoveredContext ?? DEFAULT_CONTEXT_WINDOW;
  const candidateMaxOutput = positiveInteger(value.max_completion_tokens);
  const discoveredMaxOutput =
    candidateMaxOutput && candidateMaxOutput <= contextWindow
      ? candidateMaxOutput
      : undefined;

  return {
    model,
    displayName: displayName ?? model,
    contextWindow,
    maxOutputTokens:
      discoveredMaxOutput ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow),
    supportsToolUse: false,
    supportsThinking: false,
    supportsImages: false,
    provenance: {
      displayName: displayName ? "discovered" : "default",
      contextWindow: discoveredContext ? "discovered" : "default",
      maxOutputTokens: discoveredMaxOutput ? "discovered" : "default",
      supportsToolUse: "default",
      supportsThinking: "default",
      supportsImages: "default",
    },
  };
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw catalogBodyTooLarge(maxBytes);
  }
  if (!response.body) {
    throw new OpenAiCompatibleRequestError({
      message:
        "OpenAI-compatible model catalog response did not include a body",
      providerCode: "invalid_model_catalog",
      retryable: false,
      authentication: false,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw catalogBodyTooLarge(maxBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new OpenAiCompatibleRequestError({
      message: "OpenAI-compatible model catalog contained invalid JSON",
      providerCode: "invalid_model_catalog",
      retryable: false,
      authentication: false,
    });
  }
}

function catalogBodyTooLarge(maxBytes: number): OpenAiCompatibleRequestError {
  return new OpenAiCompatibleRequestError({
    message: `OpenAI-compatible model catalog exceeds the ${maxBytes} byte limit`,
    providerCode: "model_catalog_too_large",
    retryable: false,
    authentication: false,
  });
}

function createDiscoveryAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  let abortedByCaller = callerSignal?.aborted ?? false;
  const onCallerAbort = () => {
    abortedByCaller = true;
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (abortedByCaller) controller.abort(callerSignal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abortedByCaller: () => abortedByCaller,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= MAX_TOKEN_LIMIT
    ? Number(value)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function uniqueReasoningEfforts(value: unknown): CoreReasoningEffort[] {
  const efforts = stringArray(value) ?? [];
  return [
    ...new Set(efforts.filter((effort) => isCoreReasoningEffort(effort))),
  ];
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

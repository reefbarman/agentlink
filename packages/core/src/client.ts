import { randomUUID } from "node:crypto";

import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { z, type ZodType } from "zod";

import {
  HostToolPublicError,
  type HostTool,
  type HostToolResolver,
} from "./hostTools.js";
import type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";
import {
  CoreModelAttemptLimitError,
  CoreModelBackendRegistry,
  CoreModelOutputLimitError,
  DefaultCoreModelRuntime,
  type CoreModelAuthContext,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteResult,
  type CoreModelJsonSchema,
  type CoreModelMessage,
  type CoreModelProviderRequestAttempt,
  type CoreModelRuntime,
  type CoreModelStopReason,
  type CoreModelUsage,
} from "./modelRuntime.js";
import { CodexRequestError } from "./codex/errors.js";
import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  OpenAiCompatibleTimeoutError,
} from "./openAiCompatible/errors.js";
import type {
  AgentTurnEvent,
  AgentTurnInput,
  AgentTurnResult,
} from "./turnContracts.js";
import type {
  TurnExecutionLimits,
  TurnExecutionSnapshot,
} from "./turnExecution.js";
import {
  createHeadlessTurnKernel,
  HeadlessTurnEventQueueLimitError,
} from "./turnKernel.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_QUEUED_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RETRIES = 0;
const MAX_SCHEMA_NAME_LENGTH = 64;

export type AgentClientErrorCode =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "provider_unavailable"
  | "provider_error"
  | "cancelled"
  | "timeout"
  | "refused"
  | "output_truncated"
  | "invalid_output"
  | "unsupported_capability"
  | "unsupported_schema"
  | "limit_exceeded";

export class AgentClientError extends Error {
  constructor(
    readonly code: AgentClientErrorCode,
    message: string,
    readonly requestId: string,
    readonly retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AgentClientError";
  }
}

export interface AgentClientLimits {
  timeoutMs?: number;
  maxInputBytes?: number;
  maxSchemaBytes?: number;
  maxOutputBytes?: number;
  maxQueuedEventBytes?: number;
  maxRetries?: number;
}

export interface CreateAgentClientOptions {
  providers?: readonly CoreModelBackend[];
  runtime?: CoreModelRuntime;
  defaultModel: AgentModelReference;
  limits?: AgentClientLimits;
  createRequestId?: () => string;
}

interface AgentClientOperationBase<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  principal: TPrincipal;
  model?: AgentModelReference;
  authContext?: CoreModelAuthContext;
  instructions?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxRetries?: number;
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  signal?: AbortSignal;
}

export type AgentClientPromptInput =
  | { prompt: string; messages?: never }
  | { prompt?: never; messages: readonly CoreModelMessage[] };

export type AgentClientGenerateTextRequest = AgentClientOperationBase &
  AgentClientPromptInput;

export type AgentClientOutputMode = "native" | "prompt";

export interface AgentClientJsonSchema<T> {
  jsonSchema: CoreModelJsonSchema;
  parse: (value: unknown) => T;
  name?: string;
}

export type AgentClientObjectSchema<T> = ZodType<T> | AgentClientJsonSchema<T>;

export type AgentClientGenerateObjectRequest<T> = AgentClientOperationBase &
  AgentClientPromptInput & {
    schema: AgentClientObjectSchema<T>;
    schemaName?: string;
    outputMode?: AgentClientOutputMode;
    maxSchemaBytes?: number;
  };

export interface AgentClientGenerationResult {
  text: string;
  usage?: CoreModelUsage;
  finishReason?: CoreModelStopReason;
  terminationEvidence?: "observed" | "inferred";
  attempts: number;
  requestId: string;
  requestedModel: AgentModelReference;
  effectiveModel: string;
}

export interface AgentClientObjectResult<T> extends Omit<
  AgentClientGenerationResult,
  "text"
> {
  object: T;
  outputMode: AgentClientOutputMode;
}

export interface AgentClientErrorInfo {
  code: AgentClientErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
}

export type AgentClientTextStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "usage"; usage: CoreModelUsage }
  | { type: "completed"; result: AgentClientGenerationResult }
  | { type: "cancelled"; error: AgentClientErrorInfo }
  | { type: "error"; error: AgentClientErrorInfo };

export type AgentClientTextStream = AsyncGenerator<
  AgentClientTextStreamEvent,
  AgentClientGenerationResult | undefined
>;

export interface AgentClientRunLimits extends TurnExecutionLimits {
  maxQueuedEventBytes?: number;
}

export interface AgentClientAuthorizeToolCallRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  principal: TPrincipal;
  requestId: string;
  model: AgentModelReference;
  toolCallId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  displayInput?: unknown;
  effect: "read" | "write" | "external" | "unknown";
  signal: AbortSignal;
}

export type AgentClientAuthorizeToolCall<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: AgentClientAuthorizeToolCallRequest<TPrincipal>,
) =>
  | { decision: "allow" | "deny"; reason?: string }
  | Promise<{ decision: "allow" | "deny"; reason?: string }>;

export interface AgentClientRunRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends AgentClientOperationBase<TPrincipal> {
  input: AgentTurnInput;
  history?: readonly CoreModelMessage[];
  tools?: readonly HostTool<TPrincipal>[];
  resolveTools?: HostToolResolver<TPrincipal>;
  authorizeToolCall?: AgentClientAuthorizeToolCall<TPrincipal>;
  reasoningEffort?: CoreReasoningEffort;
  limits?: AgentClientRunLimits;
  includePrivateHistory?: boolean;
}

export interface AgentClientToolOutcome {
  type: "completed" | "failed";
  toolCallId: string;
  toolName: string;
  effect: "read" | "write" | "external" | "unknown";
  displayContent?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

interface AgentClientRunResultBase {
  requestId: string;
  usage?: CoreModelUsage;
  execution: TurnExecutionSnapshot;
  requestedModel: AgentModelReference;
  resolvedModel?: AgentModelReference;
  attempts: number;
  toolOutcomes: readonly AgentClientToolOutcome[];
  privateHistory?: readonly CoreModelMessage[];
}

export type AgentClientRunResult =
  | (AgentClientRunResultBase & {
      status: "completed";
      text: string;
      stopReason?: CoreModelStopReason;
    })
  | (AgentClientRunResultBase & {
      status: "cancelled";
      reason?: string;
    })
  | (AgentClientRunResultBase & {
      status: "failed";
      error: AgentClientErrorInfo;
    });

export type AgentClientSafeRunResult =
  AgentClientRunResult extends infer TResult
    ? TResult extends AgentClientRunResult
      ? Omit<TResult, "privateHistory">
      : never
    : never;

export type AgentClientRunEvent =
  | { type: "run.started"; requestId: string }
  | { type: "model.resolved"; model: AgentModelReference }
  | { type: "text.delta"; text: string }
  | {
      type: "tool.requested";
      toolCallId: string;
      toolName: string;
      effect: "read" | "write" | "external" | "unknown";
      displayInput?: unknown;
    }
  | {
      type: "tool.started";
      toolCallId: string;
      toolName: string;
      effect: "read" | "write" | "external" | "unknown";
    }
  | ({ type: "tool.completed" } & Omit<AgentClientToolOutcome, "type">)
  | ({ type: "tool.failed" } & Omit<AgentClientToolOutcome, "type">)
  | { type: "usage"; usage: CoreModelUsage }
  | { type: "execution"; execution: TurnExecutionSnapshot }
  | { type: "completed"; result: AgentClientSafeRunResult }
  | { type: "cancelled"; result: AgentClientSafeRunResult }
  | { type: "error"; result: AgentClientSafeRunResult };

export type AgentClientRunStream = AsyncGenerator<
  AgentClientRunEvent,
  AgentClientRunResult | undefined
>;

export interface AgentClient {
  generateText(
    request: AgentClientGenerateTextRequest,
  ): Promise<AgentClientGenerationResult>;
  generateObject<T>(
    request: AgentClientGenerateObjectRequest<T>,
  ): Promise<AgentClientObjectResult<T>>;
  streamText(request: AgentClientGenerateTextRequest): AgentClientTextStream;
  run<TPrincipal extends AgentPrincipal>(
    request: AgentClientRunRequest<TPrincipal>,
  ): Promise<AgentClientRunResult>;
  stream<TPrincipal extends AgentPrincipal>(
    request: AgentClientRunRequest<TPrincipal>,
  ): AgentClientRunStream;
}

export function createAgentClient(
  options: CreateAgentClientOptions,
): AgentClient {
  if (Boolean(options.providers) === Boolean(options.runtime)) {
    throw new Error(
      "createAgentClient requires exactly one of providers or runtime",
    );
  }
  if (options.providers?.length === 0) {
    throw new Error("createAgentClient providers cannot be empty");
  }
  const defaults = normalizeLimits(options.limits);
  const runtime =
    options.runtime ??
    createRuntime(options.providers!, `agent-client-${randomUUID()}`);
  const createRequestId = options.createRequestId ?? randomUUID;

  return {
    async generateText(request) {
      const execution = await executeGeneration({
        runtime,
        defaultModel: options.defaultModel,
        defaults,
        createRequestId,
        request,
      });
      assertTextFinish(execution.result, execution.requestId);
      return toTextResult(execution);
    },
    async generateObject<T>(request: AgentClientGenerateObjectRequest<T>) {
      const requestId = createRequestId();
      const schema = prepareSchema(
        request.schema,
        request.schemaName,
        operationPositiveLimit(
          request.maxSchemaBytes ?? defaults.maxSchemaBytes,
          "maxSchemaBytes",
          requestId,
        ),
        requestId,
      );
      const outputMode = request.outputMode ?? "native";
      const instructions =
        outputMode === "prompt"
          ? [
              request.instructions,
              "Return only one JSON object that matches the supplied JSON Schema. Do not use Markdown fences or explanatory text.",
              `JSON Schema: ${JSON.stringify(schema.jsonSchema)}`,
            ]
              .filter(Boolean)
              .join("\n\n")
          : request.instructions;
      const execution = await executeGeneration({
        runtime,
        defaultModel: options.defaultModel,
        defaults,
        createRequestId: () => requestId,
        request: { ...request, instructions },
        outputMode,
        outputSchema: schema,
      });
      assertTypedFinish(execution.result, requestId);
      let parsed: unknown;
      try {
        parsed = JSON.parse(execution.result.text);
      } catch (error) {
        throw new AgentClientError(
          "invalid_output",
          "The model returned invalid JSON",
          requestId,
          false,
          { cause: error },
        );
      }
      let object: T;
      try {
        object = schema.parse(parsed);
      } catch (error) {
        throw new AgentClientError(
          "invalid_output",
          "The model output did not match the requested schema",
          requestId,
          false,
          { cause: error },
        );
      }
      const base = toTextResult(execution);
      return {
        object,
        outputMode,
        usage: base.usage,
        finishReason: base.finishReason,
        terminationEvidence: base.terminationEvidence,
        attempts: base.attempts,
        requestId: base.requestId,
        requestedModel: base.requestedModel,
        effectiveModel: base.effectiveModel,
      };
    },
    streamText(request) {
      return streamTextGeneration({
        runtime,
        defaultModel: options.defaultModel,
        defaults,
        createRequestId,
        request,
      });
    },
    async run<TPrincipal extends AgentPrincipal>(
      request: AgentClientRunRequest<TPrincipal>,
    ) {
      return await collectAgentClientRun(
        streamAgentClientRun({
          runtime,
          defaultModel: options.defaultModel,
          defaults,
          createRequestId,
          request,
        }),
      );
    },
    stream<TPrincipal extends AgentPrincipal>(
      request: AgentClientRunRequest<TPrincipal>,
    ) {
      return streamAgentClientRun({
        runtime,
        defaultModel: options.defaultModel,
        defaults,
        createRequestId,
        request,
      });
    },
  };
}

function streamTextGeneration(args: {
  runtime: CoreModelRuntime;
  defaultModel: AgentModelReference;
  defaults: Required<AgentClientLimits>;
  createRequestId: () => string;
  request: AgentClientGenerateTextRequest;
}): AgentClientTextStream {
  return (async function* (): AgentClientTextStream {
    const requestId = args.createRequestId();
    const consumerAbort = new AbortController();
    const combinedSignal = combineClientSignals(
      args.request.signal,
      consumerAbort.signal,
    );
    const abort = createDeadlineSignal(
      combinedSignal,
      operationPositiveLimit(
        args.request.timeoutMs ?? args.defaults.timeoutMs,
        "timeoutMs",
        requestId,
      ),
    );
    let settled = false;
    try {
      const requestedModel = args.request.model ?? args.defaultModel;
      const maxInputBytes = operationPositiveLimit(
        args.request.maxInputBytes ?? args.defaults.maxInputBytes,
        "maxInputBytes",
        requestId,
      );
      const maxOutputBytes = operationPositiveLimit(
        args.request.maxOutputBytes ?? args.defaults.maxOutputBytes,
        "maxOutputBytes",
        requestId,
      );
      const maxRetries = operationNonNegativeInteger(
        args.request.maxRetries ?? args.defaults.maxRetries,
        "maxRetries",
        requestId,
      );
      const messages = normalizeMessages(args.request, requestId);
      assertByteLimit(
        { systemPrompt: args.request.instructions ?? "", messages },
        maxInputBytes,
        "input",
        requestId,
      );
      const capabilities = resolveCapabilities(
        args.runtime,
        requestedModel,
        args.request.principal,
        args.request.authContext,
        requestId,
      );
      assertRequestCapabilities(capabilities, undefined, requestId);
      assertTemperatureCapability(
        capabilities,
        args.request.temperature,
        requestId,
      );
      const maxTokens = resolveMaxTokens(
        args.request.maxOutputTokens,
        capabilities,
        requestId,
      );
      let text = "";
      let usage: CoreModelUsage | undefined;
      let finishReason: CoreModelStopReason | undefined;
      let terminationEvidence: "observed" | "inferred" | undefined;
      let dispatches = 0;
      let attempts = 0;
      let effectiveModel = requestedModel.modelId;
      for await (const event of args.runtime.stream({
        principal: args.request.principal,
        authContext: args.request.authContext,
        model: requestedModel,
        request: {
          systemPrompt: args.request.instructions ?? "",
          messages,
          maxTokens,
          temperature: args.request.temperature,
          state: { store: false },
          executionControls: {
            maxRetries,
            maxOutputBytes,
            beforeModelDispatch: () => {
              dispatches += 1;
              if (abort.signal.aborted) {
                throw cancellationError(abort, requestId);
              }
              if (dispatches > maxRetries + 1) {
                throw new AgentClientError(
                  "limit_exceeded",
                  "The model attempt budget was exceeded",
                  requestId,
                );
              }
            },
          },
          signal: abort.signal,
          onProviderRequestAttempt: (attempt) => {
            attempts += 1;
            effectiveModel = attempt.model;
            args.request.onProviderRequestAttempt?.(attempt);
          },
        },
      })) {
        if (event.type === "text_delta") {
          text += event.text;
          yield { type: "text.delta", text: event.text };
        } else if (event.type === "usage") {
          usage = coreUsageFromEvent(event);
          yield { type: "usage", usage };
        } else if (event.type === "model_stop") {
          finishReason = event.reason;
          terminationEvidence = event.terminationEvidence;
        }
      }
      if (finishReason === "refusal") {
        throw new AgentClientError(
          "refused",
          "The model refused the request",
          requestId,
        );
      }
      const result: AgentClientGenerationResult = {
        text,
        usage,
        finishReason,
        terminationEvidence,
        attempts,
        requestId,
        requestedModel,
        effectiveModel,
      };
      settled = true;
      yield { type: "completed", result };
      return result;
    } catch (error) {
      const mapped = mapClientError(
        error,
        requestId,
        abort.timedOut(),
        abort.hostAborted(),
      );
      settled = true;
      const info = toClientErrorInfo(mapped);
      yield {
        type: mapped.code === "cancelled" ? "cancelled" : "error",
        error: info,
      };
      return undefined;
    } finally {
      if (!settled) consumerAbort.abort("text stream consumer closed");
      abort.dispose();
    }
  })();
}

async function collectAgentClientRun(
  stream: AgentClientRunStream,
): Promise<AgentClientRunResult> {
  let requestId = "unknown";
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      if (next.value) return next.value;
      throw new AgentClientError(
        "provider_error",
        "The request-scoped workflow ended without a terminal result",
        requestId,
      );
    }
    if (next.value.type === "run.started") requestId = next.value.requestId;
  }
}

function streamAgentClientRun<TPrincipal extends AgentPrincipal>(args: {
  runtime: CoreModelRuntime;
  defaultModel: AgentModelReference;
  defaults: Required<AgentClientLimits>;
  createRequestId: () => string;
  request: AgentClientRunRequest<TPrincipal>;
}): AgentClientRunStream {
  return (async function* (): AgentClientRunStream {
    const requestId = args.createRequestId();
    const consumerAbort = new AbortController();
    const abort = createDeadlineSignal(
      combineClientSignals(args.request.signal, consumerAbort.signal),
      operationPositiveLimit(
        args.request.timeoutMs ?? args.defaults.timeoutMs,
        "timeoutMs",
        requestId,
      ),
    );
    let settled = false;
    const requestedModel = args.request.model ?? args.defaultModel;
    let attempts = 0;
    let privateHistory: readonly CoreModelMessage[] | undefined;
    let lastExecution = emptyClientExecution();
    let lastUsage: CoreModelUsage | undefined;
    let resolvedModel: AgentModelReference | undefined;
    const toolOutcomes: AgentClientToolOutcome[] = [];
    let kernelStream:
      | ReturnType<
          ReturnType<typeof createHeadlessTurnKernel<TPrincipal>>["runTurn"]
        >
      | undefined;
    try {
      yield { type: "run.started", requestId };
      const maxInputBytes = operationPositiveLimit(
        args.request.maxInputBytes ?? args.defaults.maxInputBytes,
        "maxInputBytes",
        requestId,
      );
      const maxOutputBytes = operationPositiveLimit(
        args.request.maxOutputBytes ?? args.defaults.maxOutputBytes,
        "maxOutputBytes",
        requestId,
      );
      const maxRetries = operationNonNegativeInteger(
        args.request.maxRetries ?? args.defaults.maxRetries,
        "maxRetries",
        requestId,
      );
      const maxQueuedEventBytes = operationPositiveLimit(
        args.request.limits?.maxQueuedEventBytes ??
          args.defaults.maxQueuedEventBytes,
        "maxQueuedEventBytes",
        requestId,
      );
      if (args.request.tools && args.request.resolveTools) {
        throw new AgentClientError(
          "invalid_request",
          "Provide tools or resolveTools, not both",
          requestId,
        );
      }
      const turnId = `request-turn-${randomUUID()}`;
      const sessionId = `request-session-${randomUUID()}`;
      const resolvedTools = args.request.resolveTools
        ? await args.request.resolveTools({
            principal: args.request.principal,
            sessionId,
            turnId,
            input: args.request.input,
          })
        : (args.request.tools ?? []);
      if (
        resolvedTools.some((tool) => tool.authorization === "required") &&
        !args.request.authorizeToolCall
      ) {
        throw new AgentClientError(
          "invalid_request",
          "A tool requiring authorization has no request-scoped authorization callback",
          requestId,
        );
      }
      const history = structuredClone([...(args.request.history ?? [])]);
      assertByteLimit(
        {
          systemPrompt: args.request.instructions ?? "",
          history,
          input: args.request.input,
          tools: resolvedTools.map((tool) => tool.definition),
        },
        maxInputBytes,
        "input",
        requestId,
      );
      const capabilities = resolveCapabilities(
        args.runtime,
        requestedModel,
        args.request.principal,
        args.request.authContext,
        requestId,
      );
      assertRequestCapabilities(capabilities, undefined, requestId);
      assertTemperatureCapability(
        capabilities,
        args.request.temperature,
        requestId,
      );
      const maxTokens = resolveMaxTokens(
        args.request.maxOutputTokens,
        capabilities,
        requestId,
      );
      const turnLimits = normalizeClientRunLimits(
        args.request.limits,
        operationPositiveLimit(
          args.request.timeoutMs ?? args.defaults.timeoutMs,
          "timeoutMs",
          requestId,
        ),
        requestId,
      );
      const kernel = createHeadlessTurnKernel<TPrincipal>({
        models: args.runtime,
        tools: resolvedTools,
        defaultLimits: turnLimits,
        resolveAuthContext: () => args.request.authContext,
        authorizeToolCall: args.request.authorizeToolCall
          ? async (authorization) => {
              const decision = await args.request.authorizeToolCall!({
                principal: authorization.principal,
                requestId,
                model: authorization.model.model,
                toolCallId: authorization.toolCallId,
                toolName: authorization.toolName,
                input: authorization.input,
                displayInput: authorization.displayInput,
                effect: authorization.effect,
                signal: abort.signal,
              });
              if (abort.signal.aborted) throw abortLikeError(abort.signal);
              if (
                !decision ||
                (decision.decision !== "allow" && decision.decision !== "deny")
              ) {
                throw new HostToolPublicError(
                  "Tool authorization must return allow or deny",
                  { code: "invalid_tool_authorization" },
                );
              }
              return decision.decision === "allow"
                ? { decision: "allow" as const }
                : {
                    decision: "deny" as const,
                    ...(decision.reason ? { reason: decision.reason } : {}),
                  };
            }
          : undefined,
      });
      kernelStream = kernel.runTurn(
        {
          request: {
            principal: args.request.principal,
            sessionId,
            input: structuredClone(args.request.input),
            model: requestedModel,
            reasoningEffort: args.request.reasoningEffort,
          },
          turnId,
          history,
          sessionModel: undefined,
          runtimeDefaultModel: args.defaultModel,
          systemPrompt: args.request.instructions ?? "",
          maxOutputTokens: maxTokens,
          reasoningEffort: args.request.reasoningEffort,
          limits: turnLimits,
          sessionRevision: "request-scoped",
        },
        {
          signal: abort.signal,
          maxModelOutputBytes: maxOutputBytes,
          maxQueuedEventBytes,
          modelRequest: {
            temperature: args.request.temperature,
            state: { store: false },
            executionControls: {
              maxRetries,
              maxOutputBytes,
              beforeModelDispatch: () => {
                if (abort.signal.aborted) throw abortLikeError(abort.signal);
              },
            },
            onProviderRequestAttempt: (attempt) => {
              attempts += 1;
              args.request.onProviderRequestAttempt?.(attempt);
            },
          },
          onDurableState: (state) => {
            privateHistory = structuredClone(state.messages);
            lastUsage = state.usage ? structuredClone(state.usage) : undefined;
          },
        },
      );
      for (;;) {
        const next = await kernelStream.next();
        if (next.done) {
          const result = toClientRunResult({
            terminal: next.value,
            requestId,
            requestedModel,
            attempts,
            toolOutcomes,
            privateHistory:
              args.request.includePrivateHistory === true
                ? privateHistory
                : undefined,
            abort,
          });
          settled = true;
          yield terminalRunEvent(result);
          return result;
        }
        if (next.value.type === "execution.updated") {
          lastExecution = structuredClone(next.value.event.snapshot);
        } else if (next.value.type === "usage.updated") {
          lastUsage = structuredClone(next.value.usage);
        } else if (next.value.type === "model.resolved") {
          resolvedModel = structuredClone(
            next.value.provenance.resolvedModel.model,
          );
        }
        const projected = projectRunEvent(next.value, toolOutcomes);
        if (projected) yield projected;
      }
    } catch (error) {
      const mapped = mapClientError(
        error,
        requestId,
        abort.timedOut(),
        abort.hostAborted(),
      );
      const result = failedRunResult({
        requestId,
        requestedModel,
        error: mapped,
        attempts,
        execution: lastExecution,
        usage: lastUsage,
        resolvedModel,
        toolOutcomes,
        privateHistory:
          args.request.includePrivateHistory === true
            ? privateHistory
            : undefined,
      });
      settled = true;
      yield terminalRunEvent(result);
      return result;
    } finally {
      if (!settled) {
        consumerAbort.abort("run stream consumer closed");
        await kernelStream?.return(undefined as never).catch(() => undefined);
      }
      abort.dispose();
    }
  })();
}

function projectRunEvent(
  event: AgentTurnEvent,
  toolOutcomes: AgentClientToolOutcome[],
): AgentClientRunEvent | undefined {
  if (event.type === "model.resolved") {
    return {
      type: "model.resolved",
      model: event.provenance.resolvedModel.model,
    };
  }
  if (event.type === "text.delta") {
    return { type: "text.delta", text: event.text };
  }
  if (event.type === "tool.requested") {
    return {
      type: "tool.requested",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      effect: event.effect,
      ...(event.displayInput !== undefined
        ? { displayInput: structuredClone(event.displayInput) }
        : {}),
    };
  }
  if (event.type === "tool.started") {
    return {
      type: "tool.started",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      effect: event.effect,
    };
  }
  if (event.type === "tool.completed") {
    const outcome: AgentClientToolOutcome = {
      type: "completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      effect: event.effect,
      ...(event.displayContent !== undefined
        ? { displayContent: structuredClone(event.displayContent) }
        : {}),
    };
    toolOutcomes.push(outcome);
    return { type: "tool.completed", ...withoutOutcomeType(outcome) };
  }
  if (event.type === "tool.failed") {
    const outcome: AgentClientToolOutcome = {
      type: "failed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      effect: event.effect,
      error: {
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
      },
    };
    toolOutcomes.push(outcome);
    return { type: "tool.failed", ...withoutOutcomeType(outcome) };
  }
  if (event.type === "usage.updated") {
    return { type: "usage", usage: structuredClone(event.usage) };
  }
  if (event.type === "execution.updated") {
    return {
      type: "execution",
      execution: structuredClone(event.event.snapshot),
    };
  }
  return undefined;
}

function withoutOutcomeType(
  outcome: AgentClientToolOutcome,
): Omit<AgentClientToolOutcome, "type"> {
  const { type: _type, ...safe } = outcome;
  return safe;
}

function toClientRunResult(args: {
  terminal: AgentTurnResult;
  requestId: string;
  requestedModel: AgentModelReference;
  attempts: number;
  toolOutcomes: readonly AgentClientToolOutcome[];
  privateHistory?: readonly CoreModelMessage[];
  abort: ReturnType<typeof createDeadlineSignal>;
}): AgentClientRunResult {
  const base = {
    requestId: args.requestId,
    usage:
      args.terminal.status === "suspended" ? undefined : args.terminal.usage,
    execution: structuredClone(args.terminal.execution),
    requestedModel: args.requestedModel,
    resolvedModel: args.terminal.provenance.resolvedModel?.model,
    attempts: args.attempts,
    toolOutcomes: structuredClone(args.toolOutcomes),
    ...(args.privateHistory
      ? { privateHistory: structuredClone(args.privateHistory) }
      : {}),
  };
  if (args.terminal.status === "completed") {
    if (args.terminal.stopReason === "refusal") {
      return {
        ...base,
        status: "failed",
        error: toClientErrorInfo(
          new AgentClientError(
            "refused",
            "The model refused the request",
            args.requestId,
          ),
        ),
      };
    }
    return {
      ...base,
      status: "completed",
      text: args.terminal.text,
      stopReason: args.terminal.stopReason,
    };
  }
  if (args.terminal.status === "cancelled" && !args.abort.timedOut()) {
    return {
      ...base,
      status: "cancelled",
      reason: args.terminal.reason,
    };
  }
  const error =
    args.terminal.status === "failed"
      ? mapTurnError(args.terminal.error, args.requestId)
      : new AgentClientError(
          args.abort.timedOut() ? "timeout" : "provider_error",
          args.abort.timedOut()
            ? "The model request timed out"
            : "The request-scoped workflow could not complete",
          args.requestId,
          args.abort.timedOut(),
        );
  return { ...base, status: "failed", error: toClientErrorInfo(error) };
}

function failedRunResult(args: {
  requestId: string;
  requestedModel: AgentModelReference;
  error: AgentClientError;
  attempts: number;
  execution: TurnExecutionSnapshot;
  usage?: CoreModelUsage;
  resolvedModel?: AgentModelReference;
  toolOutcomes: readonly AgentClientToolOutcome[];
  privateHistory?: readonly CoreModelMessage[];
}): Extract<AgentClientRunResult, { status: "failed" }> {
  return {
    status: "failed",
    requestId: args.requestId,
    execution: structuredClone(args.execution),
    requestedModel: args.requestedModel,
    ...(args.resolvedModel
      ? { resolvedModel: structuredClone(args.resolvedModel) }
      : {}),
    ...(args.usage ? { usage: structuredClone(args.usage) } : {}),
    attempts: args.attempts,
    toolOutcomes: structuredClone(args.toolOutcomes),
    error: toClientErrorInfo(args.error),
    ...(args.privateHistory
      ? { privateHistory: structuredClone(args.privateHistory) }
      : {}),
  };
}

function terminalRunEvent(result: AgentClientRunResult): AgentClientRunEvent {
  const safe = withoutPrivateHistory(result);
  if (result.status === "completed") return { type: "completed", result: safe };
  if (result.status === "cancelled") return { type: "cancelled", result: safe };
  return { type: "error", result: safe };
}

function withoutPrivateHistory(
  result: AgentClientRunResult,
): AgentClientSafeRunResult {
  const { privateHistory: _privateHistory, ...safe } = result;
  return safe as AgentClientSafeRunResult;
}

function mapTurnError(
  error: Extract<AgentTurnResult, { status: "failed" }>["error"],
  requestId: string,
): AgentClientError {
  const code: AgentClientErrorCode =
    error.code === "turn_execution_limit_reached" ||
    error.code === "turn_event_queue_limit_reached" ||
    error.code === "model_attempt_limit_exceeded" ||
    error.code === "model_output_limit_exceeded"
      ? "limit_exceeded"
      : error.code === "provider_timeout"
        ? "timeout"
        : error.code === "provider_authentication_required"
          ? "authentication"
          : error.code === "provider_rate_limited"
            ? "rate_limit"
            : error.code === "provider_unavailable"
              ? "provider_unavailable"
              : error.code === "model_capability_unsupported"
                ? "unsupported_capability"
                : error.code === "invalid_tool_authorization"
                  ? "invalid_request"
                  : "provider_error";
  return new AgentClientError(
    code,
    safeTurnErrorMessage(code),
    requestId,
    error.retryable,
  );
}

function safeTurnErrorMessage(code: AgentClientErrorCode): string {
  if (code === "limit_exceeded")
    return "The request-scoped workflow exceeded a configured limit";
  if (code === "timeout") return "The model request timed out";
  return safeProviderMessage(code);
}

function toClientErrorInfo(error: AgentClientError): AgentClientErrorInfo {
  return {
    code: error.code,
    message: error.message,
    requestId: error.requestId,
    retryable: error.retryable,
  };
}

function abortLikeError(signal: AbortSignal): Error {
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Request cancelled",
  );
  error.name = "AbortError";
  return error;
}

function cancellationError(
  abort: ReturnType<typeof createDeadlineSignal>,
  requestId: string,
): AgentClientError {
  return new AgentClientError(
    abort.timedOut() ? "timeout" : "cancelled",
    abort.timedOut()
      ? "The model request timed out"
      : "The model request was cancelled",
    requestId,
    abort.timedOut(),
  );
}

function coreUsageFromEvent(
  event: Extract<
    import("./modelRuntime.js").CoreModelStreamEvent,
    { type: "usage" }
  >,
): CoreModelUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cacheReadTokens !== undefined
      ? { cacheReadTokens: event.cacheReadTokens }
      : {}),
    ...(event.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: event.cacheCreationTokens }
      : {}),
    ...(event.inputTokenBreakdownReported !== undefined
      ? { inputTokenBreakdownReported: event.inputTokenBreakdownReported }
      : {}),
    ...(event.serverToolUsage
      ? { serverToolUsage: event.serverToolUsage }
      : {}),
    ...(event.estimated !== undefined ? { estimated: event.estimated } : {}),
  };
}

function normalizeClientRunLimits(
  limits: AgentClientRunLimits | undefined,
  defaultTimeoutMs: number,
  requestId: string,
): TurnExecutionLimits {
  const result: TurnExecutionLimits = {};
  for (const key of [
    "maxModelCalls",
    "maxToolCalls",
    "maxElapsedMs",
    "maxToolResultBytes",
  ] as const) {
    const value = limits?.[key];
    if (value !== undefined) {
      result[key] = operationPositiveLimit(value, key, requestId);
    }
  }
  result.maxElapsedMs = Math.min(
    result.maxElapsedMs ?? defaultTimeoutMs,
    defaultTimeoutMs,
  );
  return result;
}

function emptyClientExecution(): TurnExecutionSnapshot {
  return {
    limits: {
      maxModelCalls: 0,
      maxToolCalls: 0,
      maxElapsedMs: 0,
      maxToolResultBytes: 0,
    },
    modelCalls: 0,
    toolCalls: 0,
    elapsedMs: 0,
    toolResultBytes: 0,
  };
}

function combineClientSignals(
  host: AbortSignal | undefined,
  consumer: AbortSignal,
): AbortSignal {
  return host ? AbortSignal.any([host, consumer]) : consumer;
}

interface PreparedSchema<T> {
  jsonSchema: CoreModelJsonSchema;
  name: string;
  parse: (value: unknown) => T;
}

async function executeGeneration(args: {
  runtime: CoreModelRuntime;
  defaultModel: AgentModelReference;
  defaults: Required<AgentClientLimits>;
  createRequestId: () => string;
  request: AgentClientGenerateTextRequest;
  outputMode?: AgentClientOutputMode;
  outputSchema?: PreparedSchema<unknown>;
}): Promise<{
  result: CoreModelCompleteResult;
  attempts: number;
  requestId: string;
  requestedModel: AgentModelReference;
  effectiveModel: string;
}> {
  const requestId = args.createRequestId();
  const requestedModel = args.request.model ?? args.defaultModel;
  const timeoutMs = operationPositiveLimit(
    args.request.timeoutMs ?? args.defaults.timeoutMs,
    "timeoutMs",
    requestId,
  );
  const maxInputBytes = operationPositiveLimit(
    args.request.maxInputBytes ?? args.defaults.maxInputBytes,
    "maxInputBytes",
    requestId,
  );
  const maxOutputBytes = operationPositiveLimit(
    args.request.maxOutputBytes ?? args.defaults.maxOutputBytes,
    "maxOutputBytes",
    requestId,
  );
  const maxRetries = operationNonNegativeInteger(
    args.request.maxRetries ?? args.defaults.maxRetries,
    "maxRetries",
    requestId,
  );
  const messages = normalizeMessages(args.request, requestId);
  assertByteLimit(
    { systemPrompt: args.request.instructions ?? "", messages },
    maxInputBytes,
    "input",
    requestId,
  );
  const capabilities = resolveCapabilities(
    args.runtime,
    requestedModel,
    args.request.principal,
    args.request.authContext,
    requestId,
  );
  assertRequestCapabilities(capabilities, args.outputMode, requestId);
  assertTemperatureCapability(
    capabilities,
    args.request.temperature,
    requestId,
  );
  const maxTokens = resolveMaxTokens(
    args.request.maxOutputTokens,
    capabilities,
    requestId,
  );
  const abort = createDeadlineSignal(args.request.signal, timeoutMs);
  let dispatches = 0;
  let attempts = 0;
  let effectiveModel = requestedModel.modelId;
  try {
    const result = await args.runtime.complete({
      principal: args.request.principal,
      authContext: args.request.authContext,
      model: requestedModel,
      request: {
        systemPrompt: args.request.instructions ?? "",
        messages,
        maxTokens,
        temperature: args.request.temperature,
        state: { store: false },
        ...(args.outputMode === "native" && args.outputSchema
          ? {
              outputFormat: {
                type: "json_schema" as const,
                name: args.outputSchema.name,
                schema: args.outputSchema.jsonSchema,
                strict: false,
              },
            }
          : {}),
        executionControls: {
          maxRetries,
          maxOutputBytes,
          beforeModelDispatch: () => {
            dispatches += 1;
            if (dispatches > maxRetries + 1) {
              throw new AgentClientError(
                "limit_exceeded",
                "The model attempt budget was exceeded",
                requestId,
              );
            }
            if (abort.signal.aborted) {
              throw new AgentClientError(
                abort.timedOut() ? "timeout" : "cancelled",
                abort.timedOut()
                  ? "The model request timed out"
                  : "The model request was cancelled",
                requestId,
              );
            }
          },
        },
        signal: abort.signal,
        onProviderRequestAttempt: (attempt) => {
          attempts += 1;
          effectiveModel = attempt.model;
          args.request.onProviderRequestAttempt?.(attempt);
        },
      },
    });
    if (Buffer.byteLength(result.text, "utf8") > maxOutputBytes) {
      throw new CoreModelOutputLimitError(maxOutputBytes);
    }
    return { result, attempts, requestId, requestedModel, effectiveModel };
  } catch (error) {
    throw mapClientError(
      error,
      requestId,
      abort.timedOut(),
      abort.hostAborted(),
    );
  } finally {
    abort.dispose();
  }
}

function createRuntime(
  providers: readonly CoreModelBackend[],
  ownerId: string,
): CoreModelRuntime {
  const registry = new CoreModelBackendRegistry();
  for (const provider of providers) registry.register(provider);
  return new DefaultCoreModelRuntime(registry, { ownerId });
}

function normalizeLimits(
  limits: AgentClientLimits = {},
): Required<AgentClientLimits> {
  return {
    timeoutMs: positiveLimit(
      limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    ),
    maxInputBytes: positiveLimit(
      limits.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      "maxInputBytes",
    ),
    maxSchemaBytes: positiveLimit(
      limits.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES,
      "maxSchemaBytes",
    ),
    maxOutputBytes: positiveLimit(
      limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    ),
    maxQueuedEventBytes: positiveLimit(
      limits.maxQueuedEventBytes ?? DEFAULT_MAX_QUEUED_EVENT_BYTES,
      "maxQueuedEventBytes",
    ),
    maxRetries: nonNegativeInteger(
      limits.maxRetries ?? DEFAULT_MAX_RETRIES,
      "maxRetries",
    ),
  };
}

function normalizeMessages(
  request: AgentClientPromptInput,
  requestId: string,
): CoreModelMessage[] {
  const hasPrompt = typeof request.prompt === "string";
  const hasMessages = Array.isArray(request.messages);
  if (hasPrompt === hasMessages) {
    throw new AgentClientError(
      "invalid_request",
      "Provide exactly one of prompt or messages",
      requestId,
    );
  }
  return hasPrompt
    ? [{ role: "user", content: request.prompt! }]
    : structuredClone([...request.messages!]);
}

function prepareSchema<T>(
  schema: AgentClientObjectSchema<T>,
  requestedName: string | undefined,
  maxSchemaBytes: number,
  requestId: string,
): PreparedSchema<T> {
  let jsonSchema: CoreModelJsonSchema;
  let parse: (value: unknown) => T;
  let name = requestedName;
  if (isJsonSchemaDescriptor(schema)) {
    jsonSchema = structuredClone(schema.jsonSchema);
    parse = schema.parse;
    name ??= schema.name;
  } else {
    try {
      const generated = z.toJSONSchema(schema, {
        io: "input",
        target: "draft-2020-12",
      }) as Record<string, unknown>;
      const { $schema: _dialect, ...portable } = generated;
      jsonSchema = portable as CoreModelJsonSchema;
    } catch (error) {
      throw new AgentClientError(
        "unsupported_schema",
        "The Zod schema cannot be represented as JSON Schema",
        requestId,
        false,
        { cause: error },
      );
    }
    parse = (value) => schema.parse(value);
  }
  if (!isRecord(jsonSchema) || jsonSchema.type !== "object") {
    throw new AgentClientError(
      "unsupported_schema",
      "Structured output requires an object-root schema",
      requestId,
    );
  }
  assertByteLimit(jsonSchema, maxSchemaBytes, "schema", requestId);
  const normalizedName = name?.trim() || "agentlink_output";
  if (
    !/^[A-Za-z0-9_-]+$/.test(normalizedName) ||
    normalizedName.length > MAX_SCHEMA_NAME_LENGTH
  ) {
    throw new AgentClientError(
      "invalid_request",
      "schemaName must use 1-64 letters, numbers, underscores, or hyphens",
      requestId,
    );
  }
  return { jsonSchema, name: normalizedName, parse };
}

function isJsonSchemaDescriptor<T>(
  schema: AgentClientObjectSchema<T>,
): schema is AgentClientJsonSchema<T> {
  return (
    isRecord(schema) &&
    "jsonSchema" in schema &&
    typeof schema.parse === "function"
  );
}

function resolveCapabilities(
  runtime: CoreModelRuntime,
  model: AgentModelReference,
  principal: AgentPrincipal,
  authContext: CoreModelAuthContext | undefined,
  requestId: string,
): CoreModelCapabilities {
  try {
    const capabilities = runtime.getCapabilities({
      principal,
      authContext,
      model,
    });
    if (capabilities) return capabilities;
  } catch (error) {
    throw new AgentClientError(
      "invalid_request",
      "The selected model is unavailable",
      requestId,
      false,
      { cause: error },
    );
  }
  throw new AgentClientError(
    "invalid_request",
    "The selected model is unavailable",
    requestId,
  );
}

function assertRequestCapabilities(
  capabilities: CoreModelCapabilities,
  outputMode: AgentClientOutputMode | undefined,
  requestId: string,
): void {
  if (!capabilities.requestControls) {
    throw new AgentClientError(
      "unsupported_capability",
      "The selected model backend cannot enforce request-scoped retry and output limits",
      requestId,
    );
  }
  if (outputMode && capabilities.completionEvidence !== "authoritative") {
    throw new AgentClientError(
      "unsupported_capability",
      "The selected model backend cannot provide authoritative completion evidence",
      requestId,
    );
  }
  if (
    outputMode === "native" &&
    capabilities.structuredOutput !== "json_schema"
  ) {
    throw new AgentClientError(
      "unsupported_capability",
      "The selected model does not support native JSON Schema output",
      requestId,
    );
  }
}

function assertTemperatureCapability(
  capabilities: CoreModelCapabilities,
  temperature: number | undefined,
  requestId: string,
): void {
  if (temperature === undefined) return;
  if (!Number.isFinite(temperature)) {
    throw new AgentClientError(
      "invalid_request",
      "temperature must be finite",
      requestId,
    );
  }
  if (capabilities.supportsTemperature !== true) {
    throw new AgentClientError(
      "unsupported_capability",
      "The selected model does not support temperature",
      requestId,
    );
  }
}

function resolveMaxTokens(
  requested: number | undefined,
  capabilities: CoreModelCapabilities,
  requestId: string,
): number {
  if (
    requested !== undefined &&
    capabilities.supportsMaxOutputTokens !== true
  ) {
    throw new AgentClientError(
      "unsupported_capability",
      "The selected model endpoint cannot enforce maxOutputTokens",
      requestId,
    );
  }
  const value = requested ?? Math.min(4_096, capabilities.maxOutputTokens);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > capabilities.maxOutputTokens
  ) {
    throw new AgentClientError(
      "invalid_request",
      `maxOutputTokens must be between 1 and ${capabilities.maxOutputTokens}`,
      requestId,
    );
  }
  return value;
}

function assertTextFinish(
  result: CoreModelCompleteResult,
  requestId: string,
): void {
  if (result.stopReason === "refusal") {
    throw new AgentClientError(
      "refused",
      "The model refused the request",
      requestId,
    );
  }
}

function assertTypedFinish(
  result: CoreModelCompleteResult,
  requestId: string,
): void {
  if (result.stopReason === "refusal") {
    throw new AgentClientError(
      "refused",
      "The model refused the request",
      requestId,
    );
  }
  if (result.stopReason === "max_tokens") {
    throw new AgentClientError(
      "output_truncated",
      "The model output was truncated",
      requestId,
    );
  }
  if (
    result.stopReason !== "end_turn" ||
    result.terminationEvidence !== "observed"
  ) {
    throw new AgentClientError(
      "invalid_output",
      "The model did not provide an authoritative successful completion",
      requestId,
    );
  }
}

function toTextResult(execution: {
  result: CoreModelCompleteResult;
  attempts: number;
  requestId: string;
  requestedModel: AgentModelReference;
  effectiveModel: string;
}): AgentClientGenerationResult {
  return {
    text: execution.result.text,
    usage: execution.result.usage,
    finishReason: execution.result.stopReason,
    terminationEvidence: execution.result.terminationEvidence,
    attempts: execution.attempts,
    requestId: execution.requestId,
    requestedModel: execution.requestedModel,
    effectiveModel: execution.effectiveModel,
  };
}

function createDeadlineSignal(
  source: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let cause: "host" | "timeout" | undefined;
  const onAbort = () => {
    if (cause) return;
    cause = "host";
    controller.abort(source?.reason);
  };
  if (source?.aborted) onAbort();
  else source?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    if (cause) return;
    cause = "timeout";
    controller.abort(new Error("Agent client deadline exceeded"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => cause === "timeout",
    hostAborted: () => cause === "host",
    dispose: () => {
      clearTimeout(timer);
      source?.removeEventListener("abort", onAbort);
    },
  };
}

function mapClientError(
  error: unknown,
  requestId: string,
  timedOut: boolean,
  hostAborted: boolean,
): AgentClientError {
  if (error instanceof AgentClientError) return error;
  if (timedOut || error instanceof OpenAiCompatibleTimeoutError) {
    return new AgentClientError(
      "timeout",
      "The model request timed out",
      requestId,
      true,
      { cause: error },
    );
  }
  if (
    hostAborted ||
    error instanceof OpenAiCompatibleAbortError ||
    isAbortError(error)
  ) {
    return new AgentClientError(
      "cancelled",
      "The model request was cancelled",
      requestId,
      false,
      { cause: error },
    );
  }
  if (
    error instanceof CoreModelAttemptLimitError ||
    error instanceof CoreModelOutputLimitError ||
    error instanceof HeadlessTurnEventQueueLimitError
  ) {
    return new AgentClientError(
      "limit_exceeded",
      error instanceof CoreModelAttemptLimitError
        ? "The model attempt budget was exceeded"
        : "The model output exceeded the configured byte limit",
      requestId,
      false,
      { cause: error },
    );
  }
  if (error instanceof OpenAiCompatibleRequestError) {
    const code = error.authentication
      ? "authentication"
      : error.status === 408 || error.providerCode === "timeout"
        ? "timeout"
        : error.status === 429
          ? "rate_limit"
          : error.status !== undefined && error.status >= 500
            ? "provider_unavailable"
            : error.providerCode === "unsupported_capability"
              ? "unsupported_capability"
              : "provider_error";
    return new AgentClientError(
      code,
      safeProviderMessage(code),
      requestId,
      error.retryable,
      {
        cause: error,
      },
    );
  }
  if (error instanceof CodexRequestError) {
    const code =
      error.status === 401 ||
      error.status === 403 ||
      error.code === "auth_required" ||
      error.code === "auth_method_mismatch"
        ? "authentication"
        : error.status === 408
          ? "timeout"
          : error.status === 429
            ? "rate_limit"
            : error.status !== undefined && error.status >= 500
              ? "provider_unavailable"
              : error.code === "unsupported_capability"
                ? "unsupported_capability"
                : "provider_error";
    return new AgentClientError(
      code,
      safeProviderMessage(code),
      requestId,
      error.retryable === true,
      { cause: error },
    );
  }
  return new AgentClientError(
    "provider_error",
    "The model request failed",
    requestId,
    false,
    { cause: error },
  );
}

function safeProviderMessage(code: AgentClientErrorCode): string {
  if (code === "authentication") return "Model provider authentication failed";
  if (code === "rate_limit") return "The model provider rate limit was reached";
  if (code === "provider_unavailable")
    return "The model provider is unavailable";
  if (code === "unsupported_capability")
    return "The model provider does not support the requested capability";
  return "The model provider request failed";
}

function assertByteLimit(
  value: unknown,
  limit: number,
  label: "input" | "schema",
  requestId: string,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new AgentClientError(
      "invalid_request",
      `The ${label} must be JSON serializable`,
      requestId,
      false,
      { cause: error },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new AgentClientError(
      "limit_exceeded",
      `The ${label} exceeded the ${limit}-byte limit`,
      requestId,
    );
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function operationPositiveLimit(
  value: number,
  name: string,
  requestId: string,
): number {
  try {
    return positiveLimit(value, name);
  } catch (error) {
    throw new AgentClientError(
      "invalid_request",
      `${name} must be a positive safe integer`,
      requestId,
      false,
      { cause: error },
    );
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function operationNonNegativeInteger(
  value: number,
  name: string,
  requestId: string,
): number {
  try {
    return nonNegativeInteger(value, name);
  } catch (error) {
    throw new AgentClientError(
      "invalid_request",
      `${name} must be a non-negative safe integer`,
      requestId,
      false,
      { cause: error },
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

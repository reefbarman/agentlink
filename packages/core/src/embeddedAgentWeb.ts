import type {
  AgentEngine,
  AgentSessionHydration,
  AgentSessionInspection,
} from "./agentEngine.js";
import type { AgentTurnEvent, AgentTurnStream } from "./turnContracts.js";
import {
  EMBEDDED_AGENT_TRANSPORT_VERSION,
  isCoreReasoningEffort,
} from "@agentlink/protocol";
import type {
  EmbeddedAgentError,
  EmbeddedAgentInteraction,
  EmbeddedAgentRequest,
  EmbeddedAgentResponse,
  EmbeddedAgentSessionSnapshot,
  EmbeddedAgentStreamFrame,
  EmbeddedAgentTurnEvent,
  EmbeddedAgentTurnResult,
} from "@agentlink/protocol";

import { AgentEngineError } from "./agentEngine.js";
import type { AgentPrincipal } from "./modelIdentity.js";
import { embeddedAgentErrorCategory } from "@agentlink/protocol/embedded-agent-presentation";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_SESSION_ID_LENGTH = 256;
const DEFAULT_MAX_MESSAGE_LENGTH = 1_000_000;

export interface EmbeddedAgentWebAuthorizationRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Original Web request for origin/header policy. */
  readonly request: Request;
  readonly principal: TPrincipal;
  readonly operation: EmbeddedAgentRequest["type"];
  readonly parsedRequest: EmbeddedAgentRequest;
  readonly sessionId: string;
}

export interface EmbeddedAgentWebMessageValidationRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends EmbeddedAgentWebAuthorizationRequest<TPrincipal> {
  readonly parsedRequest: Extract<EmbeddedAgentRequest, { type: "turn" }>;
  readonly message: string;
}

export interface CreateEmbeddedAgentWebHandlerOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly engine: AgentEngine<TPrincipal>;
  /** Derive principal and data-realm identity from trusted host authentication. */
  readonly authenticate: (
    request: Request,
  ) => TPrincipal | null | Promise<TPrincipal | null>;
  /** Optional same-origin/CSRF or other ingress policy. */
  readonly authorizeRequest?: (
    request: EmbeddedAgentWebAuthorizationRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  /** Optional per-principal/session rate or quota policy. */
  readonly rateLimit?: (
    request: EmbeddedAgentWebAuthorizationRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  /** Optional principal-aware admission policy for every parsed session ID. */
  readonly validateSessionId?: (
    request: EmbeddedAgentWebAuthorizationRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  /** Optional principal-aware admission policy for parsed turn messages. */
  readonly validateMessage?: (
    request: EmbeddedAgentWebMessageValidationRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  /** Explicit host-safe UI projection; raw model transcript is never returned automatically. */
  readonly projectHydration?: (request: {
    readonly principal: TPrincipal;
    readonly hydration: AgentSessionHydration<TPrincipal>;
  }) => unknown | Promise<unknown>;
  readonly maxBodyBytes?: number;
  readonly maxSessionIdLength?: number;
  readonly maxMessageLength?: number;
}

export interface ParseEmbeddedAgentRequestOptions {
  readonly maxSessionIdLength?: number;
  readonly maxMessageLength?: number;
}

export function createEmbeddedAgentWebHandler<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: CreateEmbeddedAgentWebHandlerOptions<TPrincipal>) {
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    "maxBodyBytes",
  );
  const maxSessionIdLength = positiveInteger(
    options.maxSessionIdLength ?? DEFAULT_MAX_SESSION_ID_LENGTH,
    "maxSessionIdLength",
  );
  const maxMessageLength = positiveInteger(
    options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
    "maxMessageLength",
  );
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonError(
        405,
        "method_not_allowed",
        "Use POST for embedded-agent requests",
      );
    }
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return jsonError(
        415,
        "content_type_required",
        "Content-Type must be application/json",
      );
    }
    try {
      const principal = await options.authenticate(request);
      if (!principal)
        return jsonError(401, "unauthenticated", "Authentication is required");
      const operation = parseEmbeddedAgentRequest(
        await readBoundedJson(request, maxBodyBytes),
        { maxSessionIdLength, maxMessageLength },
      );
      const policyRequest: EmbeddedAgentWebAuthorizationRequest<TPrincipal> = {
        request,
        principal,
        operation: operation.type,
        parsedRequest: operation,
        sessionId: operation.sessionId,
      };
      if (
        options.validateSessionId &&
        !(await options.validateSessionId(policyRequest))
      ) {
        return jsonError(
          400,
          "session_id_rejected",
          "The session ID is not allowed",
        );
      }
      if (
        operation.type === "turn" &&
        options.validateMessage &&
        !(await options.validateMessage({
          ...policyRequest,
          parsedRequest: operation,
          message: operation.text,
        }))
      ) {
        return jsonError(400, "message_rejected", "The message is not allowed");
      }
      if (
        options.authorizeRequest &&
        !(await options.authorizeRequest(policyRequest))
      ) {
        return jsonError(
          403,
          "request_forbidden",
          "The request is not allowed",
        );
      }
      if (options.rateLimit && !(await options.rateLimit(policyRequest))) {
        return jsonError(429, "rate_limited", "Too many requests", true);
      }
      return await dispatchEmbeddedAgentRequest(
        options,
        principal,
        operation,
        request.signal,
      );
    } catch (error) {
      const mapped = mapEmbeddedAgentError(error);
      return jsonError(
        mapped.status,
        mapped.error.code,
        mapped.error.message,
        mapped.error.retryable,
      );
    }
  };
}

async function dispatchEmbeddedAgentRequest<TPrincipal extends AgentPrincipal>(
  options: CreateEmbeddedAgentWebHandlerOptions<TPrincipal>,
  principal: TPrincipal,
  request: EmbeddedAgentRequest,
  signal: AbortSignal,
): Promise<Response> {
  const scope = { principal, sessionId: request.sessionId };
  switch (request.type) {
    case "create": {
      const created = await options.engine.sessions.create({
        ...scope,
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort !== undefined
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
      });
      return jsonResponse({
        schemaVersion: 1,
        ok: true,
        type: "inspection",
        session: sessionSnapshot({
          summary: {
            principal: created.record.principal,
            sessionId: created.record.sessionId,
            createdAt: created.record.createdAt,
            updatedAt: created.record.updatedAt,
            runState: created.record.runState,
            revision: created.revision,
          },
        }),
      });
    }
    case "inspect": {
      const inspection = await options.engine.sessions.inspect(scope);
      return jsonResponse(inspectionResponse(inspection));
    }
    case "hydrate": {
      const hydration = await options.engine.sessions.hydrate(scope);
      const projection = options.projectHydration
        ? await options.projectHydration({ principal, hydration })
        : undefined;
      return jsonResponse(inspectionResponse(hydration, projection));
    }
    case "cancel": {
      const result = await options.engine.sessions.cancel({
        ...scope,
        ...(request.reason ? { reason: request.reason } : {}),
      });
      return jsonResponse({
        schemaVersion: 1,
        ok: true,
        type: "cancelled",
        result,
      });
    }
    case "recover": {
      await options.engine.sessions.recoverInterrupted({
        ...scope,
        ...(request.reason ? { reason: request.reason } : {}),
      });
      return jsonResponse(
        inspectionResponse(await options.engine.sessions.inspect(scope)),
      );
    }
    case "delete": {
      await options.engine.sessions.delete({
        ...scope,
        ...(request.expectedRevision
          ? { expectedRevision: request.expectedRevision }
          : {}),
      });
      return jsonResponse({ schemaVersion: 1, ok: true, type: "deleted" });
    }
    case "turn":
      return streamResponse(
        (streamSignal) =>
          options.engine.sessions.runTurn(
            {
              ...scope,
              input: { text: request.text, attachments: undefined },
              model: request.model,
              ...(request.reasoningEffort !== undefined
                ? { reasoningEffort: request.reasoningEffort }
                : {}),
            },
            { signal: streamSignal },
          ),
        signal,
      );
    case "resume":
      return streamResponse(
        (streamSignal) =>
          options.engine.sessions.resumeInteraction(
            {
              ...scope,
              turnId: request.turnId,
              interactionId: request.interactionId,
              interactionRevision: request.interactionRevision,
              expectedSessionRevision: request.expectedSessionRevision,
              decision: request.decision,
            },
            { signal: streamSignal },
          ),
        signal,
      );
  }
}

function streamResponse(
  createStream: (signal: AbortSignal) => AgentTurnStream,
  requestSignal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const lifecycleAbort = new AbortController();
  const onRequestAbort = () => lifecycleAbort.abort(requestSignal.reason);
  if (requestSignal.aborted) onRequestAbort();
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  const streamSignal = requestSignal.aborted
    ? requestSignal
    : AbortSignal.any([requestSignal, lifecycleAbort.signal]);
  const stream = createStream(streamSignal);
  let settled = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const next = await stream.next();
          if (cancelled) break;
          if (next.done) {
            enqueue(controller, encoder, {
              schemaVersion: 1,
              type: "result",
              result: projectTurnResult(next.value),
            });
            break;
          }
          enqueue(controller, encoder, {
            schemaVersion: 1,
            type: "event",
            event: projectTurnEvent(next.value),
          });
        }
      } catch (error) {
        if (!cancelled) {
          const mapped = mapEmbeddedAgentError(error);
          enqueue(controller, encoder, {
            schemaVersion: 1,
            type: "error",
            error: mapped.error,
          });
        }
      } finally {
        settled = true;
        requestSignal.removeEventListener("abort", onRequestAbort);
        if (!cancelled) controller.close();
      }
    },
    cancel(reason) {
      if (settled || cancelled) return;
      cancelled = true;
      lifecycleAbort.abort(reason);
      // A generator may be blocked inside next() and may not settle return()
      // promptly. Abort the engine signal, request cleanup, and let Web stream
      // cancellation resolve independently of generator cooperation.
      void stream.return(undefined as never).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function enqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: { encode(input?: string): Uint8Array },
  frame: EmbeddedAgentStreamFrame,
): void {
  controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
}

function projectTurnEvent(event: AgentTurnEvent): EmbeddedAgentTurnEvent {
  const base = {
    schemaVersion: 1 as const,
    sessionId: event.sessionId,
    turnId: event.turnId,
    sequence: event.sequence,
    emittedAt: event.emittedAt,
  };
  switch (event.type) {
    case "turn.started":
      return { ...base, type: event.type };
    case "model.resolved":
      return {
        ...base,
        type: event.type,
        model: event.provenance.resolvedModel.model,
      };
    case "text.delta":
      return { ...base, type: event.type, text: event.text };
    case "tool.requested":
      return {
        ...base,
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        effect: event.effect,
        ...(event.presentation ? { presentation: event.presentation } : {}),
        ...(event.displayInput !== undefined
          ? { displayInput: event.displayInput }
          : {}),
      };
    case "tool.started":
      return {
        ...base,
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        effect: event.effect,
        ...(event.presentation ? { presentation: event.presentation } : {}),
      };
    case "tool.completed":
      return {
        ...base,
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        effect: event.effect,
        ...(event.presentation ? { presentation: event.presentation } : {}),
        ...(event.displayContent !== undefined
          ? { displayContent: event.displayContent }
          : {}),
      };
    case "tool.failed":
      return {
        ...base,
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        effect: event.effect,
        ...(event.presentation ? { presentation: event.presentation } : {}),
        error: event.error,
      };
    case "interaction.required":
      return {
        ...base,
        type: event.type,
        interaction: projectInteraction(event.interaction),
        interactionRevision: event.interactionRevision,
        sessionRevision: event.sessionRevision,
      };
    case "interaction.resumed":
      return {
        ...base,
        type: event.type,
        interactionId: event.interactionId,
        decision: event.decision,
        sessionRevision: event.sessionRevision,
      };
    case "usage.updated":
    case "execution.updated":
      return { ...base, type: event.type };
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed":
    case "turn.suspended":
      return {
        ...base,
        type: event.type,
        result: projectTurnResult(event.result),
      };
  }
}

function projectTurnResult(
  result: import("./turnContracts.js").AgentTurnResult,
): EmbeddedAgentTurnResult {
  return {
    status: result.status,
    sessionId: result.sessionId,
    turnId: result.turnId,
    sessionRevision: result.sessionRevision,
    ...(result.status === "completed" ? { text: result.text } : {}),
    ...(result.status === "cancelled" && result.reason
      ? { reason: result.reason }
      : {}),
    ...(result.status === "failed" ? { error: result.error } : {}),
    ...(result.status === "suspended"
      ? { interaction: projectInteraction(result.interaction) }
      : {}),
  };
}

function projectInteraction(
  interaction: import("./turnContracts.js").AgentInteractionRequest,
): EmbeddedAgentInteraction {
  return structuredClone(interaction);
}

function inspectionResponse<TPrincipal extends AgentPrincipal>(
  inspection: AgentSessionInspection<TPrincipal>,
  projection?: unknown,
): EmbeddedAgentResponse {
  return {
    schemaVersion: 1,
    ok: true,
    type: "inspection",
    session: sessionSnapshot(inspection),
    ...(projection !== undefined ? { projection } : {}),
  };
}

function sessionSnapshot<TPrincipal extends AgentPrincipal>(
  inspection: AgentSessionInspection<TPrincipal>,
): EmbeddedAgentSessionSnapshot {
  const runState = inspection.summary.runState;
  return {
    sessionId: inspection.summary.sessionId,
    revision: inspection.summary.revision,
    phase: runState.phase,
    ...(runState.phase !== "idle" ? { turnId: runState.turnId } : {}),
    ...(inspection.pendingInteraction
      ? {
          pendingInteraction: {
            request: projectInteraction(inspection.pendingInteraction.request),
            interactionRevision:
              inspection.pendingInteraction.interactionRevision,
            sessionRevision: inspection.pendingInteraction.sessionRevision,
            nextSequence: inspection.pendingInteraction.nextSequence,
          },
        }
      : {}),
  };
}

export function parseEmbeddedAgentRequest(
  value: unknown,
  options: ParseEmbeddedAgentRequestOptions = {},
): EmbeddedAgentRequest {
  const maxSessionIdLength = positiveInteger(
    options.maxSessionIdLength ?? DEFAULT_MAX_SESSION_ID_LENGTH,
    "maxSessionIdLength",
  );
  const maxMessageLength = positiveInteger(
    options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
    "maxMessageLength",
  );
  if (
    !isRecord(value) ||
    value.schemaVersion !== EMBEDDED_AGENT_TRANSPORT_VERSION
  ) {
    throw invalidRequest("Unsupported embedded-agent request version");
  }
  const sessionId = boundedText(
    value.sessionId,
    "sessionId",
    maxSessionIdLength,
  );
  switch (value.type) {
    case "create":
      return {
        schemaVersion: 1,
        type: "create",
        sessionId,
        ...(value.model !== undefined
          ? { model: modelReference(value.model) }
          : {}),
        ...(value.reasoningEffort !== undefined
          ? { reasoningEffort: reasoningEffort(value.reasoningEffort) }
          : {}),
      };
    case "turn":
      return {
        schemaVersion: 1,
        type: "turn",
        sessionId,
        text: boundedText(value.text, "text", maxMessageLength),
        ...(value.model !== undefined
          ? { model: modelReference(value.model) }
          : {}),
        ...(value.reasoningEffort !== undefined
          ? { reasoningEffort: reasoningEffort(value.reasoningEffort) }
          : {}),
      };
    case "resume": {
      const decision = value.decision;
      if (decision !== "allow" && decision !== "deny") {
        throw invalidRequest("decision must be allow or deny");
      }
      return {
        schemaVersion: 1,
        type: "resume",
        sessionId,
        turnId: boundedText(value.turnId, "turnId", 256),
        interactionId: boundedText(value.interactionId, "interactionId", 256),
        interactionRevision: boundedText(
          value.interactionRevision,
          "interactionRevision",
          256,
        ),
        expectedSessionRevision: boundedText(
          value.expectedSessionRevision,
          "expectedSessionRevision",
          256,
        ),
        decision,
      };
    }
    case "inspect":
    case "hydrate":
    case "cancel":
    case "recover":
    case "delete":
      return {
        schemaVersion: 1,
        type: value.type,
        sessionId,
        ...(value.reason !== undefined
          ? { reason: boundedText(value.reason, "reason", 500) }
          : {}),
        ...(value.expectedRevision !== undefined
          ? {
              expectedRevision: boundedText(
                value.expectedRevision,
                "expectedRevision",
                256,
              ),
            }
          : {}),
      };
    default:
      throw invalidRequest("Unknown embedded-agent request type");
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EmbeddedAgentWebError(
      413,
      "request_too_large",
      "Request body is too large",
    );
  }
  if (!request.body) throw invalidRequest("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EmbeddedAgentWebError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidRequest("Request body must contain valid JSON");
  }
}

class EmbeddedAgentWebError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "EmbeddedAgentWebError";
  }
}

function invalidRequest(message: string): EmbeddedAgentWebError {
  return new EmbeddedAgentWebError(400, "invalid_request", message);
}

function mapEmbeddedAgentError(error: unknown): {
  readonly status: number;
  readonly error: EmbeddedAgentError;
} {
  if (error instanceof EmbeddedAgentWebError) {
    return {
      status: error.status,
      error: {
        code: error.code,
        category: embeddedAgentErrorCategory(error.code),
        message: error.message,
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof AgentEngineError) {
    const status =
      error.code === "session_not_found"
        ? 404
        : error.code === "session_already_exists" ||
            error.code === "session_busy" ||
            error.code === "session_revision_conflict" ||
            error.code === "turn_lease_held" ||
            error.code === "interaction_not_found"
          ? 409
          : error.code === "invalid_engine_configuration"
            ? 400
            : 500;
    return {
      status,
      error: {
        code: error.code,
        category: embeddedAgentErrorCategory(error.code),
        message: safeEngineMessage(error.code),
        retryable: error.retryable,
      },
    };
  }
  return {
    status: 500,
    error: {
      code: "internal_error",
      category: "internal",
      message: "The agent request could not be completed",
      retryable: false,
    },
  };
}

function safeEngineMessage(code: AgentEngineError["code"]): string {
  switch (code) {
    case "session_already_exists":
      return "The session already exists";
    case "session_not_found":
      return "The session was not found";
    case "session_revision_conflict":
      return "The session changed; refresh and retry";
    case "session_busy":
    case "turn_lease_held":
      return "The session is busy";
    case "turn_lease_lost":
      return "The session lease was lost";
    case "interaction_not_configured":
      return "Approvals are not configured";
    case "interaction_not_found":
      return "The pending approval was not found";
    case "invalid_engine_configuration":
      return "The agent is not configured correctly";
  }
}

function jsonError(
  status: number,
  code: string,
  message: string,
  retryable = false,
): Response {
  return jsonResponse(
    {
      schemaVersion: 1,
      ok: false,
      type: "error",
      error: {
        code,
        category: embeddedAgentErrorCategory(code),
        message,
        retryable,
      },
    },
    status,
  );
}

function jsonResponse(value: EmbeddedAgentResponse, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function modelReference(value: unknown): {
  providerId: string;
  modelId: string;
} {
  if (!isRecord(value)) throw invalidRequest("model must be an object");
  return {
    providerId: boundedText(value.providerId, "model.providerId", 256),
    modelId: boundedText(value.modelId, "model.modelId", 256),
  };
}

function reasoningEffort(value: unknown) {
  if (!isCoreReasoningEffort(value)) {
    throw invalidRequest("reasoningEffort is unsupported");
  }
  return value;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalidRequest(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

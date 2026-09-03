import {
  isEmbeddedAgentErrorCategory,
  isEmbeddedAgentToolPresentation,
  type EmbeddedAgentErrorCategory,
  type EmbeddedAgentToolEffect,
  type EmbeddedAgentToolPresentation,
} from "./embeddedAgentPresentation.js";
import type { CoreReasoningEffort } from "./modelCatalog.js";

export const EMBEDDED_AGENT_TRANSPORT_VERSION = 1 as const;

export interface EmbeddedAgentModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface EmbeddedAgentError {
  readonly code: string;
  readonly category: EmbeddedAgentErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export interface EmbeddedAgentInteraction {
  readonly interactionId: string;
  readonly kind: "tool_authorization";
  readonly summary: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly effect: EmbeddedAgentToolEffect;
  readonly presentation?: EmbeddedAgentToolPresentation;
  readonly displayInput?: unknown;
  readonly displayContent?: unknown;
}

export interface EmbeddedAgentTurnResult {
  readonly status: "completed" | "cancelled" | "failed" | "suspended";
  readonly sessionId: string;
  readonly turnId: string;
  readonly sessionRevision: string;
  readonly text?: string;
  readonly reason?: string;
  readonly error?: EmbeddedAgentError;
  readonly interaction?: EmbeddedAgentInteraction;
}

export interface EmbeddedAgentTurnEventBase {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly emittedAt: number;
}

export type EmbeddedAgentTurnEvent =
  | (EmbeddedAgentTurnEventBase & { readonly type: "turn.started" })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "model.resolved";
      readonly model: EmbeddedAgentModelReference;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "text.delta";
      readonly text: string;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "tool.requested" | "tool.started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: EmbeddedAgentToolEffect;
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly displayInput?: unknown;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: EmbeddedAgentToolEffect;
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly displayContent?: unknown;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "tool.failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly effect: EmbeddedAgentToolEffect;
      readonly presentation?: EmbeddedAgentToolPresentation;
      readonly error: EmbeddedAgentError;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "interaction.required";
      readonly interaction: EmbeddedAgentInteraction;
      readonly interactionRevision: string;
      readonly sessionRevision: string;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "interaction.resumed";
      readonly interactionId: string;
      readonly decision: "allow" | "deny";
      readonly sessionRevision: string;
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type: "usage.updated" | "execution.updated";
    })
  | (EmbeddedAgentTurnEventBase & {
      readonly type:
        | "turn.completed"
        | "turn.cancelled"
        | "turn.failed"
        | "turn.suspended";
      readonly result: EmbeddedAgentTurnResult;
    });

export type EmbeddedAgentRequest =
  | {
      readonly schemaVersion: 1;
      readonly type: "create";
      readonly sessionId: string;
      readonly model?: EmbeddedAgentModelReference;
      readonly reasoningEffort?: CoreReasoningEffort;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "turn";
      readonly sessionId: string;
      readonly text: string;
      readonly model?: EmbeddedAgentModelReference;
      readonly reasoningEffort?: CoreReasoningEffort;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "resume";
      readonly sessionId: string;
      readonly turnId: string;
      readonly interactionId: string;
      readonly interactionRevision: string;
      readonly expectedSessionRevision: string;
      readonly decision: "allow" | "deny";
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "inspect" | "hydrate" | "cancel" | "recover" | "delete";
      readonly sessionId: string;
      readonly reason?: string;
      readonly expectedRevision?: string;
    };

export type EmbeddedAgentStreamFrame =
  | {
      readonly schemaVersion: 1;
      readonly type: "event";
      readonly event: EmbeddedAgentTurnEvent;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "result";
      readonly result: EmbeddedAgentTurnResult;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "error";
      readonly error: EmbeddedAgentError;
    };

export type EmbeddedAgentResponse =
  | {
      readonly schemaVersion: 1;
      readonly ok: true;
      readonly type: "inspection";
      readonly session: EmbeddedAgentSessionSnapshot;
      readonly projection?: unknown;
    }
  | {
      readonly schemaVersion: 1;
      readonly ok: true;
      readonly type: "cancelled" | "deleted";
      readonly result?: unknown;
    }
  | {
      readonly schemaVersion: 1;
      readonly ok: false;
      readonly type: "error";
      readonly error: EmbeddedAgentError;
    };

export interface EmbeddedAgentSessionSnapshot {
  readonly sessionId: string;
  readonly revision: string;
  readonly phase: "idle" | "running" | "suspended" | "resuming" | "interrupted";
  readonly turnId?: string;
  readonly pendingInteraction?: {
    readonly request: EmbeddedAgentInteraction;
    readonly interactionRevision: string;
    readonly sessionRevision: string;
    readonly nextSequence: number;
  };
}

export interface EmbeddedAgentTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface EmbeddedAgentToolBlock {
  readonly type: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly effect: EmbeddedAgentToolEffect;
  readonly presentation?: EmbeddedAgentToolPresentation;
  readonly status: "requested" | "running" | "completed" | "failed" | "denied";
  readonly displayInput?: unknown;
  readonly displayContent?: unknown;
  readonly error?: EmbeddedAgentError;
}

export type EmbeddedAgentBlock =
  | EmbeddedAgentTextBlock
  | EmbeddedAgentToolBlock;

export interface EmbeddedAgentClientState {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly nextSequence: number;
  readonly status:
    | "idle"
    | "running"
    | "suspended"
    | "completed"
    | "cancelled"
    | "failed";
  readonly blocks: readonly EmbeddedAgentBlock[];
  readonly pendingInteraction?: {
    readonly request: EmbeddedAgentInteraction;
    readonly interactionRevision: string;
    readonly sessionRevision: string;
  };
  readonly error?: EmbeddedAgentError;
}

export class EmbeddedAgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedAgentProtocolError";
  }
}

export class EmbeddedAgentClientError extends Error {
  readonly code: string;
  readonly category: EmbeddedAgentErrorCategory;
  readonly retryable: boolean;

  constructor(readonly error: EmbeddedAgentError) {
    super(error.message);
    this.name = "EmbeddedAgentClientError";
    this.code = error.code;
    this.category = error.category;
    this.retryable = error.retryable;
  }
}

export type EmbeddedAgentHeaders =
  | Readonly<Record<string, string>>
  | readonly (readonly [string, string])[];

export interface EmbeddedAgentFetchInit {
  readonly method?: string;
  readonly headers?: EmbeddedAgentHeaders;
  readonly body?: string;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly signal?: AbortSignal;
}

export type EmbeddedAgentFetch = (
  input: string,
  init?: EmbeddedAgentFetchInit,
) => Promise<Response>;

export interface EmbeddedAgentClientControllerOptions {
  readonly endpoint: string;
  readonly fetch?: EmbeddedAgentFetch;
  readonly headers?:
    | EmbeddedAgentHeaders
    | (() => EmbeddedAgentHeaders | Promise<EmbeddedAgentHeaders>);
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly initialSession?: EmbeddedAgentSessionSnapshot;
}

export interface EmbeddedAgentClientRequestOptions {
  readonly signal?: AbortSignal;
}

export type EmbeddedAgentClientStateListener = (
  state: EmbeddedAgentClientState,
) => void;

type CreateRequest = Extract<EmbeddedAgentRequest, { type: "create" }>;
type TurnRequest = Extract<EmbeddedAgentRequest, { type: "turn" }>;
type ResumeRequest = Extract<EmbeddedAgentRequest, { type: "resume" }>;
type LifecycleRequest = Exclude<
  EmbeddedAgentRequest,
  CreateRequest | TurnRequest | ResumeRequest
>;
type LifecycleRequestInput = Omit<LifecycleRequest, "schemaVersion" | "type">;

/**
 * Framework-neutral browser controller for the embedded-agent Web endpoint.
 * Authentication headers and rendering remain host-owned; this class owns the
 * versioned request/stream protocol, ordered reduction, and one active turn.
 */
export class EmbeddedAgentClientController {
  private readonly fetchImpl: EmbeddedAgentFetch;
  private readonly listeners = new Set<EmbeddedAgentClientStateListener>();
  private state: EmbeddedAgentClientState;
  private active:
    | { sessionId: string; controller: AbortController }
    | undefined;

  constructor(private readonly options: EmbeddedAgentClientControllerOptions) {
    this.fetchImpl =
      options.fetch ??
      ((input, init) =>
        globalThis.fetch(input, init as RequestInit | undefined));
    this.state = createEmbeddedAgentClientState(options.initialSession);
  }

  getState(): EmbeddedAgentClientState {
    return this.state;
  }

  subscribe(listener: EmbeddedAgentClientStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abortActive(reason?: unknown): boolean {
    if (!this.active) return false;
    this.active.controller.abort(reason);
    return true;
  }

  async create(
    request: Omit<CreateRequest, "schemaVersion" | "type">,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentSessionSnapshot> {
    return await this.inspectingRequest(
      { schemaVersion: 1, type: "create", ...request },
      options,
    );
  }

  async inspect(
    request: LifecycleRequestInput,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentSessionSnapshot> {
    return await this.inspectingRequest(
      { schemaVersion: 1, type: "inspect", ...request },
      options,
    );
  }

  async hydrate(
    request: LifecycleRequestInput,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<Extract<EmbeddedAgentResponse, { type: "inspection" }>> {
    const response = await this.lifecycleRequest(
      { schemaVersion: 1, type: "hydrate", ...request },
      options,
    );
    if (response.type !== "inspection") {
      throw new EmbeddedAgentProtocolError("Expected an inspection response");
    }
    this.publish(createEmbeddedAgentClientState(response.session));
    return response;
  }

  async recover(
    request: LifecycleRequestInput,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentSessionSnapshot> {
    return await this.inspectingRequest(
      { schemaVersion: 1, type: "recover", ...request },
      options,
    );
  }

  async delete(
    request: LifecycleRequestInput,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<void> {
    if (this.active?.sessionId === request.sessionId)
      this.abortActive("deleted");
    const response = await this.lifecycleRequest(
      { schemaVersion: 1, type: "delete", ...request },
      options,
    );
    if (response.type !== "deleted") {
      throw new EmbeddedAgentProtocolError("Expected a deleted response");
    }
    if (this.state.sessionId === request.sessionId) {
      this.publish(createEmbeddedAgentClientState());
    }
  }

  async cancel(
    request: LifecycleRequestInput,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<unknown> {
    if (this.active?.sessionId === request.sessionId)
      this.abortActive("cancelled");
    const response = await this.lifecycleRequest(
      { schemaVersion: 1, type: "cancel", ...request },
      options,
    );
    if (response.type !== "cancelled") {
      throw new EmbeddedAgentProtocolError("Expected a cancelled response");
    }
    if (this.state.sessionId === request.sessionId) {
      this.publish({
        ...this.state,
        status: "cancelled",
        pendingInteraction: undefined,
      });
    }
    return response.result;
  }

  async turn(
    request: Omit<TurnRequest, "schemaVersion" | "type">,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentTurnResult> {
    this.assertNoActiveTurn();
    this.publish({
      ...createEmbeddedAgentClientState(),
      sessionId: request.sessionId,
    });
    return await this.streamRequest(
      { schemaVersion: 1, type: "turn", ...request },
      options,
    );
  }

  async resume(
    request: Omit<ResumeRequest, "schemaVersion" | "type">,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentTurnResult> {
    this.assertNoActiveTurn();
    const pending = this.state.pendingInteraction;
    if (
      this.state.sessionId !== request.sessionId ||
      this.state.turnId !== request.turnId ||
      pending?.request.interactionId !== request.interactionId ||
      pending.interactionRevision !== request.interactionRevision ||
      pending.sessionRevision !== request.expectedSessionRevision
    ) {
      throw new EmbeddedAgentProtocolError(
        "Hydrate the matching pending interaction before resume",
      );
    }
    return await this.streamRequest(
      { schemaVersion: 1, type: "resume", ...request },
      options,
    );
  }

  private async inspectingRequest(
    request: CreateRequest | LifecycleRequest,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentSessionSnapshot> {
    const response = await this.lifecycleRequest(request, options);
    if (response.type !== "inspection") {
      throw new EmbeddedAgentProtocolError("Expected an inspection response");
    }
    this.publish(createEmbeddedAgentClientState(response.session));
    return response.session;
  }

  private async lifecycleRequest(
    request: Exclude<EmbeddedAgentRequest, TurnRequest | ResumeRequest>,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentResponse> {
    const response = await this.post(request, options?.signal);
    const value = await readEmbeddedAgentJson(response);
    const parsed = parseEmbeddedAgentResponse(value);
    if (!parsed.ok) throw new EmbeddedAgentClientError(parsed.error);
    if (!response.ok) {
      throw new EmbeddedAgentProtocolError(
        `Embedded-agent request failed with HTTP ${response.status}`,
      );
    }
    return parsed;
  }

  private async streamRequest(
    request: TurnRequest | ResumeRequest,
    options?: EmbeddedAgentClientRequestOptions,
  ): Promise<EmbeddedAgentTurnResult> {
    if (this.active) {
      throw new EmbeddedAgentProtocolError(
        "An embedded-agent turn is already active",
      );
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) forwardAbort();
    else
      options?.signal?.addEventListener("abort", forwardAbort, { once: true });
    this.active = { sessionId: request.sessionId, controller };
    let observedTurnId = request.type === "resume" ? request.turnId : undefined;
    try {
      const response = await this.post(request, controller.signal);
      if (!response.ok) {
        const parsed = parseEmbeddedAgentResponse(
          await readEmbeddedAgentJson(response),
        );
        if (!parsed.ok) throw new EmbeddedAgentClientError(parsed.error);
        throw new EmbeddedAgentProtocolError(
          `Embedded-agent stream failed with HTTP ${response.status}`,
        );
      }
      if (!response.body) {
        throw new EmbeddedAgentProtocolError(
          "Embedded-agent stream response has no body",
        );
      }
      let result: EmbeddedAgentTurnResult | undefined;
      for await (const frame of decodeEmbeddedAgentNdjson(response.body)) {
        if (frame.type === "event") {
          if (
            frame.event.sessionId !== request.sessionId ||
            (observedTurnId !== undefined &&
              frame.event.turnId !== observedTurnId)
          ) {
            throw new EmbeddedAgentProtocolError(
              "Embedded-agent event belongs to a different turn",
            );
          }
          observedTurnId ??= frame.event.turnId;
          this.publish(reduceEmbeddedAgentTurnEvent(this.state, frame.event));
        } else if (frame.type === "result") {
          if (
            frame.result.sessionId !== request.sessionId ||
            observedTurnId === undefined ||
            frame.result.turnId !== observedTurnId
          ) {
            throw new EmbeddedAgentProtocolError(
              "Embedded-agent result belongs to a different turn",
            );
          }
          result = frame.result;
        } else {
          this.publish({
            ...this.state,
            status: "failed",
            error: frame.error,
            pendingInteraction: undefined,
          });
          throw new EmbeddedAgentClientError(frame.error);
        }
      }
      if (!result) {
        throw new EmbeddedAgentProtocolError(
          "Embedded-agent stream ended without a result",
        );
      }
      return result;
    } catch (error) {
      const externallyAborted = controller.signal.aborted;
      if (!externallyAborted) controller.abort(error);
      if (
        externallyAborted &&
        this.active?.controller === controller &&
        this.state.sessionId === request.sessionId &&
        (observedTurnId === undefined || this.state.turnId === observedTurnId)
      ) {
        this.publish({
          ...this.state,
          status: "cancelled",
          pendingInteraction: undefined,
        });
      }
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", forwardAbort);
      if (this.active?.controller === controller) this.active = undefined;
    }
  }

  private assertNoActiveTurn(): void {
    if (this.active) {
      throw new EmbeddedAgentProtocolError(
        "An embedded-agent turn is already active",
      );
    }
  }

  private async post(
    request: EmbeddedAgentRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const configuredHeaders =
      typeof this.options.headers === "function"
        ? await this.options.headers()
        : this.options.headers;
    const headers = Object.fromEntries(
      new Headers(configuredHeaders as HeadersInit | undefined).entries(),
    );
    headers["content-type"] = "application/json";
    return await this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(this.options.credentials
        ? { credentials: this.options.credentials }
        : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private publish(state: EmbeddedAgentClientState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

export function createEmbeddedAgentClientController(
  options: EmbeddedAgentClientControllerOptions,
): EmbeddedAgentClientController {
  return new EmbeddedAgentClientController(options);
}

export function createEmbeddedAgentClientState(
  session?: EmbeddedAgentSessionSnapshot,
): EmbeddedAgentClientState {
  const pending = session?.pendingInteraction;
  return {
    ...(session ? { sessionId: session.sessionId } : {}),
    ...(session?.turnId ? { turnId: session.turnId } : {}),
    nextSequence: pending?.nextSequence ?? 0,
    status: session?.phase === "suspended" ? "suspended" : "idle",
    blocks: pending
      ? [
          {
            type: "tool",
            toolCallId: pending.request.toolCallId,
            toolName: pending.request.toolName,
            effect: pending.request.effect,
            ...(pending.request.presentation
              ? { presentation: pending.request.presentation }
              : {}),
            status: "requested",
            ...(pending.request.displayInput !== undefined
              ? { displayInput: pending.request.displayInput }
              : {}),
          },
        ]
      : [],
    ...(pending ? { pendingInteraction: pending } : {}),
  };
}

export async function* decodeEmbeddedAgentNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EmbeddedAgentStreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield parseEmbeddedAgentStreamFrame(line);
      }
    }
    buffered += decoder.decode();
    const tail = buffered.trim();
    if (tail) yield parseEmbeddedAgentStreamFrame(tail);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort transport cleanup; preserve the stream outcome.
    }
    reader.releaseLock();
  }
}

export function parseEmbeddedAgentResponse(
  value: unknown,
): EmbeddedAgentResponse {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.ok !== "boolean"
  ) {
    throw new EmbeddedAgentProtocolError("Malformed embedded-agent response");
  }
  if (
    value.ok === false &&
    value.type === "error" &&
    isEmbeddedAgentError(value.error)
  ) {
    return value as unknown as EmbeddedAgentResponse;
  }
  if (value.ok !== true) {
    throw new EmbeddedAgentProtocolError("Malformed embedded-agent response");
  }
  if (
    value.type === "inspection" &&
    isEmbeddedAgentSessionSnapshot(value.session)
  ) {
    return value as unknown as EmbeddedAgentResponse;
  }
  if (value.type === "cancelled" || value.type === "deleted") {
    return value as unknown as EmbeddedAgentResponse;
  }
  throw new EmbeddedAgentProtocolError("Malformed embedded-agent response");
}

export function parseEmbeddedAgentStreamFrame(
  line: string,
): EmbeddedAgentStreamFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new EmbeddedAgentProtocolError(
      "Embedded-agent stream contained invalid JSON",
    );
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new EmbeddedAgentProtocolError(
      "Unsupported embedded-agent stream frame",
    );
  }
  if (value.type === "event" && isEmbeddedAgentTurnEvent(value.event)) {
    return value as EmbeddedAgentStreamFrame;
  }
  if (value.type === "result" && isEmbeddedAgentTurnResult(value.result)) {
    return value as EmbeddedAgentStreamFrame;
  }
  if (value.type === "error" && isEmbeddedAgentError(value.error)) {
    return value as EmbeddedAgentStreamFrame;
  }
  throw new EmbeddedAgentProtocolError("Malformed embedded-agent stream frame");
}

export function reduceEmbeddedAgentTurnEvent(
  state: EmbeddedAgentClientState,
  event: EmbeddedAgentTurnEvent,
): EmbeddedAgentClientState {
  if (event.schemaVersion !== EMBEDDED_AGENT_TRANSPORT_VERSION) {
    throw new EmbeddedAgentProtocolError(
      "Unsupported embedded-agent event version",
    );
  }
  if (state.sessionId !== undefined && state.sessionId !== event.sessionId) {
    throw new EmbeddedAgentProtocolError(
      "Event belongs to a different session",
    );
  }
  if (state.turnId !== undefined && state.turnId !== event.turnId) {
    throw new EmbeddedAgentProtocolError("Event belongs to a different turn");
  }
  if (event.sequence !== state.nextSequence) {
    throw new EmbeddedAgentProtocolError(
      `Expected event sequence ${state.nextSequence}, received ${event.sequence}`,
    );
  }
  const base = {
    ...state,
    sessionId: event.sessionId,
    turnId: event.turnId,
    nextSequence: event.sequence + 1,
  };
  switch (event.type) {
    case "turn.started":
      return { ...base, status: "running", blocks: [], error: undefined };
    case "model.resolved":
    case "usage.updated":
    case "execution.updated":
      return base;
    case "text.delta":
      return { ...base, blocks: appendText(base.blocks, event.text) };
    case "tool.requested":
      return {
        ...base,
        blocks: [
          ...base.blocks,
          {
            type: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            effect: event.effect,
            ...(event.presentation ? { presentation: event.presentation } : {}),
            status: "requested",
            ...(event.displayInput !== undefined
              ? { displayInput: event.displayInput }
              : {}),
          },
        ],
      };
    case "tool.started":
      return updateTool(base, event.toolCallId, { status: "running" });
    case "tool.completed":
      return updateTool(base, event.toolCallId, {
        status: "completed",
        ...(event.displayContent !== undefined
          ? { displayContent: event.displayContent }
          : {}),
      });
    case "tool.failed":
      return updateTool(base, event.toolCallId, {
        status:
          event.error.code === "tool_authorization_denied"
            ? "denied"
            : "failed",
        error: event.error,
      });
    case "interaction.required":
      return {
        ...base,
        status: "suspended",
        pendingInteraction: {
          request: event.interaction,
          interactionRevision: event.interactionRevision,
          sessionRevision: event.sessionRevision,
        },
      };
    case "interaction.resumed":
      return { ...base, status: "running", pendingInteraction: undefined };
    case "turn.completed":
      return { ...base, status: "completed", pendingInteraction: undefined };
    case "turn.cancelled":
      return { ...base, status: "cancelled", pendingInteraction: undefined };
    case "turn.failed":
      return {
        ...base,
        status: "failed",
        error: event.result.error,
        pendingInteraction: undefined,
      };
    case "turn.suspended":
      return { ...base, status: "suspended" };
    default:
      throw new EmbeddedAgentProtocolError("Unknown embedded-agent event type");
  }
}

function appendText(
  blocks: readonly EmbeddedAgentBlock[],
  text: string,
): readonly EmbeddedAgentBlock[] {
  const last = blocks.at(-1);
  if (last?.type === "text") {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...blocks, { type: "text", text }];
}

function isEmbeddedAgentTurnEvent(
  value: unknown,
): value is EmbeddedAgentTurnEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.turnId !== "string" ||
    !value.turnId ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    !Number.isSafeInteger(value.emittedAt) ||
    (value.emittedAt as number) < 0 ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "turn.started":
    case "usage.updated":
    case "execution.updated":
      return true;
    case "model.resolved":
      return isModelReference(value.model);
    case "text.delta":
      return typeof value.text === "string";
    case "tool.requested":
    case "tool.started":
    case "tool.completed":
      return validToolIdentity(value);
    case "tool.failed":
      return validToolIdentity(value) && isEmbeddedAgentError(value.error);
    case "interaction.required":
      return (
        isEmbeddedAgentInteraction(value.interaction) &&
        isNonEmptyString(value.interactionRevision) &&
        isNonEmptyString(value.sessionRevision)
      );
    case "interaction.resumed":
      return (
        isNonEmptyString(value.interactionId) &&
        (value.decision === "allow" || value.decision === "deny") &&
        isNonEmptyString(value.sessionRevision)
      );
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed":
    case "turn.suspended":
      return isEmbeddedAgentTurnResult(value.result);
    default:
      return false;
  }
}

function isEmbeddedAgentTurnResult(
  value: unknown,
): value is EmbeddedAgentTurnResult {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.sessionRevision)
  ) {
    return false;
  }
  switch (value.status) {
    case "completed":
      return typeof value.text === "string";
    case "cancelled":
      return value.reason === undefined || typeof value.reason === "string";
    case "failed":
      return isEmbeddedAgentError(value.error);
    case "suspended":
      return isEmbeddedAgentInteraction(value.interaction);
    default:
      return false;
  }
}

async function readEmbeddedAgentJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new EmbeddedAgentProtocolError(
      "Embedded-agent endpoint returned invalid JSON",
    );
  }
}

function isEmbeddedAgentSessionSnapshot(
  value: unknown,
): value is EmbeddedAgentSessionSnapshot {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.revision) ||
    !["idle", "running", "suspended", "resuming", "interrupted"].includes(
      String(value.phase),
    )
  ) {
    return false;
  }
  if (value.turnId !== undefined && !isNonEmptyString(value.turnId))
    return false;
  if (value.pendingInteraction === undefined) return true;
  const pending = value.pendingInteraction;
  return (
    isRecord(pending) &&
    isEmbeddedAgentInteraction(pending.request) &&
    isNonEmptyString(pending.interactionRevision) &&
    isNonEmptyString(pending.sessionRevision) &&
    Number.isSafeInteger(pending.nextSequence) &&
    Number(pending.nextSequence) >= 0
  );
}

function isEmbeddedAgentError(value: unknown): value is EmbeddedAgentError {
  return (
    isRecord(value) &&
    isNonEmptyString(value.code) &&
    isEmbeddedAgentErrorCategory(value.category) &&
    isNonEmptyString(value.message) &&
    typeof value.retryable === "boolean"
  );
}

function isEmbeddedAgentInteraction(
  value: unknown,
): value is EmbeddedAgentInteraction {
  return (
    isRecord(value) &&
    value.kind === "tool_authorization" &&
    isNonEmptyString(value.interactionId) &&
    isNonEmptyString(value.summary) &&
    isNonEmptyString(value.toolCallId) &&
    isNonEmptyString(value.toolName) &&
    (value.presentation === undefined ||
      isEmbeddedAgentToolPresentation(value.presentation)) &&
    (value.effect === "read" ||
      value.effect === "write" ||
      value.effect === "external" ||
      value.effect === "unknown")
  );
}

function isModelReference(
  value: unknown,
): value is EmbeddedAgentModelReference {
  return (
    isRecord(value) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId)
  );
}

function validToolIdentity(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.toolCallId) &&
    isNonEmptyString(value.toolName) &&
    (value.effect === "read" ||
      value.effect === "write" ||
      value.effect === "external" ||
      value.effect === "unknown") &&
    (value.presentation === undefined ||
      isEmbeddedAgentToolPresentation(value.presentation))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateTool(
  state: EmbeddedAgentClientState,
  toolCallId: string,
  update: Partial<EmbeddedAgentToolBlock>,
): EmbeddedAgentClientState {
  let found = false;
  const blocks = state.blocks.map((block) => {
    if (block.type !== "tool" || block.toolCallId !== toolCallId) return block;
    found = true;
    return { ...block, ...update };
  });
  if (!found) {
    throw new EmbeddedAgentProtocolError(
      `Tool event references unknown call ${toolCallId}`,
    );
  }
  return { ...state, blocks };
}

import type { ResponsesDispatchEvidence } from "./responsesTransport.js";

export type ResponsesRecoveryPhase = "websocket" | "http";
export type ResponsesRecoveryDecision =
  | { action: "retry"; phase: ResponsesRecoveryPhase }
  | { action: "fallback"; phase: "http" }
  | { action: "exhausted"; phase: ResponsesRecoveryPhase };

/** Runtime-only fallback preference carrier. It owns no transport resources. */
export class ResponsesConversationState {
  #identity?: string;
  #enabled?: boolean;
  #httpOnly = false;
  #disposed = false;

  get httpOnly(): boolean {
    return this.#httpOnly;
  }

  observe(identity: string, enabled: boolean): void {
    if (this.#disposed) return;
    if (this.#identity !== identity || this.#enabled !== enabled) {
      this.#identity = identity;
      this.#enabled = enabled;
      this.#httpOnly = false;
    }
  }

  useHttp(): void {
    if (!this.#disposed) this.#httpOnly = true;
  }

  reset(): void {
    this.#identity = undefined;
    this.#enabled = undefined;
    this.#httpOnly = false;
  }

  dispose(): void {
    this.reset();
    this.#disposed = true;
  }
}

export interface ResponsesRecoveryDecisionInput {
  phase: ResponsesRecoveryPhase;
  retriesInPhase: number;
  retriesUsed: number;
  maxRetries: number;
  maxRetriesPerPhase?: number;
  dispatches: number;
  maxDispatches?: number;
  canRedispatch: boolean;
  retryable: boolean;
  conversationState?: ResponsesConversationState;
}

/** Shared retry/transition policy for the internal wrapper and external engines. */
export function decideResponsesRecovery(
  input: ResponsesRecoveryDecisionInput,
): ResponsesRecoveryDecision {
  const { phase, conversationState } = input;
  const perPhase = input.maxRetriesPerPhase ?? 5;
  const dispatchLimit = input.maxDispatches ?? 12;
  const exhausted = (): ResponsesRecoveryDecision => ({
    action: "exhausted",
    phase,
  });

  if (
    !input.canRedispatch ||
    !input.retryable ||
    input.retriesUsed >= input.maxRetries ||
    input.dispatches >= dispatchLimit
  ) {
    return exhausted();
  }
  if (input.retriesInPhase < perPhase) return { action: "retry", phase };
  if (phase === "websocket" && !conversationState?.httpOnly) {
    conversationState?.useHttp();
    return { action: "fallback", phase: "http" };
  }
  return exhausted();
}

export function isResponsesInterruption(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    retryable?: unknown;
    nonReplayable?: unknown;
    name?: unknown;
    retryLayer?: unknown;
  };
  if (
    candidate.name === "ProviderStreamTimeoutError" ||
    candidate.name === "ResponsesTransportInterruptedError" ||
    candidate.retryLayer === "stream"
  ) {
    return true;
  }
  if (candidate.retryable === true) return true;
  if (candidate.retryable === false || candidate.nonReplayable === true) {
    return false;
  }
  if (
    candidate.status === 408 ||
    candidate.status === 409 ||
    candidate.status === 429 ||
    (typeof candidate.status === "number" && candidate.status >= 500)
  ) {
    return true;
  }
  if (typeof candidate.code === "string") {
    return /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|NETWORK_ERROR)$/.test(
      candidate.code,
    );
  }
  return (
    candidate.name === "TypeError" &&
    typeof (error as { message?: unknown }).message === "string" &&
    /fetch failed|network error|socket hang up/i.test(
      (error as { message: string }).message,
    )
  );
}

export function isResponsesFatalRecoveryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    nonReplayable?: unknown;
    status?: unknown;
    retryLayer?: unknown;
  };
  return (
    candidate.nonReplayable === true ||
    candidate.name === "CodexStreamError" ||
    candidate.name === "CoreModelOutputLimitError" ||
    candidate.code === "responses_concurrent_owner" ||
    candidate.code === "responses_resource_limit" ||
    candidate.status === 400 ||
    candidate.status === 401 ||
    candidate.status === 403 ||
    candidate.status === 404 ||
    candidate.status === 422
  );
}

export function responsesRetryReason(error: unknown): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return `http_${status}`;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.slice(0, 80);
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name.slice(0, 80);
  }
  return "stream_interrupted";
}

export function responsesPhaseFromEvidence(
  evidence: ResponsesDispatchEvidence,
): ResponsesRecoveryPhase {
  return evidence.transport;
}

import type { ModelProvider } from "../agent/providers/types.js";

/**
 * Guardian review is part of an unattended approval path, so prefer a generous
 * end-to-end deadline over prematurely handing the action to a human. The
 * deadline covers context resolution and every retry rather than multiplying
 * per attempt.
 */
export const DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_GUARDIAN_REVIEW_ATTEMPTS = 5;
// Leave enough room inside the five-minute end-to-end deadline for the bounded
// backoff between all five attempts.
export const DEFAULT_GUARDIAN_REVIEW_ATTEMPT_TIMEOUT_MS = 59_000;
export const DEFAULT_GUARDIAN_RATIONALE_MAX_LENGTH = 500;

export const GUARDIAN_INVALID_RESPONSE_RETRY_INSTRUCTION =
  "\n\nYour previous response was invalid. Return exactly one JSON object matching the required schema, with no markdown or prose.";

export type GuardianReviewRisk = "low" | "medium" | "high" | "critical";
export type GuardianReviewUserAuthorization =
  | "unknown"
  | "low"
  | "medium"
  | "high";
export type GuardianReviewStatus =
  | "reviewed"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "invalid";

export interface GuardianReviewDecision {
  outcome: "allow" | "deny";
  risk: GuardianReviewRisk;
  userAuthorization: GuardianReviewUserAuthorization;
  rationale: string;
  status: GuardianReviewStatus;
}

export interface GuardianReviewResult extends GuardianReviewDecision {
  model: string;
}

export interface GuardianReviewContext {
  provider: ModelProvider;
  sessionModel: string;
}

export type GuardianReviewContextResolver = (
  sessionId: string,
  signal: AbortSignal,
) =>
  | GuardianReviewContext
  | undefined
  | Promise<GuardianReviewContext | undefined>;

export interface GuardianReviewResponseMessages {
  allowed: string;
  denied: string;
  invalid: string;
}

export interface ParseGuardianReviewResponseOptions {
  messages: GuardianReviewResponseMessages;
  maxRationaleLength?: number;
}

export interface RunGuardianReviewOptions {
  sessionId: string;
  signal?: AbortSignal;
  resolveContext: GuardianReviewContextResolver;
  systemPrompt: string;
  userContent: string;
  messages: GuardianReviewResponseMessages & {
    unavailable: string;
    timedOut: string;
    cancelled: string;
  };
  timeoutMs?: number;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  maxTokens?: number;
  maxRationaleLength?: number;
}

export interface GuardianReviewAttemptsOptions<T> {
  signal: AbortSignal;
  maxAttempts: number;
  attemptTimeoutMs: number;
  run(attempt: number, signal: AbortSignal): Promise<T>;
  shouldRetry(result: T): boolean;
  retryDelayMs?(completedAttempts: number): number;
}

export interface GuardianDenialCircuitDecision {
  explicitDenial: boolean;
  interrupted: boolean;
  consecutiveDenials: number;
  denialsInRecentWindow: number;
}

export interface GuardianDenialCircuit {
  readonly interrupted: boolean;
  record(
    result: Pick<GuardianReviewDecision, "outcome" | "status">,
  ): GuardianDenialCircuitDecision;
}

export interface GuardianDenialCircuitOptions {
  consecutiveDenialLimit?: number;
  recentDenialLimit?: number;
  recentWindowSize?: number;
}

export function parseGuardianReviewResponse(
  text: string,
  options: ParseGuardianReviewResponseOptions,
): GuardianReviewDecision {
  const invalid = (): GuardianReviewDecision => ({
    outcome: "deny",
    risk: "high",
    userAuthorization: "unknown",
    rationale: options.messages.invalid,
    status: "invalid",
  });

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return invalid();

    const allowedKeys = new Set([
      "outcome",
      "risk_level",
      "user_authorization",
      "rationale",
    ]);
    if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
      return invalid();
    }
    if (parsed.outcome !== "allow" && parsed.outcome !== "deny") {
      return invalid();
    }
    if (
      parsed.risk_level !== undefined &&
      !isGuardianReviewRisk(parsed.risk_level)
    ) {
      return invalid();
    }
    if (
      parsed.user_authorization !== undefined &&
      !isGuardianReviewUserAuthorization(parsed.user_authorization)
    ) {
      return invalid();
    }
    if (
      parsed.rationale !== undefined &&
      typeof parsed.rationale !== "string"
    ) {
      return invalid();
    }

    const rationale =
      typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    if (
      rationale.length >
      (options.maxRationaleLength ?? DEFAULT_GUARDIAN_RATIONALE_MAX_LENGTH)
    ) {
      return invalid();
    }

    return {
      outcome: parsed.outcome,
      risk: parsed.risk_level ?? "low",
      userAuthorization: parsed.user_authorization ?? "unknown",
      rationale:
        rationale ||
        (parsed.outcome === "allow"
          ? options.messages.allowed
          : options.messages.denied),
      status: "reviewed",
    };
  } catch {
    return invalid();
  }
}

export async function runGuardianReview(
  options: RunGuardianReviewOptions,
): Promise<GuardianReviewResult> {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(),
    options.timeoutMs ?? DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let model = "";

  try {
    const context = await awaitWithAbort(
      Promise.resolve(options.resolveContext(options.sessionId, signal)),
      signal,
    );
    model = context?.sessionModel ?? "";
    if (!context || !isGuardianReviewModelRoutable(context.provider, model)) {
      return failedReviewResult(
        model,
        "unavailable",
        options.messages.unavailable,
      );
    }

    const reasoningEffort = context.provider
      .getCapabilities(model)
      .reasoningEfforts?.includes("low")
      ? "low"
      : "none";
    let retryingInvalidResponse = false;
    const decision = await runGuardianReviewAttempts({
      signal,
      maxAttempts: options.maxAttempts ?? DEFAULT_GUARDIAN_REVIEW_ATTEMPTS,
      attemptTimeoutMs:
        options.attemptTimeoutMs ?? DEFAULT_GUARDIAN_REVIEW_ATTEMPT_TIMEOUT_MS,
      async run(_attempt, attemptSignal) {
        const result = await context.provider.complete({
          model,
          systemPrompt: options.systemPrompt,
          messages: [
            {
              role: "user",
              content:
                options.userContent +
                (retryingInvalidResponse
                  ? GUARDIAN_INVALID_RESPONSE_RETRY_INSTRUCTION
                  : ""),
            },
          ],
          maxTokens: options.maxTokens ?? 384,
          temperature: 0,
          reasoningEffort,
          signal: attemptSignal,
        });
        const parsed = parseGuardianReviewResponse(result.text, {
          messages: options.messages,
          maxRationaleLength: options.maxRationaleLength,
        });
        retryingInvalidResponse = parsed.status === "invalid";
        return parsed;
      },
      shouldRetry: (result) => result.status === "invalid",
    });
    return { ...decision, model };
  } catch (error) {
    if (options.signal?.aborted) {
      return failedReviewResult(model, "cancelled", options.messages.cancelled);
    }
    if (
      timeoutController.signal.aborted ||
      isGuardianAttemptTimeoutError(error)
    ) {
      return failedReviewResult(model, "timed_out", options.messages.timedOut);
    }
    return failedReviewResult(
      model,
      "unavailable",
      options.messages.unavailable,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function runGuardianReviewAttempts<T>(
  options: GuardianReviewAttemptsOptions<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const attemptController = new AbortController();
    const timer = setTimeout(
      () => attemptController.abort(),
      options.attemptTimeoutMs,
    );
    const attemptSignal = AbortSignal.any([
      options.signal,
      attemptController.signal,
    ]);
    try {
      const result = await awaitWithAbort(
        options.run(attempt, attemptSignal),
        attemptSignal,
      );
      if (!options.shouldRetry(result) || attempt === options.maxAttempts) {
        return result;
      }
    } catch (error) {
      lastError =
        attemptController.signal.aborted && !options.signal.aborted
          ? guardianAttemptTimeoutError()
          : error;
      if (options.signal.aborted || attempt === options.maxAttempts)
        throw lastError;
    } finally {
      clearTimeout(timer);
    }
    await delayWithAbort(
      (options.retryDelayMs ?? guardianRetryDelayMs)(attempt),
      options.signal,
    );
  }
  throw lastError ?? new Error("Guardian review attempts exhausted");
}

function guardianAttemptTimeoutError(): DOMException {
  return new DOMException("Guardian review attempt timed out", "TimeoutError");
}

export function isGuardianAttemptTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function guardianRetryDelayMs(completedAttempts: number): number {
  return Math.min(100 * 2 ** (completedAttempts - 1), 1_000);
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isGuardianReviewModelRoutable(
  provider: ModelProvider,
  model: string,
): boolean {
  const routable =
    provider.listRoutableModelIds?.() ??
    provider.listModels().map(({ id }) => id);
  return routable.includes(model);
}

export function createGuardianDenialCircuit(
  options: GuardianDenialCircuitOptions = {},
): GuardianDenialCircuit {
  const consecutiveDenialLimit = options.consecutiveDenialLimit ?? 3;
  const recentDenialLimit = options.recentDenialLimit ?? 10;
  const recentWindowSize = options.recentWindowSize ?? 50;
  const recentDenials: boolean[] = [];
  let consecutiveDenials = 0;
  let interrupted = false;

  return {
    get interrupted() {
      return interrupted;
    },
    record(result) {
      const explicitDenial =
        result.status === "reviewed" && result.outcome === "deny";
      consecutiveDenials = explicitDenial ? consecutiveDenials + 1 : 0;
      recentDenials.push(explicitDenial);
      if (recentDenials.length > recentWindowSize) recentDenials.shift();
      const denialsInRecentWindow = recentDenials.filter(Boolean).length;
      interrupted ||=
        consecutiveDenials >= consecutiveDenialLimit ||
        denialsInRecentWindow >= recentDenialLimit;
      return {
        explicitDenial,
        interrupted,
        consecutiveDenials,
        denialsInRecentWindow,
      };
    },
  };
}

function failedReviewResult(
  model: string,
  status: Exclude<GuardianReviewStatus, "reviewed" | "invalid">,
  rationale: string,
): GuardianReviewResult {
  return {
    outcome: "deny",
    risk: "high",
    userAuthorization: "unknown",
    rationale,
    model,
    status,
  };
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isGuardianReviewRisk(value: unknown): value is GuardianReviewRisk {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  );
}

function isGuardianReviewUserAuthorization(
  value: unknown,
): value is GuardianReviewUserAuthorization {
  return (
    value === "unknown" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

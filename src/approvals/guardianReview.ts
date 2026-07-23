import type { ModelProvider } from "../agent/providers/types.js";

export const DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;
export const DEFAULT_GUARDIAN_REVIEW_ATTEMPTS = 3;
export const DEFAULT_GUARDIAN_RATIONALE_MAX_LENGTH = 500;

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
  maxTokens?: number;
  maxRationaleLength?: number;
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
    const maxAttempts = options.maxAttempts ?? DEFAULT_GUARDIAN_REVIEW_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await awaitWithAbort(
          context.provider.complete({
            model,
            systemPrompt: options.systemPrompt,
            messages: [{ role: "user", content: options.userContent }],
            maxTokens: options.maxTokens ?? 384,
            temperature: 0,
            reasoningEffort,
            signal,
          }),
          signal,
        );
        if (signal.aborted) throw abortError();
        return {
          ...parseGuardianReviewResponse(result.text, {
            messages: options.messages,
            maxRationaleLength: options.maxRationaleLength,
          }),
          model,
        };
      } catch {
        if (signal.aborted || attempt === maxAttempts) throw abortError();
      }
    }

    return failedReviewResult(
      model,
      "unavailable",
      options.messages.unavailable,
    );
  } catch {
    if (options.signal?.aborted) {
      return failedReviewResult(model, "cancelled", options.messages.cancelled);
    }
    if (timeoutController.signal.aborted) {
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

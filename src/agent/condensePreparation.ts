import type { AgentMessage } from "./types.js";
import type { SummarizeResult } from "./condense.js";

/**
 * Background condense preparation ("precompute").
 *
 * Shortly before the auto-condense threshold, the engine snapshots the
 * transcript and summarizes that snapshot in the background while the turn
 * keeps running. When the threshold is reached, the prepared summary is reused
 * only if the snapshot is still an unchanged prefix of the live transcript and
 * the model is unchanged; everything appended after the snapshot is kept
 * verbatim after the summary. Any doubt falls back to the ordinary blocking
 * condense, so a discarded preparation costs one summary request, never
 * correctness.
 */

/** Lead before the apply threshold, as a share of the usable input window. */
export const PREPARE_LEAD_WINDOW_FRACTION = 0.1;
/** Absolute cap on the lead before the apply threshold. */
export const PREPARE_LEAD_MAX_TOKENS = 20_000;
/** Attempts per condense cycle; a successful condense starts a new cycle. */
export const MAX_PREPARATION_ATTEMPTS = 2;
/**
 * Reject a prepared summary when the transcript grew by at least this share of
 * the apply threshold since the snapshot: the verbatim tail alone would leave
 * the condensed session close to condensing again.
 */
export const MAX_TAIL_GROWTH_FRACTION = 0.5;

/**
 * The prepare point is the apply threshold minus the smallest of 10% of the
 * usable window, 20k tokens, and half the apply threshold.
 */
export function getPrepareThresholdTokens(
  applyTokens: number,
  maxInputTokens: number,
): number {
  const lead = Math.min(
    Math.floor(maxInputTokens * PREPARE_LEAD_WINDOW_FRACTION),
    PREPARE_LEAD_MAX_TOKENS,
    Math.floor(applyTokens / 2),
  );
  return Math.max(0, applyTokens - Math.max(0, lead));
}

export function isUnchangedPrefix(
  snapshot: readonly AgentMessage[],
  live: readonly AgentMessage[],
): boolean {
  if (snapshot.length === 0 || live.length < snapshot.length) return false;
  for (let index = 0; index < snapshot.length; index++) {
    if (snapshot[index] !== live[index]) return false;
  }
  return true;
}

export interface PreparationIdentity {
  providerId: string;
  model: string;
}

export interface ArmPreparationParams extends PreparationIdentity {
  messages: readonly AgentMessage[];
  /** Provider-comparable context usage at the snapshot. */
  usedTokens: number;
  /** Starts the background summary; must honour the abort signal. */
  start: (
    snapshot: AgentMessage[],
    signal: AbortSignal,
  ) => Promise<SummarizeResult>;
}

export interface TakePreparationParams extends PreparationIdentity {
  /**
   * Reads the live transcript. Called again after waiting, because a rewind
   * or repair replaces the transcript array while the preparation finishes.
   */
  readMessages: () => readonly AgentMessage[];
  usedTokens: number;
  applyTokens: number;
  signal?: AbortSignal;
}

export type PreparationRejection =
  | "none"
  | "identity_changed"
  | "transcript_changed"
  | "tail_too_large"
  | "failed"
  | "aborted";

export interface PreparationTakeResult {
  /** Prepared summary result merged with the verbatim tail. */
  result?: SummarizeResult;
  /** Transcript prefix the prepared summary covers. */
  snapshot?: readonly AgentMessage[];
  rejection?: PreparationRejection;
  /** Time spent waiting for an in-flight preparation. */
  waitMs: number;
}

interface PreparationTask extends PreparationIdentity {
  snapshot: AgentMessage[];
  usedTokens: number;
  controller: AbortController;
  promise: Promise<SummarizeResult | undefined>;
  settled: boolean;
  succeeded: boolean;
}

export class CondensePreparation {
  private task: PreparationTask | undefined;
  private attempts = 0;
  /** Usage checkpoint of the last attempt, so failures retry only on new usage. */
  private lastAttemptUsedTokens: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  get attemptCount(): number {
    return this.attempts;
  }

  get hasTask(): boolean {
    return this.task !== undefined;
  }

  /**
   * Start a preparation if none is usable. Returns true when a new background
   * summary was started.
   */
  arm(params: ArmPreparationParams): boolean {
    const existing = this.task;
    if (existing) {
      const stillValid =
        existing.providerId === params.providerId &&
        existing.model === params.model &&
        isUnchangedPrefix(existing.snapshot, params.messages);
      if (stillValid && (!existing.settled || existing.succeeded)) {
        return false;
      }
      this.discard();
    }
    if (this.attempts >= MAX_PREPARATION_ATTEMPTS) return false;
    if (this.lastAttemptUsedTokens === params.usedTokens) return false;

    this.attempts += 1;
    this.lastAttemptUsedTokens = params.usedTokens;
    const snapshot = [...params.messages];
    const controller = new AbortController();
    const task: PreparationTask = {
      providerId: params.providerId,
      model: params.model,
      snapshot,
      usedTokens: params.usedTokens,
      controller,
      settled: false,
      succeeded: false,
      promise: Promise.resolve(undefined),
    };
    task.promise = (async () => {
      try {
        const result = await params.start(snapshot, controller.signal);
        if (controller.signal.aborted || result.error) return undefined;
        task.succeeded = true;
        return result;
      } catch {
        return undefined;
      } finally {
        task.settled = true;
      }
    })();
    this.task = task;
    return true;
  }

  /**
   * Hand over the prepared summary if it is still valid, waiting for an
   * in-flight preparation (always cheaper than starting a fresh summary).
   * The preparation is consumed either way.
   */
  async take(params: TakePreparationParams): Promise<PreparationTakeResult> {
    const task = this.task;
    this.task = undefined;
    if (!task) return { rejection: "none", waitMs: 0 };
    const reject = (rejection: PreparationRejection, waitMs = 0) => {
      task.controller.abort();
      return { rejection, waitMs };
    };
    if (task.providerId !== params.providerId || task.model !== params.model) {
      return reject("identity_changed");
    }
    if (!isUnchangedPrefix(task.snapshot, params.readMessages())) {
      return reject("transcript_changed");
    }
    if (
      params.usedTokens - task.usedTokens >=
      params.applyTokens * MAX_TAIL_GROWTH_FRACTION
    ) {
      return reject("tail_too_large");
    }

    const startedAt = this.now();
    const prepared = await raceAbort(task.promise, params.signal);
    const waitMs = this.now() - startedAt;
    if (prepared === ABORTED) return reject("aborted", waitMs);
    if (!prepared) return { rejection: "failed", waitMs };
    const live = params.readMessages();
    if (!isUnchangedPrefix(task.snapshot, live)) {
      return { rejection: "transcript_changed", waitMs };
    }
    return {
      result: mergePreparedSummary(
        prepared,
        task.snapshot,
        live,
        params.usedTokens,
      ),
      snapshot: task.snapshot,
      waitMs,
    };
  }

  /** Drop any preparation. `reset` starts a new cycle after a successful condense. */
  cancel(reset: boolean): void {
    this.discard();
    if (reset) {
      this.attempts = 0;
      this.lastAttemptUsedTokens = undefined;
    }
  }

  private discard(): void {
    this.task?.controller.abort();
    this.task = undefined;
  }
}

/**
 * The prepared result covers the snapshot (originals tagged with the summary's
 * condenseParent, then the summary). Messages appended since stay untagged
 * after the summary, so getEffectiveHistory keeps them verbatim.
 */
export function mergePreparedSummary(
  prepared: SummarizeResult,
  snapshot: readonly AgentMessage[],
  live: readonly AgentMessage[],
  prevInputTokens: number,
): SummarizeResult {
  return {
    ...prepared,
    messages: [...prepared.messages, ...live.slice(snapshot.length)],
    prevInputTokens,
  };
}

const ABORTED = Symbol("aborted");

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined as T);
      },
    );
  });
}

const preparations = new WeakMap<object, CondensePreparation>();

/** Per-session preparation state; keyed weakly so it dies with the session. */
export function getCondensePreparation(session: object): CondensePreparation {
  let preparation = preparations.get(session);
  if (!preparation) {
    preparation = new CondensePreparation();
    preparations.set(session, preparation);
  }
  return preparation;
}

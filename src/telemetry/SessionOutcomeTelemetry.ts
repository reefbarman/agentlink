import * as os from "os";
import * as path from "path";

import type { GuardianComparisonMetadata } from "../approvals/guardianReviewEvidence.js";
import { appendJsonlLinesWithLock } from "./jsonlAppend.js";
import { randomUUID } from "crypto";

/**
 * Session-outcome telemetry: a local, event-level stream (one JSONL line per
 * event) complementing the aggregate tool-usage buckets. It answers questions
 * the per-minute tool buckets cannot: how long tasks take to reach a terminal
 * status, where a turn's wall-clock actually went (streaming vs tools vs
 * blocked waits), and whether background agents earned their overhead.
 */

export type HarnessRuntimeKind =
  | "builtin"
  | "acp"
  | "browser-helper"
  | "unknown";

export const COMPOSE_EFFICIENCY_SCHEMA_VERSION = 1 as const;

/**
 * Bounded, value-free efficiency counters for one turn or task. AgentEngine
 * supplies exact retained-history occupancy; SessionManager supplies turn shape
 * and provider/resource totals.
 */
export interface ComposeEfficiencySnapshot {
  schemaVersion: typeof COMPOSE_EFFICIENCY_SCHEMA_VERSION;
  enabledRequestCount: number;
  advertisedRequestCount: number;
  composeOpportunityTurns: number;
  candidateFanoutTurns: number;
  directComposableCalls: number;
  composeCalls: number;
  sameTurnRepairs: number;
  directComposableHistoryTokens: number;
  composeHistoryTokens: number;
  foldedContextReadCount: number;
  foldedContextTokens: number;
  inlineDefinitionTokens: number;
  providerAttempts: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface HarnessEfficiencySnapshot {
  ordinaryAgentProviderAttempts: number;
  condenseProviderAttempts: number;
  completedApiTurns: number;
  usageEstimatedApiTurns: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  cacheBreakdownApiTurns: number;
  cacheBreakdownInputTokens: number;
  cacheBreakdownReadTokens: number;
  cacheBreakdownCreationTokens: number;
  staticFloorSamples: number;
  staticFloorTokenSends: number;
  contextLedgerSamples: number;
  boundedContextRequestedTokens: number;
  boundedContextOmittedTokens: number;
  requestsRequestingBoundedContext: number;
  requestsWithContextOmission: number;
  contextOverflowTokens: number;
  requestsWithContextOverflow: number;
  toolCalls: number;
}

/** Wall-clock decomposition and behavior counters for one completed turn. */
export interface TurnCompletedEvent {
  type: "turn_completed";
  sessionId: string;
  background: boolean;
  mode?: string;
  model?: string;
  providerId?: string;
  promptProfile?: string;
  runtimeKind?: HarnessRuntimeKind;
  projectId?: string;
  /** End-to-end turn duration from user message to terminal session status. */
  turnDurationMs: number;
  /** Time spent inside provider streaming requests. */
  streamingMs?: number;
  /** Time spent executing tools, excluding the blocking waits below. */
  toolMs?: number;
  /** Time blocked in get_background_result / get_fleet_workflow_result. */
  backgroundWaitMs?: number;
  /** Time blocked in ask_user waiting on the user. */
  userWaitMs?: number;
  toolCalls?: number;
  apiTurns?: number;
  /** Background agents spawned during this turn. */
  spawns?: number;
  /** Background agents spawned with a review task class during this turn. */
  reviewSpawns?: number;
  /** Whether a spawn happened before any workspace-affecting tool call. */
  spawnedBeforeFirstAction?: boolean;
  /** Synthetic auto-continue restarts consumed by this turn. */
  autoContinues?: number;
  inputTokens?: number;
  outputTokens?: number;
  efficiency?: HarnessEfficiencySnapshot;
  composeEfficiency?: ComposeEfficiencySnapshot;
}

/** Terminal task status reported through set_task_status. */
export interface TaskCompletedEvent {
  type: "task_completed";
  sessionId: string;
  background: boolean;
  mode?: string;
  model?: string;
  providerId?: string;
  promptProfile?: string;
  runtimeKind?: HarnessRuntimeKind;
  projectId?: string;
  status: string;
  /** Elapsed time since the user message that started the current task. */
  taskDurationMs?: number;
  /** Turns consumed since the current task started. */
  turns?: number;
  /** Agent-active time excluding ask_user waits and idle time between turns. */
  agentActiveMs?: number;
  mixedProviderOrModel?: boolean;
  efficiency?: HarnessEfficiencySnapshot;
  composeEfficiency?: ComposeEfficiencySnapshot;
}

/** One record per background agent reaching a terminal state. */
export interface BackgroundLifecycleEvent {
  type: "background_lifecycle";
  sessionId: string;
  parentSessionId?: string;
  taskClass?: string;
  mode?: string;
  model?: string;
  projectId?: string;
  /** Time spent queued before launch. */
  queuedMs?: number;
  /** Time from launch to terminal state. */
  runMs?: number;
  terminal: string;
  terminalReason?: string;
  killed?: boolean;
  steered?: boolean;
  /** Total time one or more waiters blocked on this agent's result. */
  parentBlockedMs?: number;
  budgetToolCalls?: number;
  budgetApiTurns?: number;
  budgetElapsedMs?: number;
  usedToolCalls?: number;
  usedApiTurns?: number;
  /** Bounded backend category; ACP internals may not expose provider-turn counts. */
  backend?: "native" | "acp";
  modelTier?: "cheap" | "balanced" | "deep_reasoning";
  reviewTargetKind?: "working_tree" | "files" | "commit_range" | "diff";
  reviewHandoffBytes?: number;
  reviewInlineBytes?: number;
  reportedInputTokens?: number;
  reportedOutputTokens?: number;
  reportedCacheReadTokens?: number;
  reportedCacheCreationTokens?: number;
  /** Review-classed agents: parsed result envelope shape. */
  reviewFindings?: Record<string, number>;
  reviewEmptyDiff?: boolean;
  /** Legacy field retained while old telemetry rows age out. */
  reviewScopeBytes?: number;
}

/**
 * A human-facing approval card shown while the complete Approve for Me policy
 * was active. Values are deliberately bounded categories; action text, paths,
 * reviewer rationale, and other request payloads are never recorded.
 */
export interface ApprovalInterruptionEvent {
  type: "approval_interruption";
  sessionId: string;
  background: boolean;
  mode?: string;
  projectId?: string;
  approvalKind: string;
  reason: string;
  guardianStatus?: string;
  guardianOutcome?: string;
  risk?: string;
  permissionIntent?: string;
  authorityReason?: string;
  routeReason?: string;
  reviewPublicationCommand?: boolean;
}

/** No action text or target values, and no execution authority. */
export interface ReviewPublicationAttemptEvent {
  type: "review_publication_attempt";
  sessionId: string;
  scopeEvidence: "verified" | "unavailable";
  stage: "guardian_attempt";
}

export type GuardianShadowActionFamily =
  | "read_only"
  | "mutation"
  | "project_toolchain"
  | "external"
  | "secret"
  | "destructive"
  | "privileged"
  | "opaque"
  | "mixed"
  | "unknown"
  | "unreported";

export type GuardianShadowAuthorizationEvidence =
  | "missing"
  | "complete"
  | "redacted"
  | "truncated"
  | "redacted_truncated"
  | "unreported";

/** Completeness of host-verified human UI decisions supplied to the shadow. */
export type GuardianShadowHumanDecisionEvidence =
  | "none"
  | "complete"
  | "omitted"
  | "redacted"
  | "unreported";

export type GuardianShadowDecisionBasis =
  | "authorized"
  | "authorization"
  | "objective_mismatch"
  | "secret_exposure"
  | "unbounded_impact"
  | "security_impact"
  | "incomplete_evidence"
  | "other";

/**
 * One paired TypeSafe shadow/current Guardian observation. This deliberately
 * excludes commands, paths, prompts, evidence, rationale, and API credentials.
 * Diagnostic dimensions are bounded enums derived before telemetry is written.
 */
export interface GuardianShadowComparisonEvent {
  type: "guardian_shadow_comparison";
  sessionId: string;
  /** Generated before primary and shadow dispatch; joins both to one review. */
  reviewId?: string;
  toolCallId?: string;
  /** Session human-input revision the review context reflected. */
  authorizationRevision?: number;
  reviewKind: "command";
  shadowProvider: "typesafe";
  primaryModel?: string;
  primaryPolicyFingerprint?: string;
  shadowModel?: string;
  shadowPolicyFingerprint?: string;
  humanDecisionEvidence?: GuardianShadowHumanDecisionEvidence;
  humanDecisionCount?: number;
  primaryStatus: string;
  primaryOutcome: string;
  primaryRisk: string;
  primaryAuthorization: string;
  primaryDurationMs: number;
  actionFamily: GuardianShadowActionFamily;
  authorizationEvidence: GuardianShadowAuthorizationEvidence;
  shadowStatus: string;
  shadowOutcome?: string;
  shadowRisk?: string;
  shadowAuthorization?: string;
  shadowDecisionBasis?: GuardianShadowDecisionBasis;
  shadowDurationMs: number;
  outcomesAgree?: boolean;
  shadowFaster?: boolean;
  shadowConfidencePermille?: number;
  shadowAllowProbabilityPermille?: number;
  shadowRiskConfidencePermille?: number;
  shadowRiskProbabilitiesPermille?: Record<string, number>;
  shadowAuthorizationConfidencePermille?: number;
  shadowAuthorizationProbabilitiesPermille?: Record<string, number>;
  shadowInputRedacted?: boolean;
  shadowEvidenceWithheld?: boolean;
  objectiveMatchPermille?: number;
  secretExposurePermille?: number;
  boundedImpactPermille?: number;
  shadowInputTokens?: number;
  shadowOutputTokens?: number;
  shadowHttpStatus?: number;
  comparisonVersion?: 2;
  comparison?: GuardianComparisonMetadata;
}

export type SessionOutcomeEvent =
  | TurnCompletedEvent
  | TaskCompletedEvent
  | BackgroundLifecycleEvent
  | ApprovalInterruptionEvent
  | ReviewPublicationAttemptEvent
  | GuardianShadowComparisonEvent;

export interface SessionOutcomeRecord {
  version: 1;
  at: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
}

export interface SessionOutcomeTelemetryOptions {
  extensionVersion?: string;
  flushIntervalMs?: number;
  telemetryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  maxBufferedEvents?: number;
  log?: (message: string) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 5_000;

function getDefaultTelemetryPath(): string {
  return path.join(
    os.homedir(),
    ".agentlink",
    "session-outcome-telemetry.jsonl",
  );
}

/** Narrow writer contract for call sites that do not need storage lifecycle APIs. */
export interface SessionOutcomeRecorder {
  record(event: SessionOutcomeEvent): void;
}

export class SessionOutcomeTelemetry implements SessionOutcomeRecorder {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly maxBufferedEvents: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private buffered: string[] = [];
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: SessionOutcomeTelemetryOptions = {}) {
    this.telemetryPath = options.telemetryPath ?? getDefaultTelemetryPath();
    this.extensionVersion = options.extensionVersion ?? "unknown";
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.maxBufferedEvents =
      options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.log = options.log;

    const flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => this.logFlushError(err));
      }, flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  record(event: SessionOutcomeEvent): void {
    if (this.disposed) return;
    if (!event.sessionId?.trim()) return;
    const record: SessionOutcomeRecord & SessionOutcomeEvent = {
      version: 1,
      at: new Date().toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
      ...sanitizeEvent(event),
    };
    this.buffered.push(JSON.stringify(record));
    // Drop oldest under sustained flush failure rather than growing unbounded.
    if (this.buffered.length > this.maxBufferedEvents) {
      this.buffered.splice(0, this.buffered.length - this.maxBufferedEvents);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush().catch((err) => this.logFlushError(err));
  }

  private async flushNow(): Promise<void> {
    if (this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    try {
      await appendJsonlLinesWithLock(this.telemetryPath, lines, {
        lockTimeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs,
        lockTimeoutError: "session_outcome_telemetry_lock_timeout",
      });
    } catch (err) {
      this.buffered = [...lines, ...this.buffered];
      throw err;
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[session-outcome-telemetry] flush failed: ${message}`);
  }
}

/**
 * Round durations and drop non-finite numbers so a bad accumulator can never
 * poison the stream. Strings pass through; unknown value types are dropped.
 */
const GUARDIAN_EVIDENCE_CATEGORIES = [
  "command",
  "context",
  "human_authority",
  "scripts",
  "inline_files",
  "deletion_targets",
  "classification",
  "confinement",
  "review_publication",
] as const;
const GUARDIAN_EVIDENCE_STATES = new Set([
  "complete",
  "partial",
  "withheld",
  "unavailable",
  "not_applicable",
]);
const GUARDIAN_EVIDENCE_REASONS = new Set([
  "source_truncated",
  "projection_budget",
  "privacy_redaction",
  "privacy_withheld",
  "collection_failed",
  "not_collected",
  "source_unknown",
]);

function safeComparisonString(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 100 &&
    /^[A-Za-z0-9._:/+-]*$/.test(value)
    ? value
    : undefined;
}

function safeComparisonCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000
    ? value
    : undefined;
}

function sanitizeCoverage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const coverage = value as Record<string, unknown>;
  const state = coverage.state;
  if (typeof state !== "string" || !GUARDIAN_EVIDENCE_STATES.has(state)) return;
  const result: Record<string, unknown> = { state };
  if (Array.isArray(coverage.reasons)) {
    result.reasons = coverage.reasons
      .filter(
        (reason): reason is string =>
          typeof reason === "string" && GUARDIAN_EVIDENCE_REASONS.has(reason),
      )
      .slice(0, GUARDIAN_EVIDENCE_REASONS.size);
  }
  for (const key of ["sourceCount", "includedCount", "omittedCount"]) {
    const count = safeComparisonCount(coverage[key]);
    if (count !== undefined) result[key] = count;
  }
  return result;
}

function sanitizeObservation(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const observation = value as Record<string, unknown>;
  const projection = observation.projection;
  if (
    !projection ||
    typeof projection !== "object" ||
    Array.isArray(projection)
  )
    return;
  const projectionValue = projection as Record<string, unknown>;
  const coverage = projectionValue.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage))
    return;
  const safeCoverage: Record<string, unknown> = {};
  for (const category of GUARDIAN_EVIDENCE_CATEGORIES) {
    const safe = sanitizeCoverage(
      (coverage as Record<string, unknown>)[category],
    );
    if (safe) safeCoverage[category] = safe;
  }
  const requestedModel = safeComparisonString(observation.requestedModel);
  const policyVersion = safeComparisonString(observation.policyVersion);
  const policyFingerprint = safeComparisonString(observation.policyFingerprint);
  const adapterVersion = safeComparisonString(observation.adapterVersion);
  const attempts = safeComparisonCount(observation.attempts);
  if (
    requestedModel === undefined ||
    policyVersion === undefined ||
    policyFingerprint === undefined ||
    adapterVersion === undefined ||
    attempts === undefined
  )
    return;
  const safeProjection = {
    version: projectionValue.version === 1 ? 1 : undefined,
    kind: [
      "primary_legacy",
      "primary_review_publication",
      "jev_shadow",
    ].includes(String(projectionValue.kind))
      ? projectionValue.kind
      : undefined,
    commandExact:
      typeof projectionValue.commandExact === "boolean"
        ? projectionValue.commandExact
        : undefined,
    coverage: safeCoverage,
  };
  const result: Record<string, unknown> = {
    policyVersion,
    policyFingerprint,
    adapterVersion,
    requestedModel,
    attempts,
    projection: safeProjection,
  };
  const reportedModel = safeComparisonString(observation.reportedModel);
  if (reportedModel !== undefined) result.reportedModel = reportedModel;
  if (
    ["reported", "not_reported", "alias_unresolved"].includes(
      String(observation.modelProvenance),
    )
  ) {
    result.modelProvenance = observation.modelProvenance;
  }
  if (
    [
      "eligible",
      "incomplete_evidence",
      "inconsistent_answers",
      "unavailable",
    ].includes(String(observation.assessment))
  ) {
    result.assessment = observation.assessment;
  }
  if (Array.isArray(observation.defaultedFields)) {
    result.defaultedFields = observation.defaultedFields
      .filter((field) => field === "risk" || field === "authorization")
      .slice(0, 2);
  }
  if (
    observation.usage &&
    typeof observation.usage === "object" &&
    !Array.isArray(observation.usage)
  ) {
    const usage = observation.usage as Record<string, unknown>;
    const safeUsage: Record<string, unknown> = {};
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "reportedAttempts",
    ]) {
      const count = safeComparisonCount(usage[key]);
      if (count !== undefined) safeUsage[key] = count;
    }
    for (const key of ["estimated", "inputTokenBreakdownReported"]) {
      if (typeof usage[key] === "boolean") safeUsage[key] = usage[key];
    }
    if (
      ["reported", "partial", "not_reported"].includes(String(usage.coverage))
    ) {
      safeUsage.coverage = usage.coverage;
    }
    result.usage = safeUsage;
  }
  return result;
}

function sanitizeComparison(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const comparison = value as Record<string, unknown>;
  const snapshotId = safeComparisonString(comparison.snapshotId);
  if (!snapshotId) return;
  const result: Record<string, unknown> = { snapshotId };
  const primary = sanitizeObservation(comparison.primary);
  const shadow = sanitizeObservation(comparison.shadow);
  if (primary) result.primary = primary;
  if (shadow) result.shadow = shadow;
  for (const key of ["policyEqual", "evidenceEqual", "evidenceComplete"]) {
    if (typeof comparison[key] === "boolean" || comparison[key] === null) {
      result[key] = comparison[key];
    }
  }
  return result;
}

function sanitizeEvent<T extends SessionOutcomeEvent>(event: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "comparisonVersion") {
      if (value === 2) sanitized[key] = value;
    } else if (key === "comparison") {
      const comparison = sanitizeComparison(value);
      if (comparison) sanitized[key] = comparison;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = Math.round(value);
    } else if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      if (value !== undefined) sanitized[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested: Record<string, number> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) {
          nested[nestedKey] = Math.round(nestedValue);
        }
      }
      sanitized[key] = nested;
    }
  }
  return sanitized as T;
}

export function createSessionOutcomeTelemetry(
  options: SessionOutcomeTelemetryOptions = {},
): SessionOutcomeTelemetry {
  return new SessionOutcomeTelemetry(options);
}

import * as os from "os";
import * as path from "path";

import type {
  ToolInvocationDimensions,
  ToolRequestObservation,
} from "../core/tools/toolTelemetry.js";

import { TOOL_CAPABILITIES } from "../core/tools/toolCapabilities.js";
import { appendJsonlLinesWithLock } from "./jsonlAppend.js";
import { randomUUID } from "crypto";

export type {
  ToolInvocationDimensions,
  ToolRequestObservation,
} from "../core/tools/toolTelemetry.js";

export type ToolUsageSource = "agent" | "mcp";
export type ToolUsageOutcome =
  | "ok"
  | "partial"
  | "error"
  | "cancelled"
  | "rejected";
export type ToolUsageMetrics = Record<string, number | string | boolean>;

export const COMPOSE_CHILD_COUNT_BUCKETS = [
  "0",
  "1",
  "2-3",
  "4-7",
  "8-15",
  "16+",
] as const;
export type ComposeChildCountBucket =
  (typeof COMPOSE_CHILD_COUNT_BUCKETS)[number];

export const COMPOSE_ERROR_KINDS = [
  "aborted",
  "budget_exhausted",
  "child_failed",
  "internal",
  "memory_limit",
  "policy",
  "script_error",
  "serialization",
  "timeout",
  "validation",
] as const;
export type ComposeErrorKind = (typeof COMPOSE_ERROR_KINDS)[number];

export const COMPOSE_ERROR_CODES = [
  "final_result_too_large",
  "child_result_too_large",
  "cumulative_child_result_too_large",
  "unsupported_data",
  "cyclic_data",
  "non_finite_data",
  "invalid_json",
  "serialization_failed",
  "child_handler_failed",
  "canonical_result_required",
  "tool_not_available",
  "tool_not_in_request",
  "tool_not_in_mode",
  "tool_not_composable",
  "tool_input_not_composable",
  "interaction_denied",
  "tool_policy",
  "request_policy",
  "mode_policy",
  "composability_policy",
  "budget_exhausted",
  "compose_runtime_busy",
  "timeout",
  "memory_limit",
  "aborted",
  "validation_failed",
  "script_policy_violation",
  "script_error",
  "internal_failure",
] as const;
export type ComposeErrorCode = (typeof COMPOSE_ERROR_CODES)[number];

export const COMPOSE_QUEUE_WAIT_BUCKETS = [
  "none",
  "lt_100ms",
  "100_499ms",
  "500_999ms",
  "1_4s",
  "5s_plus",
] as const;
export type ComposeQueueWaitBucket =
  (typeof COMPOSE_QUEUE_WAIT_BUCKETS)[number];

export const COMPOSE_ARTIFACT_RETENTION_CATEGORIES = [
  "none",
  "retained",
  "retention_failed",
] as const;
export type ComposeArtifactRetentionCategory =
  (typeof COMPOSE_ARTIFACT_RETENTION_CATEGORIES)[number];

/** Privacy-safe runtime diagnostics for one Compose call. */
export interface ComposeToolUsageObservation {
  invocation?: ToolInvocationDimensions;
  source?: ToolUsageSource;
  mode?: string;
  projectId?: string;
  outcome: ToolUsageOutcome;
  durationMs?: number;
  childCount: number;
  completedChildCount?: number;
  succeededChildCount?: number;
  failedChildCount?: number;
  cancelledChildCount?: number;
  toolAllBatchCount?: number;
  toolAllSettledBatchCount?: number;
  bridgedBytes?: number;
  runtimeReturnedBytes?: number;
  errorKind?: string;
  errorCode?: string;
  queueWaitBucket?: ComposeQueueWaitBucket;
  artifactRetention?: ComposeArtifactRetentionCategory;
  outputSpilled?: boolean;
  sameTurnRepair?: boolean;
}

export interface ToolUsageEvent {
  invocation?: ToolInvocationDimensions;
  toolName: string;
  params?: Record<string, unknown>;
  source: ToolUsageSource;
  mode?: string;
  projectId?: string;
  outcome: ToolUsageOutcome;
  durationMs?: number;
  metrics?: ToolUsageMetrics;
}

interface ToolUsageBucket {
  calls: number;
  outcomes: Partial<Record<ToolUsageOutcome, number>>;
  sources: Partial<Record<ToolUsageSource, number>>;
  modes: Record<string, number>;
  projects?: Record<string, number>;
  parameters: Record<string, number>;
  totalDurationMs: number;
  maxDurationMs: number;
  numericMetrics: Record<string, number>;
  categoricalMetrics: Record<string, number>;
}

export interface ToolInvocationGroup {
  toolName: string;
  source: ToolUsageSource | "unknown";
  mode: string;
  profile: string;
  background: boolean | null;
  route: ToolInvocationDimensions["route"];
  nesting: ToolInvocationDimensions["nesting"] | "unknown";
  calls: number;
  outcomes: Partial<Record<ToolUsageOutcome, number>>;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface ToolExposureGroup {
  toolName: string;
  mode: string;
  profile: string;
  background: boolean | null;
  exposure: "inline" | "discoverable" | "not_exposed" | "unknown";
  eligible: boolean | null;
  requests: number;
  completedRequests: number;
  incompleteRequests: number;
  requestsWithUse: number;
  eligibleCompletedRequests: number;
  eligibleRequestsWithUse: number;
  providerAttempts: number;
}

interface ToolUsageCoverage {
  attributedCalls: number;
  legacyUnattributedCalls: number;
  overflowCalls: number;
  droppedDimensions: Record<string, number>;
}

interface ToolRequestCounts {
  requests: number;
  completedRequests: number;
  incompleteRequests: number;
  providerAttempts: number;
  ignoredToolNames: number;
  overflowToolObservations: number;
}

export interface ToolUsageFlushRecord {
  version: 1 | 2;
  type: "tool_usage_flush";
  flushedAt: string;
  periodStartedAt: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
  tools: Record<string, ToolUsageBucket>;
  invocationGroups?: ToolInvocationGroup[];
  coverage?: ToolUsageCoverage;
}

export interface ToolExposureFlushRecord {
  version: 1;
  type: "tool_exposure_flush";
  flushedAt: string;
  periodStartedAt: string;
  instanceId: string;
  pid: number;
  extensionVersion: string;
  coverage: {
    executor: "native_runtime";
    snapshot: "engine_request_snapshot";
    wireAdvertisement: "unknown";
    externalAcp: "unsupported";
    providerHosted: "unsupported";
    incompleteDisposition: "failed_or_cancelled_unknown";
    pendingRequests: "unobserved";
    droppedDimensions: Record<string, number>;
  };
  totals: ToolRequestCounts;
  groups: ToolExposureGroup[];
}

export interface ToolUsageTelemetryOptions {
  extensionVersion?: string;
  flushIntervalMs?: number;
  telemetryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const COMPOSE_ERROR_KIND_SET = new Set<string>(COMPOSE_ERROR_KINDS);
const COMPOSE_ERROR_CODE_SET = new Set<string>(COMPOSE_ERROR_CODES);
export const TOOL_TELEMETRY_LIMITS = {
  tools: 256,
  invocationGroups: 512,
  exposureGroups: 2048,
  dimensionValues: 128,
} as const;
const OVERFLOW = "__overflow__";
const NATIVE_NAMES = new Set(Object.keys(TOOL_CAPABILITIES));
const MODES = new Set([
  "code",
  "architect",
  "ask",
  "debug",
  "review",
  "acp",
  "acp-readonly",
]);
const PROFILES = new Set([
  "default",
  "foreground",
  "full",
  "general",
  "review",
  "review-only",
  "readonly-research",
  "research",
  "workspace-safe",
  "interactive",
  "ask",
  "code",
  "debug",
  "design",
  "verification",
  "btw",
  "worktree-setup",
]);
const ROUTES = new Set(["direct", "native_bridge", "mcp_bridge", "unresolved"]);
const NESTING = new Set(["top_level", "compose_child"]);
const METRIC_KEYS = new Set([
  "telemetrySchemaVersion",
  "composeOutcome",
  "childCount",
  "childCountBucket",
  "completedChildCount",
  "succeededChildCount",
  "failedChildCount",
  "cancelledChildCount",
  "toolAllBatchCount",
  "toolAllSettledBatchCount",
  "bridgedBytes",
  "runtimeReturnedBytes",
  "errorKind",
  "errorCode",
  "queueWaitBucket",
  "artifactRetention",
  "outputSpilled",
  "sameTurnRepair",
  "cancelled",
  "editDurabilityStatus",
  "editDurabilityOutcome",
  "editDurabilityPolicy",
  "editDurabilityReason",
  "approval_by",
  "route",
  "error_code",
  "failure_stage",
  "command_sent",
  "process_launched",
  "capability_failure",
  "retry_safe",
  "sandbox_grant_timing",
  "timed_out",
  "writeApprovalPrompt",
  "writeApprovalPromptReason",
  "writeApprovalAuthorizationBasis",
  "writeApprovalInWorkspace",
  "writeApprovalSessionKind",
  "writeApprovalMode",
  "writeApprovalBlanketScope",
  "writeApprovalGlobalBlanketApproved",
  "writeApprovalProjectBlanketApproved",
  "writeApprovalSessionBlanketApproved",
  "writeApprovalLegacyGlobalBlanketApproved",
  "writeApprovalLegacyProjectBlanketApproved",
  "writeApprovalLegacySessionBlanketApproved",
  "writeApprovalSessionProjectBound",
  "writeApprovalSessionStatePresent",
  "writeApprovalSessionStateAgeBucket",
  "writeApprovalSessionRuleCount",
  "writeApprovalProjectRuleCount",
  "writeApprovalGlobalRuleCount",
  "writeApprovalSettingsRuleCount",
  "writeApprovalDiagnostics",
  "tier",
  "toolKind",
  "executable",
]);
const METRIC_CATEGORIES = new Set([
  ...COMPOSE_ERROR_KINDS,
  ...COMPOSE_ERROR_CODES,
  ...COMPOSE_CHILD_COUNT_BUCKETS,
  ...COMPOSE_QUEUE_WAIT_BUCKETS,
  ...COMPOSE_ARTIFACT_RETENTION_CATEGORIES,
  ...MODES,
  "true",
  "false",
  "none",
  "unknown",
  "other",
  "ok",
  "partial",
  "error",
  "cancelled",
  "rejected",
  "durable",
  "failed",
  "exact",
  "transformed",
  "reverted",
  "diverged",
  "unverifiable",
  "allow_transform",
  "preserve_exact",
  "save_failed",
  "preserving_save_failed",
  "save_reverted_edit",
  "editor_disk_diverged",
  "post_save_file_missing",
  "post_save_file_unreadable",
  "exact_preservation_failed",
  "missing_durability_evidence",
  "edit_review_state_missing",
  "sandbox_preparation_changed",
  "terminal_target_rejected",
  "sandbox_capability_launch_failed",
  "sandbox_pty_launch_failed",
  "preparation",
  "approval",
  "launch",
  "issue_failed",
  "compile_failed",
  "unknown_handle",
  "unknown_grant",
  "not_consumed",
  "consumed",
  "expired",
  "revoked",
  "wrong_session",
  "wrong_binding",
  "wrong_policy_version",
  "guardian",
  "guardian_circuit",
  "contract",
  "inherited_write",
  "user",
  "human",
  "rule",
  "command_rule",
  "sandbox",
  "routine",
  "tier",
  "native",
  "escalated",
  "auto",
  "auto_approved",
  "deterministic",
  "coordinator",
  "sandbox_verification",
  "routine_tier",
  "explicit_rule",
  "readonly_policy",
  "recent_approval",
  "model_reviewer",
  "human_edited",
  "safe",
  "sensitive",
  "dangerous",
  "blanket_approval",
  "write_rule",
  "settings_rule",
  "architect_plan",
  "master_bypass",
  "approve_for_me_temp",
  "foreground",
  "background",
  "global",
  "project",
  "session",
  "absent",
  "under_1m",
  "1m_to_1h",
  "1h_to_24h",
  "over_24h",
  "unavailable",
  "protected_memory_path",
  "no_matching_write_authority",
  "outside_workspace_requires_matching_rule",
  "legacy_policy_provider",
  "other_policy_denial",
  "unspecified_policy_denial",
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "write",
  "terminal",
]);

function createCoverage(): ToolUsageCoverage {
  return {
    attributedCalls: 0,
    legacyUnattributedCalls: 0,
    overflowCalls: 0,
    droppedDimensions: {},
  };
}

function createRequestCounts(): ToolRequestCounts {
  return {
    requests: 0,
    completedRequests: 0,
    incompleteRequests: 0,
    providerAttempts: 0,
    ignoredToolNames: 0,
    overflowToolObservations: 0,
  };
}

function emptyExposureGroup(): ToolExposureGroup {
  return {
    toolName: OVERFLOW,
    mode: "unknown",
    profile: "unknown",
    background: null,
    exposure: "unknown",
    eligible: null,
    requests: 0,
    completedRequests: 0,
    incompleteRequests: 0,
    requestsWithUse: 0,
    eligibleCompletedRequests: 0,
    eligibleRequestsWithUse: 0,
    providerAttempts: 0,
  };
}

function emptyInvocationGroup(): ToolInvocationGroup {
  return {
    toolName: OVERFLOW,
    source: "unknown",
    mode: "unknown",
    profile: "unknown",
    background: null,
    route: "unresolved",
    nesting: "unknown",
    calls: 0,
    outcomes: {},
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
}

function getDefaultTelemetryPath(): string {
  return path.join(os.homedir(), ".agentlink", "tool-usage-telemetry.jsonl");
}

function increment<K extends string>(
  counts: Partial<Record<K, number>>,
  key: K,
): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function createBucket(): ToolUsageBucket {
  return {
    calls: 0,
    outcomes: {},
    sources: {},
    modes: {},
    parameters: {},
    totalDurationMs: 0,
    maxDurationMs: 0,
    numericMetrics: {},
    categoricalMetrics: {},
  };
}

export class ToolUsageTelemetry {
  private readonly telemetryPath: string;
  private readonly instanceId = randomUUID();
  private readonly extensionVersion: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly log?: (message: string) => void;
  private readonly flushTimer?: ReturnType<typeof setInterval>;

  private buckets = new Map<string, ToolUsageBucket>();
  private invocationGroups = new Map<string, ToolInvocationGroup>();
  private exposureGroups = new Map<string, ToolExposureGroup>();
  private coverage = createCoverage();
  private requestCounts = createRequestCounts();
  private periodStartedAt = new Date();
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ToolUsageTelemetryOptions = {}) {
    this.telemetryPath = options.telemetryPath ?? getDefaultTelemetryPath();
    this.extensionVersion = options.extensionVersion ?? "unknown";
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
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

  record(event: ToolUsageEvent): void {
    if (this.disposed) return;
    if (!event.toolName.trim()) return;
    const toolName = this.toolKey(event.toolName);
    const bucket = this.buckets.get(toolName) ?? createBucket();
    this.buckets.set(toolName, bucket);
    this.recordInvocation(event);

    bucket.calls += 1;
    increment(bucket.outcomes, this.outcome(event.outcome));
    increment(bucket.sources, event.source === "mcp" ? "mcp" : "agent");

    if (event.mode)
      this.addCount(
        bucket.modes,
        this.dimension(event.mode, MODES, "mode"),
        1,
        "mode",
      );

    const projectId = event.projectId?.trim();
    if (projectId) {
      bucket.projects ??= {};
      const safeProject = /^project-[a-f0-9]{16,64}$/.test(projectId)
        ? projectId
        : "unknown";
      if (safeProject !== projectId)
        increment(this.coverage.droppedDimensions, "project");
      this.addCount(bucket.projects, safeProject, 1, "project");
    }

    if (event.params && typeof event.params === "object") {
      for (const key of Object.keys(event.params).sort()) {
        const safeKey = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)
          ? key
          : "unknown";
        if (safeKey !== key)
          increment(this.coverage.droppedDimensions, "parameter");
        this.addCount(bucket.parameters, safeKey, 1, "parameter");
      }
    }

    this.addMetrics(bucket, event.metrics);

    if (Number.isFinite(event.durationMs)) {
      const durationMs = Math.max(0, Math.round(event.durationMs ?? 0));
      bucket.totalDurationMs += durationMs;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
    }
  }

  /**
   * Record one Compose call without accepting scripts, inputs, outputs, paths,
   * child names, or arbitrary metric keys/categories.
   */
  recordCompose(observation: ComposeToolUsageObservation): void {
    this.record({
      toolName: "compose",
      invocation: observation.invocation,
      source: observation.source ?? "agent",
      mode: observation.mode,
      projectId: observation.projectId,
      outcome: observation.outcome,
      durationMs: observation.durationMs,
      metrics: {
        telemetrySchemaVersion: "1",
        composeOutcome: observation.outcome,
        childCount: nonNegativeInteger(observation.childCount),
        childCountBucket: composeChildCountBucket(observation.childCount),
        completedChildCount: nonNegativeInteger(
          observation.completedChildCount,
        ),
        succeededChildCount: nonNegativeInteger(
          observation.succeededChildCount,
        ),
        failedChildCount: nonNegativeInteger(observation.failedChildCount),
        cancelledChildCount: nonNegativeInteger(
          observation.cancelledChildCount,
        ),
        toolAllBatchCount: nonNegativeInteger(observation.toolAllBatchCount),
        toolAllSettledBatchCount: nonNegativeInteger(
          observation.toolAllSettledBatchCount,
        ),
        bridgedBytes: nonNegativeInteger(observation.bridgedBytes),
        runtimeReturnedBytes: nonNegativeInteger(
          observation.runtimeReturnedBytes,
        ),
        errorKind: boundedCategory(
          observation.errorKind,
          COMPOSE_ERROR_KIND_SET,
          "none",
        ),
        errorCode: boundedCategory(
          observation.errorCode,
          COMPOSE_ERROR_CODE_SET,
          "none",
        ),
        queueWaitBucket: observation.queueWaitBucket ?? "none",
        artifactRetention: observation.artifactRetention ?? "none",
        outputSpilled: observation.outputSpilled === true,
        sameTurnRepair: observation.sameTurnRepair === true,
      },
    });
  }

  /** Observe the immutable engine snapshot once after a logical request terminates. */
  recordRequest(observation: ToolRequestObservation): void {
    if (this.disposed) return;
    const attempts = Math.min(
      1_000,
      nonNegativeInteger(observation.providerAttempts),
    );
    if (attempts === 0) return;
    const completed = observation.completed === true;
    this.requestCounts.requests += 1;
    this.requestCounts.providerAttempts += attempts;
    if (completed) this.requestCounts.completedRequests += 1;
    else this.requestCounts.incompleteRequests += 1;
    const inline = this.nativeNames(observation.inlineToolNames);
    const deferred = this.nativeNames(observation.deferredToolNames);
    const eligible = this.nativeNames(observation.eligibleToolNames);
    const used = this.nativeNames(observation.usedToolNames);
    const mode = this.dimension(observation.mode, MODES, "mode");
    const profile = this.dimension(observation.profile, PROFILES, "profile");
    const background =
      typeof observation.background === "boolean"
        ? observation.background
        : null;
    for (const toolName of new Set([
      ...inline,
      ...deferred,
      ...eligible,
      ...used,
    ])) {
      const exposure = inline.has(toolName)
        ? "inline"
        : deferred.has(toolName)
          ? "discoverable"
          : "not_exposed";
      const dimensions = {
        toolName,
        mode,
        profile,
        background,
        exposure,
        eligible: eligible.has(toolName),
      } as const;
      const key = JSON.stringify(dimensions);
      const group = this.exposureGroup(key, {
        ...emptyExposureGroup(),
        ...dimensions,
      });
      group.requests += 1;
      group.providerAttempts += attempts;
      if (!completed) {
        group.incompleteRequests += 1;
        continue;
      }
      group.completedRequests += 1;
      if (used.has(toolName)) group.requestsWithUse += 1;
      if (
        group.toolName !== OVERFLOW &&
        eligible.has(toolName) &&
        exposure !== "not_exposed"
      ) {
        group.eligibleCompletedRequests += 1;
        if (used.has(toolName)) group.eligibleRequestsWithUse += 1;
      }
    }
  }

  private outcome(value: ToolUsageOutcome): ToolUsageOutcome {
    if (["ok", "partial", "error", "cancelled", "rejected"].includes(value))
      return value;
    increment(this.coverage.droppedDimensions, "outcome");
    return "error";
  }

  private nativeNames(names: readonly string[]): Set<string> {
    const result = new Set<string>();
    for (const name of names) {
      if (typeof name === "string" && NATIVE_NAMES.has(name.trim()))
        result.add(name.trim());
      else this.requestCounts.ignoredToolNames += 1;
    }
    return result;
  }

  private dimension(
    value: string | undefined,
    allowed: ReadonlySet<string>,
    field: string,
  ): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || normalized === "unknown") return "unknown";
    if (allowed.has(normalized)) return normalized;
    increment(this.coverage.droppedDimensions, field);
    return "other";
  }

  private toolKey(rawName: string): string {
    const name = rawName.trim();
    // Preserve the legacy MCP/name projection, but never copy it into new dimensions.
    const safe = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name)
      ? name
      : "unknown";
    if (safe !== name) increment(this.coverage.droppedDimensions, "toolName");
    if (
      this.buckets.has(safe) ||
      this.buckets.size < TOOL_TELEMETRY_LIMITS.tools - 1
    )
      return safe;
    increment(this.coverage.droppedDimensions, "toolBucket");
    return OVERFLOW;
  }

  private addCount(
    counts: Record<string, number>,
    key: string,
    value: number,
    field: string,
  ): void {
    const boundedKey =
      Object.hasOwn(counts, key) ||
      Object.keys(counts).length < TOOL_TELEMETRY_LIMITS.dimensionValues - 1
        ? key
        : OVERFLOW;
    if (boundedKey !== key) increment(this.coverage.droppedDimensions, field);
    // defineProperty also safely handles otherwise special object keys.
    Object.defineProperty(counts, boundedKey, {
      value: Math.max(
        -Number.MAX_SAFE_INTEGER,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          (Object.hasOwn(counts, boundedKey) ? counts[boundedKey] : 0) + value,
        ),
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  private invocationGroup(
    key: string,
    initial: ToolInvocationGroup,
    calls = 1,
  ): ToolInvocationGroup {
    const boundedKey =
      this.invocationGroups.has(key) ||
      this.invocationGroups.size < TOOL_TELEMETRY_LIMITS.invocationGroups - 1
        ? key
        : OVERFLOW;
    if (boundedKey === OVERFLOW) {
      this.coverage.overflowCalls += calls;
      this.addCount(
        this.coverage.droppedDimensions,
        "invocationGroup",
        calls,
        "invocationGroup",
      );
    }
    const group =
      this.invocationGroups.get(boundedKey) ??
      (boundedKey === OVERFLOW ? emptyInvocationGroup() : initial);
    this.invocationGroups.set(boundedKey, group);
    return group;
  }

  private exposureGroup(
    key: string,
    initial: ToolExposureGroup,
    observations = 1,
  ): ToolExposureGroup {
    const boundedKey =
      this.exposureGroups.has(key) ||
      this.exposureGroups.size < TOOL_TELEMETRY_LIMITS.exposureGroups - 1
        ? key
        : OVERFLOW;
    if (boundedKey === OVERFLOW)
      this.requestCounts.overflowToolObservations += observations;
    const group =
      this.exposureGroups.get(boundedKey) ??
      (boundedKey === OVERFLOW ? emptyExposureGroup() : initial);
    this.exposureGroups.set(boundedKey, group);
    return group;
  }

  private recordInvocation(event: ToolUsageEvent): void {
    if (!event.invocation) {
      this.coverage.legacyUnattributedCalls += 1;
      return;
    }
    this.coverage.attributedCalls += 1;
    const invocation = event.invocation;
    const route = ROUTES.has(invocation.route)
      ? invocation.route
      : "unresolved";
    const nesting = NESTING.has(invocation.nesting)
      ? invocation.nesting
      : "unknown";
    if (route !== invocation.route)
      increment(this.coverage.droppedDimensions, "route");
    if (nesting !== invocation.nesting)
      increment(this.coverage.droppedDimensions, "nesting");
    const dimensions = {
      toolName: NATIVE_NAMES.has(event.toolName.trim())
        ? event.toolName.trim()
        : "unknown",
      source:
        event.source === "agent" || event.source === "mcp"
          ? event.source
          : "unknown",
      mode: this.dimension(event.mode, MODES, "mode"),
      profile: this.dimension(invocation.profile, PROFILES, "profile"),
      background:
        typeof invocation.background === "boolean"
          ? invocation.background
          : null,
      route,
      nesting,
    } as const;
    const group = this.invocationGroup(JSON.stringify(dimensions), {
      ...emptyInvocationGroup(),
      ...dimensions,
    });
    group.calls += 1;
    increment(group.outcomes, this.outcome(event.outcome));
    const duration = nonNegativeInteger(event.durationMs);
    group.totalDurationMs += duration;
    group.maxDurationMs = Math.max(group.maxDurationMs, duration);
  }

  /** Record a diagnostic observation without inflating the tool call count. */
  recordMetrics(toolName: string, metrics: ToolUsageMetrics): void {
    if (this.disposed) return;
    if (!toolName.trim()) return;
    const normalizedToolName = this.toolKey(toolName);

    const bucket = this.buckets.get(normalizedToolName) ?? createBucket();
    this.buckets.set(normalizedToolName, bucket);
    this.addMetrics(bucket, metrics);
  }

  private addMetrics(
    bucket: ToolUsageBucket,
    metrics: ToolUsageMetrics | undefined,
  ): void {
    for (const [key, value] of Object.entries(metrics ?? {}).sort()) {
      if (!METRIC_KEYS.has(key)) {
        increment(this.coverage.droppedDimensions, "metricKey");
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        this.addCount(bucket.numericMetrics, key, value, "numericMetric");
      } else if (typeof value === "string" || typeof value === "boolean") {
        const category = `${key}:${this.dimension(String(value), METRIC_CATEGORIES, "metricCategory")}`;
        this.addCount(bucket.categoricalMetrics, category, 1, "metricCategory");
      }
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
    if (this.buckets.size === 0 && this.requestCounts.requests === 0) return;

    const buckets = this.buckets;
    const invocationGroups = this.invocationGroups;
    const exposureGroups = this.exposureGroups;
    const coverage = this.coverage;
    const requestCounts = this.requestCounts;
    const periodStartedAt = this.periodStartedAt;
    this.buckets = new Map();
    this.invocationGroups = new Map();
    this.exposureGroups = new Map();
    this.coverage = createCoverage();
    this.requestCounts = createRequestCounts();
    this.periodStartedAt = new Date();
    const metadata = {
      flushedAt: new Date().toISOString(),
      periodStartedAt: periodStartedAt.toISOString(),
      instanceId: this.instanceId,
      pid: process.pid,
      extensionVersion: this.extensionVersion,
    };
    const records: (ToolUsageFlushRecord | ToolExposureFlushRecord)[] = [];
    if (buckets.size > 0)
      records.push({
        ...metadata,
        version: 2,
        type: "tool_usage_flush",
        tools: Object.fromEntries([...buckets.entries()].sort()),
        invocationGroups: [...invocationGroups.entries()]
          .sort()
          .map(([, group]) => group),
        coverage,
      });
    if (requestCounts.requests > 0)
      records.push({
        ...metadata,
        version: 1,
        type: "tool_exposure_flush",
        coverage: {
          executor: "native_runtime",
          snapshot: "engine_request_snapshot",
          wireAdvertisement: "unknown",
          externalAcp: "unsupported",
          providerHosted: "unsupported",
          incompleteDisposition: "failed_or_cancelled_unknown",
          pendingRequests: "unobserved",
          droppedDimensions:
            buckets.size === 0 ? coverage.droppedDimensions : {},
        },
        totals: requestCounts,
        groups: [...exposureGroups.entries()].sort().map(([, group]) => group),
      });
    try {
      await appendJsonlLinesWithLock(
        this.telemetryPath,
        records.map((record) => JSON.stringify(record)),
        {
          lockTimeoutMs: this.lockTimeoutMs,
          staleLockMs: this.staleLockMs,
          lockTimeoutError: "tool_usage_telemetry_lock_timeout",
        },
      );
    } catch (err) {
      this.coverage.attributedCalls += coverage.attributedCalls;
      this.coverage.legacyUnattributedCalls += coverage.legacyUnattributedCalls;
      this.coverage.overflowCalls += coverage.overflowCalls;
      for (const [key, value] of Object.entries(coverage.droppedDimensions))
        this.addCount(this.coverage.droppedDimensions, key, value, "coverage");
      for (const key of Object.keys(
        requestCounts,
      ) as (keyof ToolRequestCounts)[])
        this.requestCounts[key] += requestCounts[key];
      this.mergeBucketsBack(buckets, periodStartedAt);
      for (const [key, failed] of invocationGroups) {
        const current = this.invocationGroup(
          key,
          {
            ...failed,
            calls: 0,
            outcomes: {},
            totalDurationMs: 0,
            maxDurationMs: 0,
          },
          key === OVERFLOW ? 0 : failed.calls,
        );
        current.calls += failed.calls;
        current.totalDurationMs += failed.totalDurationMs;
        current.maxDurationMs = Math.max(
          current.maxDurationMs,
          failed.maxDurationMs,
        );
        for (const [outcome, count] of Object.entries(failed.outcomes))
          this.addCount(current.outcomes, outcome, count, "outcome");
      }
      for (const [key, failed] of exposureGroups) {
        const current = this.exposureGroup(
          key,
          {
            ...emptyExposureGroup(),
            toolName: failed.toolName,
            mode: failed.mode,
            profile: failed.profile,
            background: failed.background,
            exposure: failed.exposure,
            eligible: failed.eligible,
          },
          key === OVERFLOW ? 0 : failed.requests,
        );
        for (const counter of [
          "requests",
          "completedRequests",
          "incompleteRequests",
          "requestsWithUse",
          "providerAttempts",
        ] as const)
          current[counter] += failed[counter];
        if (current.toolName !== OVERFLOW) {
          current.eligibleCompletedRequests += failed.eligibleCompletedRequests;
          current.eligibleRequestsWithUse += failed.eligibleRequestsWithUse;
        }
      }
      throw err;
    }
  }

  private mergeBucketsBack(
    failedBuckets: Map<string, ToolUsageBucket>,
    failedPeriodStartedAt: Date,
  ): void {
    if (failedPeriodStartedAt < this.periodStartedAt) {
      this.periodStartedAt = failedPeriodStartedAt;
    }
    for (const [toolName, failed] of failedBuckets) {
      const boundedName =
        this.buckets.has(toolName) ||
        this.buckets.size < TOOL_TELEMETRY_LIMITS.tools - 1
          ? toolName
          : OVERFLOW;
      const current = this.buckets.get(boundedName) ?? createBucket();
      this.buckets.set(boundedName, current);
      current.calls += failed.calls;
      for (const [key, value] of Object.entries(failed.outcomes)) {
        current.outcomes[key as ToolUsageOutcome] =
          (current.outcomes[key as ToolUsageOutcome] ?? 0) + (value ?? 0);
      }
      for (const [key, value] of Object.entries(failed.sources)) {
        current.sources[key as ToolUsageSource] =
          (current.sources[key as ToolUsageSource] ?? 0) + (value ?? 0);
      }
      for (const [key, value] of Object.entries(failed.modes)) {
        this.addCount(current.modes, key, value, "mode");
      }
      for (const [key, value] of Object.entries(failed.projects ?? {})) {
        current.projects ??= {};
        this.addCount(current.projects, key, value, "project");
      }
      for (const [key, value] of Object.entries(failed.parameters)) {
        this.addCount(current.parameters, key, value, "parameter");
      }
      for (const [key, value] of Object.entries(failed.numericMetrics)) {
        this.addCount(current.numericMetrics, key, value, "numericMetric");
      }
      for (const [key, value] of Object.entries(failed.categoricalMetrics)) {
        this.addCount(current.categoricalMetrics, key, value, "metricCategory");
      }
      current.totalDurationMs += failed.totalDurationMs;
      current.maxDurationMs = Math.max(
        current.maxDurationMs,
        failed.maxDurationMs,
      );
    }
  }

  private logFlushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log?.(`[tool-usage-telemetry] flush failed: ${message}`);
  }
}

export function composeChildCountBucket(
  childCount: number,
): ComposeChildCountBucket {
  const count = nonNegativeInteger(childCount);
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 7) return "4-7";
  if (count <= 15) return "8-15";
  return "16+";
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value ?? 0)))
    : 0;
}

function boundedCategory(
  value: string | undefined,
  allowed: ReadonlySet<string>,
  absent: string,
): string {
  if (!value) return absent;
  return allowed.has(value) ? value : "other";
}

export function createToolUsageTelemetry(
  options: ToolUsageTelemetryOptions = {},
): ToolUsageTelemetry {
  return new ToolUsageTelemetry(options);
}

import { useEffect, useRef, useState } from "preact/hooks";
import { formatBackgroundRuntimeStatus } from "./backgroundRuntimeStatus";

export interface BgSessionInfoProps {
  id: string;
  task: string;
  status:
    | "queued"
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error"
    | "cancelled"
    | "pending";
  currentTool?: string;
  displayStatus?: string;
  displayStatusSource?: "terminal" | "model" | "heuristic";
  resolvedMode?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  taskClass?: string;
  routingReason?: string;
  fallbackUsed?: boolean;
  parentSessionId?: string;
  rootSessionId?: string;
  goalId?: string;
  workflowId?: string;
  workspace?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  depth?: number;
  placement?: "background" | "worktree" | "remote";
  delegation?: {
    ownedPaths?: string[];
    forbiddenPaths?: string[];
    permissionProfile?: string;
    worktree?: "shared" | "isolated";
    expectedResult?: string;
  };
  backend?: string;
  capabilities?: {
    canRead: boolean;
    canWrite: boolean;
    canExecute: boolean;
    canUseMcp: boolean;
    canDelegate: boolean;
    limitationReason?: string;
  };
  lifecycle?:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted"
    | "paused"
    | "interrupted";
  terminalReason?: string;
  createdAt?: number;
  lastActiveAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  phaseStartedAt?: number;
  requestStartedAt?: number;
  requestElapsedMs?: number;
  retryAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  phase?:
    | "queued"
    | "waiting_for_provider"
    | "thinking"
    | "responding"
    | "executing_tool"
    | "awaiting_approval"
    | "retrying_provider"
    | "completed"
    | "failed"
    | "cancelled";
  canSteer?: boolean;
  canKill?: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCalls?: number;
  apiTurns?: number;
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxApiTurns?: number;
    maxElapsedMs?: number;
    maxEstimatedCostUsd?: number;
    estimatedCostPerMillionTokens?: number;
    warningThresholdRatio?: number;
    scope?: "session" | "subtree" | "goal";
  };
  attention?:
    | "approval"
    | "question"
    | "failed"
    | "interrupted"
    | "budget_warning";
  attentionEvent?: {
    id: string;
    kind:
      | "approval"
      | "question"
      | "completion"
      | "failure"
      | "interrupted"
      | "budget_warning";
    timestamp: number;
  };
  archivedAt?: number;
  unreadEventCount?: number;
  events?: Array<{
    id: string;
    sequence: number;
    type: string;
    timestamp: number;
    summary: string;
    readAt?: number;
  }>;
  policyAuditCount?: number;
  structuredResult?: import("../../FleetWorkflows.js").FleetResultEnvelope;
  streamingText?: string;
  resultSummary?: string;
  errorMessage?: string;
  completedAt?: number;
  summaryMeta?: {
    inFlight: boolean;
    generatedAt?: number;
    sourceModel?: string;
    fallbackUsed?: boolean;
    confidence?: number;
    lastAttemptAt?: number;
    lastFailureAt?: number;
    lastFailureReason?: string;
  };
}

interface Props {
  sessions: BgSessionInfoProps[];
  /** Incremented when a newly admitted agent should reveal the active fleet view. */
  openToActiveRequest?: number;
  onStop: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
  onSteer?: (sessionId: string, message: string) => void;
  onDetach?: (sessionId: string) => void;
  onRetry?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onPause?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
}

const ACTIVE_STATUSES = new Set<BgSessionInfoProps["status"]>([
  "queued",
  "pending",
  "streaming",
  "tool_executing",
  "awaiting_approval",
]);

function formatElapsed(startMs: number, now: number): string {
  const secs = Math.floor((now - startMs) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function statusIcon(status: BgSessionInfoProps["status"]): string {
  switch (status) {
    case "queued":
    case "pending":
    case "streaming":
    case "tool_executing":
      return "codicon-loading codicon-modifier-spin";
    case "awaiting_approval":
      return "codicon-bell";
    case "idle":
      return "codicon-check";
    case "cancelled":
      return "codicon-circle-slash";
    case "error":
      return "codicon-error";
  }
}

function statusText(
  status: BgSessionInfoProps["status"],
  currentTool?: string,
  displayStatus?: string,
  runtime?: Pick<BgSessionInfoProps, "phase" | "requestStartedAt" | "retryAt">,
  now = Date.now(),
): string {
  if (
    status === "streaming" &&
    (runtime?.phase === "waiting_for_provider" ||
      runtime?.phase === "thinking" ||
      runtime?.phase === "responding" ||
      runtime?.phase === "retrying_provider")
  ) {
    const runtimeStatus = formatBackgroundRuntimeStatus(runtime, now);
    if (runtimeStatus) return runtimeStatus;
  }
  switch (status) {
    case "queued":
      return "Queued";
    case "pending":
      return "Starting…";
    case "streaming":
      return displayStatus ?? (currentTool ? currentTool : "Thinking…");
    case "tool_executing":
      return displayStatus ?? (currentTool ? currentTool : "Running…");
    case "awaiting_approval":
      return "Awaiting approval";
    case "idle":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
  }
}

export function BackgroundSessionStrip({
  sessions,
  openToActiveRequest = 0,
  onStop,
  onOpenTranscript,
  onSteer,
  onDetach,
  onRetry,
  onArchive,
  onPause,
  onResume,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [filter, setFilter] = useState<
    "all" | "active" | "attention" | "completed" | "archived"
  >("active");
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [providerFilter, setProviderFilter] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [goalFilter, setGoalFilter] = useState("");
  const [startedAt, setStartedAt] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());
  const previousOpenRequestRef = useRef(openToActiveRequest);

  useEffect(() => {
    if (openToActiveRequest === previousOpenRequestRef.current) return;
    previousOpenRequestRef.current = openToActiveRequest;
    setCollapsed(false);
    setFilter("active");
  }, [openToActiveRequest]);

  // Prefer the authoritative runtime start so reconnecting browser/webview
  // clients do not reset the elapsed clock to zero.
  useEffect(() => {
    const active = sessions.filter((s) => ACTIVE_STATUSES.has(s.status));
    if (active.length === 0) return;
    setStartedAt((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const s of active) {
        const authoritativeStart = s.startedAt ?? s.createdAt;
        if (!next.has(s.id) || authoritativeStart !== undefined) {
          const start = authoritativeStart ?? Date.now();
          if (next.get(s.id) === start) continue;
          next.set(s.id, start);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Tick every second while any session is active.
  // Use a ref to track active state so the interval doesn't depend on
  // `sessions` — otherwise the interval is torn down and recreated on every
  // bg sessions update (~150ms during streaming), preventing it from ever
  // reaching its 1000ms tick.
  const hasActive = sessions.some((s) => ACTIVE_STATUSES.has(s.status));
  const hasActiveRef = useRef(hasActive);
  hasActiveRef.current = hasActive;

  useEffect(() => {
    if (!hasActive) return;
    const interval = setInterval(() => {
      if (hasActiveRef.current) {
        setNow(Date.now());
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [hasActive]);

  const visibleSessions = sessions.filter((session) => {
    if (providerFilter && session.resolvedProvider !== providerFilter)
      return false;
    if (workspaceFilter && session.workspace !== workspaceFilter) return false;
    if (goalFilter && session.goalId !== goalFilter) return false;
    if (filter === "active") return ACTIVE_STATUSES.has(session.status);
    if (filter === "attention") return Boolean(session.attention);
    if (filter === "completed") {
      return !ACTIVE_STATUSES.has(session.status) && !session.archivedAt;
    }
    if (filter === "archived") return Boolean(session.archivedAt);
    return !session.archivedAt;
  });
  if (sessions.length === 0) return null;

  const runningCount = visibleSessions.filter(
    (s) => s.status === "streaming" || s.status === "tool_executing",
  ).length;
  const doneCount = visibleSessions.filter(
    (s) =>
      s.status === "idle" || s.status === "error" || s.status === "cancelled",
  ).length;

  return (
    <div class="bg-session-strip">
      <button
        type="button"
        class="bg-session-strip-header"
        onClick={() => setCollapsed(!collapsed)}
        title={`${collapsed ? "Expand" : "Collapse"} agent fleet`}
      >
        <i class="codicon codicon-server-process" />
        <span class="bg-session-strip-title">
          Agent Fleet {doneCount}/{visibleSessions.length}
        </span>
        {runningCount > 0 && (
          <span class="bg-session-strip-active">{runningCount} running</span>
        )}
        <i
          class={`codicon codicon-chevron-${collapsed ? "right" : "down"} bg-session-strip-chevron`}
        />
      </button>
      {!collapsed && (
        <div class="bg-session-strip-body">
          <div
            class="bg-session-filters"
            role="group"
            aria-label="Fleet filters"
          >
            {(
              ["all", "active", "attention", "completed", "archived"] as const
            ).map((value) => (
              <button
                type="button"
                key={value}
                class={`bg-session-filter${filter === value ? " active" : ""}`}
                onClick={() => setFilter(value)}
                title={`Show ${value} agents`}
              >
                {value}
              </button>
            ))}
            <button
              type="button"
              class="bg-session-filter"
              onClick={() => setViewMode(viewMode === "tree" ? "flat" : "tree")}
              title={`Switch to ${viewMode === "tree" ? "flat" : "tree"} view`}
            >
              {viewMode}
            </button>
            <select
              class="bg-session-select"
              value={providerFilter}
              onChange={(event) =>
                setProviderFilter(
                  (event.currentTarget as HTMLSelectElement).value,
                )
              }
              aria-label="Filter by provider"
            >
              <option value="">All providers</option>
              {[
                ...new Set(
                  sessions
                    .map((item) => item.resolvedProvider)
                    .filter((value): value is string => Boolean(value)),
                ),
              ].map((value) => (
                <option value={value}>{value}</option>
              ))}
            </select>
            <select
              class="bg-session-select"
              value={workspaceFilter}
              onChange={(event) =>
                setWorkspaceFilter(
                  (event.currentTarget as HTMLSelectElement).value,
                )
              }
              aria-label="Filter by workspace"
            >
              <option value="">All workspaces</option>
              {[
                ...new Set(
                  sessions
                    .map((item) => item.workspace)
                    .filter((value): value is string => Boolean(value)),
                ),
              ].map((value) => (
                <option value={value}>{value}</option>
              ))}
            </select>
            <select
              class="bg-session-select"
              value={goalFilter}
              onChange={(event) =>
                setGoalFilter((event.currentTarget as HTMLSelectElement).value)
              }
              aria-label="Filter by goal"
            >
              <option value="">All goals</option>
              {[
                ...new Set(
                  sessions
                    .map((item) => item.goalId)
                    .filter((value): value is string => Boolean(value)),
                ),
              ].map((value) => (
                <option value={value}>{value}</option>
              ))}
            </select>
          </div>
          {visibleSessions.length === 0 && (
            <div class="bg-session-empty">No agents match this filter.</div>
          )}
          {visibleSessions.map((s) => (
            <div
              key={s.id}
              class={`bg-session-card bg-session-${s.status}`}
              data-attention={s.attention}
              style={{
                paddingLeft:
                  viewMode === "tree"
                    ? `${6 + Math.max(0, s.depth ?? 1) * 10}px`
                    : "6px",
              }}
              title={[
                s.parentSessionId ? `parent: ${s.parentSessionId}` : null,
                s.resolvedMode ? `mode: ${s.resolvedMode}` : null,
                s.backend ? `backend: ${s.backend}` : null,
                s.capabilities?.limitationReason
                  ? `limitation: ${s.capabilities.limitationReason}`
                  : null,
                s.resolvedProvider ? `provider: ${s.resolvedProvider}` : null,
                s.resolvedModel ? `model: ${s.resolvedModel}` : null,
                s.lifecycle ? `lifecycle: ${s.lifecycle}` : null,
                s.phase ? `phase: ${s.phase}` : null,
                s.elapsedMs !== undefined
                  ? `elapsed: ${Math.round(s.elapsedMs / 1000)}s`
                  : null,
                s.idleMs !== undefined
                  ? `quiet for: ${Math.round(s.idleMs / 1000)}s`
                  : null,
                s.goalId ? `goal: ${s.goalId}` : null,
                s.workflowId ? `workflow: ${s.workflowId}` : null,
                s.workspace ? `workspace: ${s.workspace}` : null,
                s.worktreePath ? `worktree: ${s.worktreePath}` : null,
                s.worktreeBranch ? `branch: ${s.worktreeBranch}` : null,
                s.delegation
                  ? `delegation: ${JSON.stringify(s.delegation)}`
                  : null,
                s.terminalReason ? `reason: ${s.terminalReason}` : null,
                `tokens: ${(s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)}`,
                s.toolCalls !== undefined ? `tools: ${s.toolCalls}` : null,
                s.apiTurns !== undefined ? `API turns: ${s.apiTurns}` : null,
                s.budget ? `budget: ${JSON.stringify(s.budget)}` : null,
                s.policyAuditCount
                  ? `policy decisions: ${s.policyAuditCount}`
                  : null,
                s.structuredResult
                  ? `result: ${JSON.stringify(s.structuredResult)}`
                  : null,
              ]
                .filter((value): value is string => Boolean(value))
                .join("\n")}
            >
              {(s.depth ?? 1) > 1 && (
                <i class="codicon codicon-debug-step-into bg-session-parent-link" />
              )}
              <i class={`codicon ${statusIcon(s.status)} bg-session-icon`} />
              <span class="bg-session-task" title={s.task}>
                {s.task}
              </span>
              <span
                class="bg-session-status"
                title={[
                  statusText(s.status, s.currentTool, s.displayStatus, s, now),
                  s.displayStatusSource
                    ? `source: ${s.displayStatusSource}`
                    : null,
                  s.summaryMeta?.sourceModel
                    ? `model: ${s.summaryMeta.sourceModel}`
                    : null,
                  s.summaryMeta?.generatedAt
                    ? `age: ${Math.max(0, Math.round((Date.now() - s.summaryMeta.generatedAt) / 1000))}s`
                    : null,
                  s.summaryMeta?.lastFailureReason
                    ? `last error: ${s.summaryMeta.lastFailureReason}`
                    : null,
                ]
                  .filter((v): v is string => Boolean(v))
                  .join("\n")}
              >
                {statusText(s.status, s.currentTool, s.displayStatus, s, now)}
                {s.summaryMeta?.inFlight && (
                  <i
                    class="codicon codicon-sync codicon-modifier-spin"
                    style="margin-left:6px; opacity:0.8;"
                    title="Refreshing summary"
                  />
                )}
              </span>
              {ACTIVE_STATUSES.has(s.status) && startedAt.has(s.id) && (
                <span class="bg-session-timer">
                  {formatElapsed(startedAt.get(s.id)!, now)}
                </span>
              )}
              {(s.canKill ?? ACTIVE_STATUSES.has(s.status)) && (
                <button
                  type="button"
                  class="icon-button bg-session-stop"
                  onClick={() => onStop(s.id)}
                  title="Stop this agent and keep its partial output"
                  aria-label="Stop this agent and keep its partial output"
                >
                  <i class="codicon codicon-close" />
                </button>
              )}
              {(s.canSteer ??
                (s.status === "streaming" ||
                  s.status === "tool_executing" ||
                  s.status === "awaiting_approval")) &&
                onSteer && (
                  <button
                    type="button"
                    class="icon-button bg-session-action"
                    onClick={() => {
                      const message = window.prompt("Steer this agent:");
                      if (message?.trim()) onSteer(s.id, message.trim());
                    }}
                    title="Send new instructions to this running agent"
                    aria-label="Send new instructions to this running agent"
                  >
                    <i class="codicon codicon-debug-step-over" />
                  </button>
                )}
              {ACTIVE_STATUSES.has(s.status) && onPause && (
                <button
                  type="button"
                  class="icon-button bg-session-action"
                  onClick={() => onPause(s.id)}
                  title="Pause this agent so it can be resumed later"
                  aria-label="Pause this agent so it can be resumed later"
                >
                  <i class="codicon codicon-debug-pause" />
                </button>
              )}
              {s.lifecycle === "paused" && onResume && (
                <button
                  type="button"
                  class="icon-button bg-session-action"
                  onClick={() => onResume(s.id)}
                  title="Restart agent from its saved task and transcript"
                  aria-label="Restart agent from its saved task and transcript"
                >
                  <i class="codicon codicon-debug-start" />
                </button>
              )}
              {s.parentSessionId && onDetach && (
                <button
                  type="button"
                  class="icon-button bg-session-action"
                  onClick={() => onDetach(s.id)}
                  title="Detach this agent and its descendants from the current task"
                  aria-label="Detach this agent and its descendants from the current task"
                >
                  <i class="codicon codicon-link" />
                </button>
              )}
              {!ACTIVE_STATUSES.has(s.status) && onRetry && (
                <button
                  type="button"
                  class="icon-button bg-session-action"
                  onClick={() => onRetry(s.id)}
                  title="Start a new agent with the same task"
                  aria-label="Start a new agent with the same task"
                >
                  <i class="codicon codicon-refresh" />
                </button>
              )}
              {!ACTIVE_STATUSES.has(s.status) && !s.archivedAt && onArchive && (
                <button
                  type="button"
                  class="icon-button bg-session-action"
                  onClick={() => onArchive(s.id)}
                  title="Hide this finished agent from the fleet"
                  aria-label="Hide this finished agent from the fleet"
                >
                  <i class="codicon codicon-archive" />
                </button>
              )}
              <button
                type="button"
                class="icon-button bg-session-transcript"
                onClick={() => onOpenTranscript?.(s.id)}
                title="Open this agent's full transcript"
                aria-label="Open this agent's full transcript"
              >
                <i class="codicon codicon-open-preview" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

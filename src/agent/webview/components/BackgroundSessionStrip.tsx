import { useEffect, useRef, useState } from "preact/hooks";

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
  depth?: number;
  placement?: "background" | "worktree" | "remote";
  backend?: string;
  lifecycle?:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted"
    | "interrupted";
  terminalReason?: string;
  createdAt?: number;
  lastActiveAt?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCalls?: number;
  apiTurns?: number;
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxApiTurns?: number;
    maxElapsedMs?: number;
  };
  attention?: "approval" | "failed" | "interrupted";
  streamingText?: string;
  resultText?: string;
  resultSummary?: string;
  errorMessage?: string;
  completedAt?: number;
  fullTranscript?: string;
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
  onStop: (sessionId: string) => void;
  onOpenTranscript?: (sessionId: string) => void;
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
): string {
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
  onStop,
  onOpenTranscript,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<
    "all" | "active" | "attention" | "completed"
  >("all");
  const [startedAt, setStartedAt] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());

  // Record start time the first time we see each active session
  useEffect(() => {
    const active = sessions.filter((s) => ACTIVE_STATUSES.has(s.status));
    if (active.length === 0) return;
    setStartedAt((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const s of active) {
        if (!next.has(s.id)) {
          next.set(s.id, Date.now());
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
    if (filter === "active") return ACTIVE_STATUSES.has(session.status);
    if (filter === "attention") return Boolean(session.attention);
    if (filter === "completed") {
      return !ACTIVE_STATUSES.has(session.status);
    }
    return true;
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
        class="bg-session-strip-header"
        onClick={() => setCollapsed(!collapsed)}
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
          <div class="bg-session-filters" role="group" aria-label="Fleet filters">
            {(["all", "active", "attention", "completed"] as const).map(
              (value) => (
                <button
                  key={value}
                  class={`bg-session-filter${filter === value ? " active" : ""}`}
                  onClick={() => setFilter(value)}
                >
                  {value}
                </button>
              ),
            )}
          </div>
          {visibleSessions.length === 0 && (
            <div class="bg-session-empty">No agents match this filter.</div>
          )}
          {visibleSessions.map((s) => (
            <div
              key={s.id}
              class={`bg-session-card bg-session-${s.status}`}
              data-attention={s.attention}
              style={{ paddingLeft: `${6 + Math.max(0, s.depth ?? 1) * 10}px` }}
              title={[
                s.parentSessionId ? `parent: ${s.parentSessionId}` : null,
                s.resolvedMode ? `mode: ${s.resolvedMode}` : null,
                s.backend ? `backend: ${s.backend}` : null,
                s.resolvedProvider ? `provider: ${s.resolvedProvider}` : null,
                s.resolvedModel ? `model: ${s.resolvedModel}` : null,
                s.lifecycle ? `lifecycle: ${s.lifecycle}` : null,
                s.terminalReason ? `reason: ${s.terminalReason}` : null,
                `tokens: ${(s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)}`,
                s.toolCalls !== undefined ? `tools: ${s.toolCalls}` : null,
                s.apiTurns !== undefined ? `API turns: ${s.apiTurns}` : null,
                s.budget ? `budget: ${JSON.stringify(s.budget)}` : null,
              ].filter((value): value is string => Boolean(value)).join("\n")}
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
                  statusText(s.status, s.currentTool, s.displayStatus),
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
                {statusText(s.status, s.currentTool, s.displayStatus)}
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
              {ACTIVE_STATUSES.has(s.status) && (
                <button
                  class="icon-button bg-session-stop"
                  onClick={() => onStop(s.id)}
                  title="Stop background agent"
                >
                  <i class="codicon codicon-close" />
                </button>
              )}
              <button
                class="icon-button bg-session-transcript"
                onClick={() => onOpenTranscript?.(s.id)}
                title="View transcript"
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

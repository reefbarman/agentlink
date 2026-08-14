import * as fs from "fs";
import * as path from "path";

import type {
  SessionActivityDiagnosis,
  SessionActivityEvidence,
  SessionActivityQuery,
} from "../core/sessionActivityDiagnostics.js";

import type { AgentEvent } from "./types.js";
import type { ToolResult } from "../shared/types.js";
import { randomUUID } from "crypto";

export type ActivityTraceSource =
  | "foreground_agent"
  | "background_agent"
  | "mcp"
  | "user"
  | "system";

export type ActivityTraceKind =
  | "user_interjection"
  | "tool_start"
  | "tool_result"
  | "api_request_start"
  | "api_request"
  | "background_summary_start"
  | "background_summary_complete"
  | "background_summary_error"
  | "condense_start"
  | "condense_complete"
  | "condense_error"
  | "checkpoint_created"
  | "todo_update"
  | "final_marker"
  | "warning"
  | "error"
  | "done";

export interface ActivityTraceEvent {
  id: string;
  sessionId: string;
  projectId?: string;
  timestamp: number;
  sequence: number;
  kind: ActivityTraceKind;
  source: ActivityTraceSource;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface ActivityTraceSummary {
  sessionId: string;
  projectId?: string;
  eventCount: number;
  recordedEventCount: number;
  droppedEventCount: number;
  traceTruncated: boolean;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  totalToolResultTextChars: number;
  toolResultTextCharsByName: Record<string, number>;
  apiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  condenseCount: number;
  userInterjectionCount: number;
  finalMarkerCount: number;
  warningCount: number;
  errorCount: number;
  lastEventAt?: number;
  finalStatus?: string;
}

export interface ActivityTraceRecorderOptions {
  workspaceDir: string;
  /** Exact session-history directory; defaults to the legacy workspace path. */
  historyDir?: string;
  now?: () => number;
  maxEventsPerSession?: number;
  maxSummaryChars?: number;
  maxPayloadStringChars?: number;
  maxPayloadArrayItems?: number;
  log?: (message: string) => void;
}

export interface BackgroundSummaryTraceEvent {
  type: "start" | "complete" | "error";
  provider: string;
  model: string;
  startedAt: number;
  schedulerQueued?: boolean;
  providerQueueWaitMs?: number;
  durationMs?: number;
  error?: string;
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 2_000;
const DEFAULT_MAX_SUMMARY_CHARS = 240;
const DEFAULT_MAX_PAYLOAD_STRING_CHARS = 500;
const DEFAULT_MAX_PAYLOAD_ARRAY_ITEMS = 20;
const TRACE_FILE = "activity-trace.jsonl";
const SUMMARY_FILE = "activity-trace-summary.json";
/**
 * How long appended events sit in the buffer before a flush. Long enough to
 * coalesce a burst of agent events into one append per session, short enough
 * that a crash loses at most a beat of diagnostics.
 */
const FLUSH_DELAY_MS = 50;

export class ActivityTraceRecorder {
  private readonly historyDir: string;
  private readonly now: () => number;
  private readonly maxEventsPerSession: number;
  private readonly maxSummaryChars: number;
  private readonly maxPayloadStringChars: number;
  private readonly maxPayloadArrayItems: number;
  private readonly log: ((message: string) => void) | undefined;
  private persistenceDisabled = false;
  private sequences = new Map<string, number>();
  private summaries = new Map<string, ActivityTraceSummary>();
  /** Directories already created this process — skips redundant mkdir. */
  private ensuredDirs = new Set<string>();
  /**
   * Events buffered for the next flush, per session. Disk writes happen off
   * the append hot path: agent events fire many times per second and the old
   * per-event `appendFileSync` + full-summary `writeFileSync` was synchronous
   * main-thread I/O on every one of them.
   */
  private pendingBySession = new Map<string, ActivityTraceEvent[]>();
  /** Events taken by an in-progress flush but not yet confirmed on disk. */
  private inFlightBySession = new Map<string, ActivityTraceEvent[]>();
  /** Sessions whose summary snapshot must be rewritten at the next flush. */
  private dirtySummaries = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Single-lane flush chain — at most one flush touches disk at a time. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: ActivityTraceRecorderOptions) {
    this.historyDir =
      options.historyDir ??
      path.join(options.workspaceDir, ".agentlink", "history");
    this.now = options.now ?? Date.now;
    this.maxEventsPerSession =
      options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
    this.maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
    this.maxPayloadStringChars =
      options.maxPayloadStringChars ?? DEFAULT_MAX_PAYLOAD_STRING_CHARS;
    this.maxPayloadArrayItems =
      options.maxPayloadArrayItems ?? DEFAULT_MAX_PAYLOAD_ARRAY_ITEMS;
    this.log = options.log;
  }

  appendAgentEvent(
    sessionId: string,
    projectId: string,
    event: AgentEvent,
    source: ActivityTraceSource,
  ): ActivityTraceEvent | null {
    const draft = this.convertAgentEvent(sessionId, event, source);
    if (!draft) return null;
    return this.append(projectId, draft);
  }

  appendBackgroundSummaryEvent(
    sessionId: string,
    projectId: string,
    event: BackgroundSummaryTraceEvent,
  ): ActivityTraceEvent | null {
    const kind: ActivityTraceKind =
      event.type === "start"
        ? "background_summary_start"
        : event.type === "complete"
          ? "background_summary_complete"
          : "background_summary_error";
    const outcome =
      event.type === "start"
        ? "started"
        : event.type === "complete"
          ? "completed"
          : "failed";
    return this.append(projectId, {
      sessionId,
      kind,
      source: "system",
      timestamp: event.type === "start" ? event.startedAt : this.now(),
      summary: `Background status summary ${outcome} with ${event.model}`,
      payload: {
        provider: event.provider,
        model: event.model,
        startedAt: event.startedAt,
        schedulerQueued: event.schedulerQueued,
        providerQueueWaitMs: event.providerQueueWaitMs,
        durationMs: event.durationMs,
        error: event.error,
      },
    });
  }

  append(
    projectId: string,
    event: Omit<
      ActivityTraceEvent,
      "id" | "projectId" | "timestamp" | "sequence"
    > & {
      id?: string;
      timestamp?: number;
      sequence?: number;
    },
  ): ActivityTraceEvent | null {
    const sequence =
      event.sequence ?? (this.sequences.get(event.sessionId) ?? 0) + 1;
    this.sequences.set(event.sessionId, sequence);

    const normalized: ActivityTraceEvent = {
      id: event.id ?? randomUUID(),
      sessionId: event.sessionId,
      projectId,
      timestamp: event.timestamp ?? this.now(),
      sequence,
      kind: event.kind,
      source: event.source,
      summary: this.truncate(
        redactSensitiveText(event.summary),
        this.maxSummaryChars,
      ),
      ...(event.payload
        ? { payload: this.sanitizePayload(event.payload) }
        : {}),
    };

    const summary = this.getOrCreateSummary(event.sessionId, projectId);
    const shouldRecordEvent =
      !this.persistenceDisabled &&
      summary.recordedEventCount < this.maxEventsPerSession;

    this.updateSummary(normalized, shouldRecordEvent);
    if (!this.persistenceDisabled) {
      if (shouldRecordEvent) {
        const pending = this.pendingBySession.get(event.sessionId);
        if (pending) pending.push(normalized);
        else this.pendingBySession.set(event.sessionId, [normalized]);
      }
      this.dirtySummaries.add(event.sessionId);
      this.scheduleFlush();
    }
    return shouldRecordEvent ? normalized : null;
  }

  /**
   * Force buffered events and dirty summaries to disk. Resolves when
   * everything appended so far has been flushed (or persistence has been
   * disabled by a write failure). Flush failures never reject.
   */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushChain = this.flushChain.then(() => this.flushNow());
    return this.flushChain;
  }

  /** Best-effort final flush for host shutdown. */
  dispose(): Promise<void> {
    return this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushChain = this.flushChain.then(() => this.flushNow());
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private async flushNow(): Promise<void> {
    if (this.persistenceDisabled) return;
    const batches = this.pendingBySession;
    this.pendingBySession = new Map();
    for (const [sessionId, events] of batches) {
      this.inFlightBySession.set(sessionId, events);
    }
    const dirty = [...this.dirtySummaries];
    this.dirtySummaries.clear();

    try {
      for (const [sessionId, events] of batches) {
        const file = this.tracePath(sessionId);
        const lines = events
          .map((event) => `${JSON.stringify(event)}\n`)
          .join("");
        await this.withEnsuredDir(path.dirname(file), () =>
          fs.promises.appendFile(file, lines, "utf-8"),
        );
        this.inFlightBySession.delete(sessionId);
      }
      for (const sessionId of dirty) {
        const file = this.summaryPath(sessionId);
        const snapshot = JSON.stringify(this.getOrCreateSummary(sessionId));
        await this.withEnsuredDir(path.dirname(file), () =>
          fs.promises.writeFile(file, snapshot, "utf-8"),
        );
      }
    } catch (error) {
      this.persistenceDisabled = true;
      // Roll back counters for every recorded-but-unwritten event: the batch
      // that failed plus anything buffered while this flush was in flight.
      for (const buffered of [this.inFlightBySession, this.pendingBySession]) {
        for (const [sessionId, events] of buffered) {
          const summary = this.getOrCreateSummary(sessionId);
          summary.recordedEventCount = Math.max(
            0,
            summary.recordedEventCount - events.length,
          );
          summary.droppedEventCount += events.length;
          summary.traceTruncated = true;
        }
      }
      this.inFlightBySession.clear();
      this.pendingBySession = new Map();
      this.dirtySummaries.clear();
      this.log?.(
        `[activity-trace] Disabled persistence after write failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getSummary(sessionId: string): ActivityTraceSummary {
    return { ...this.getOrCreateSummary(sessionId) };
  }

  loadEvents(sessionId: string): ActivityTraceEvent[] {
    const file = this.tracePath(sessionId);
    let persisted: ActivityTraceEvent[];
    try {
      persisted = fs
        .readFileSync(file, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ActivityTraceEvent);
    } catch {
      persisted = [];
    }
    // Read-your-writes: include events buffered for (or taken by) a flush so
    // diagnostics never miss the newest activity.
    const inFlight = this.inFlightBySession.get(sessionId) ?? [];
    const pending = this.pendingBySession.get(sessionId) ?? [];
    if (inFlight.length === 0 && pending.length === 0) return persisted;
    return [...persisted, ...inFlight, ...pending];
  }

  loadSummary(sessionId: string): ActivityTraceSummary | null {
    // The in-memory summary is always at least as fresh as the disk snapshot
    // (summary writes are coalesced into flushes).
    const inMemory = this.summaries.get(sessionId);
    if (inMemory) return { ...inMemory };
    const file = this.summaryPath(sessionId);
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as ActivityTraceSummary;
    } catch {
      return null;
    }
  }

  diagnoseSessionActivity(
    sessionId: string,
    query: SessionActivityQuery,
  ): SessionActivityDiagnosis {
    const summary =
      this.loadSummary(sessionId) ?? this.getOrCreateSummary(sessionId);
    const limit = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 20)));
    const toolName = query.toolName?.trim();
    const toolCallId = query.toolCallId?.trim();
    const pathQuery = query.path?.trim().toLowerCase();
    const evidence = this.loadEvents(sessionId)
      .filter(
        (event) =>
          event.kind === "tool_result" ||
          event.kind === "warning" ||
          event.kind === "error",
      )
      .filter((event) => {
        if (toolName && readString(event.payload, "toolName") !== toolName) {
          return false;
        }
        if (
          toolCallId &&
          readString(event.payload, "toolCallId") !== toolCallId
        ) {
          return false;
        }
        if (
          pathQuery &&
          !JSON.stringify(event.payload ?? {})
            .toLowerCase()
            .includes(pathQuery)
        ) {
          return false;
        }
        return true;
      })
      .slice(-limit)
      .reverse()
      .map(toSessionActivityEvidence);

    return {
      sessionId,
      eventCount: summary.eventCount,
      recordedEventCount: summary.recordedEventCount,
      traceTruncated: summary.traceTruncated,
      filters: {
        ...(toolName ? { toolName } : {}),
        ...(query.path?.trim() ? { path: query.path.trim() } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        limit,
      },
      evidence,
    };
  }

  private convertAgentEvent(
    sessionId: string,
    event: AgentEvent,
    source: ActivityTraceSource,
  ):
    | (Omit<
        ActivityTraceEvent,
        "id" | "projectId" | "timestamp" | "sequence"
      > & {
        id?: string;
        timestamp?: number;
        sequence?: number;
      })
    | null {
    switch (event.type) {
      case "user_interjection":
        return {
          sessionId,
          kind: "user_interjection",
          source: "user",
          summary: summarizeText(
            "User interjection",
            event.displayText ?? event.text,
          ),
          payload: {
            queueId: event.queueId,
            isSlashCommand: event.isSlashCommand,
            slashCommandLabel: event.slashCommandLabel,
          },
        };
      case "tool_start":
        return {
          sessionId,
          kind: "tool_start",
          source,
          summary: `Started tool ${event.toolName}`,
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        };
      case "tool_result":
        return {
          sessionId,
          kind: "tool_result",
          source,
          summary: `Completed tool ${event.toolName}`,
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            durationMs: event.durationMs,
            resultContentTypes: event.result.map((item) => item.type),
            resultTextChars: countToolResultTextChars(event.result),
            input: summarizeToolInput(event.input),
            outcome: inferToolResultOutcome(event.result),
            result: summarizeToolResultEvidence(event.result),
            mcpApprovalPromoted: Boolean(event.mcpApprovalPromotion),
            mcpServerName: event.mcpApprovalPromotion?.serverName,
          },
        };
      case "api_request_start":
        return {
          sessionId,
          kind: "api_request_start",
          source,
          summary: `API request started for ${event.model}`,
          timestamp: event.startedAt,
          payload: {
            requestId: event.requestId,
            provider: event.provider,
            model: event.model,
            schedulerQueued: event.schedulerQueued,
          },
        };
      case "api_request":
        return {
          sessionId,
          kind: "api_request",
          source,
          summary: `API request to ${event.model}`,
          payload: {
            requestId: event.requestId,
            model: event.model,
            reasoningEffort: event.reasoningEffort,
            inputTokens: event.inputTokens,
            uncachedInputTokens: event.uncachedInputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            durationMs: event.durationMs,
            timeToFirstToken: event.timeToFirstToken,
            providerQueueWaitMs: event.providerQueueWaitMs,
            usedPreviousResponseId: event.usedPreviousResponseId,
            previousResponseIdFallback: event.previousResponseIdFallback,
            contextBreakdown: event.contextBreakdown,
          },
        };
      case "condense_start":
        return {
          sessionId,
          kind: "condense_start",
          source,
          summary: event.isAutomatic
            ? "Automatic condense started"
            : "Manual condense started",
          payload: { isAutomatic: event.isAutomatic },
        };
      case "condense": {
        const forensicMetadata =
          event.metadata && "providerId" in event.metadata
            ? event.metadata
            : undefined;
        return {
          sessionId,
          kind: "condense_complete",
          source,
          summary: summarizeText("Condense completed", event.summary),
          payload: {
            prevInputTokens: event.prevInputTokens,
            newInputTokens: event.newInputTokens,
            durationMs: event.durationMs,
            validationWarningCount: event.validationWarnings?.length ?? 0,
            sourceUserMessageCount: forensicMetadata?.sourceUserMessageCount,
            requestMessageCount: forensicMetadata?.requestMessageCount,
          },
        };
      }
      case "condense_error":
        return {
          sessionId,
          kind: "condense_error",
          source,
          summary: summarizeText("Condense failed", event.error),
          payload: {
            retryable: event.retryable,
            code: event.code,
          },
        };
      case "checkpoint_created":
        return {
          sessionId,
          kind: "checkpoint_created",
          source,
          summary: "Checkpoint created",
          payload: {
            checkpointId: event.checkpointId,
            turnIndex: event.turnIndex,
          },
        };
      case "todo_update":
        return {
          sessionId,
          kind: "todo_update",
          source,
          summary: `Updated ${event.todos.length} todo${event.todos.length === 1 ? "" : "s"}`,
          payload: {
            todoCount: event.todos.length,
            statuses: event.todos.map((todo) => todo.status),
          },
        };
      case "final_marker":
        return {
          sessionId,
          kind: "final_marker",
          source,
          summary: event.marker
            ? `Final status: ${event.marker.status}`
            : "Final status cleared",
          payload: event.marker
            ? {
                status: event.marker.status,
                hasSummary: Boolean(event.marker.summary?.trim()),
                continueActionConsumed: event.marker.continueActionConsumed,
              }
            : { status: null },
        };
      case "warning":
        return {
          sessionId,
          kind: "warning",
          source,
          summary: summarizeText("Warning", event.message),
          payload: {
            retryAttempt: event.retryAttempt,
            retryMaxAttempts: event.retryMaxAttempts,
            retryDelayMs: event.retryDelayMs,
          },
        };
      case "error":
        return {
          sessionId,
          kind: "error",
          source,
          summary: summarizeText("Error", event.error),
          payload: {
            retryable: event.retryable,
            code: event.code,
          },
        };
      case "done":
        return {
          sessionId,
          kind: "done",
          source,
          summary: "Agent turn completed",
          payload: {
            totalInputTokens: event.totalInputTokens,
            totalOutputTokens: event.totalOutputTokens,
            totalCacheReadTokens: event.totalCacheReadTokens,
            totalCacheCreationTokens: event.totalCacheCreationTokens,
          },
        };
      default:
        return null;
    }
  }

  private getOrCreateSummary(
    sessionId: string,
    projectId?: string,
  ): ActivityTraceSummary {
    const existing = this.summaries.get(sessionId);
    if (existing) {
      if (projectId) existing.projectId = projectId;
      return existing;
    }
    const loaded = this.loadSummary(sessionId);
    if (loaded) {
      const normalized = normalizeSummary(loaded, projectId);
      this.summaries.set(sessionId, normalized);
      this.sequences.set(sessionId, normalized.eventCount);
      return normalized;
    }
    const summary: ActivityTraceSummary = {
      sessionId,
      ...(projectId ? { projectId } : {}),
      eventCount: 0,
      recordedEventCount: 0,
      droppedEventCount: 0,
      traceTruncated: false,
      toolCalls: 0,
      toolCallsByName: {},
      totalToolResultTextChars: 0,
      toolResultTextCharsByName: {},
      apiCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      condenseCount: 0,
      userInterjectionCount: 0,
      finalMarkerCount: 0,
      warningCount: 0,
      errorCount: 0,
    };
    this.summaries.set(sessionId, summary);
    return summary;
  }

  private updateSummary(event: ActivityTraceEvent, recorded: boolean): void {
    const summary = this.getOrCreateSummary(event.sessionId, event.projectId);
    summary.eventCount += 1;
    if (recorded) {
      summary.recordedEventCount += 1;
    } else {
      summary.droppedEventCount += 1;
      summary.traceTruncated = true;
    }
    summary.lastEventAt = event.timestamp;

    if (event.kind === "tool_result") {
      summary.toolCalls += 1;
      const toolName = readString(event.payload, "toolName") ?? "unknown";
      summary.toolCallsByName[toolName] =
        (summary.toolCallsByName[toolName] ?? 0) + 1;
      const resultTextChars = readNumber(event.payload, "resultTextChars");
      summary.totalToolResultTextChars += resultTextChars;
      summary.toolResultTextCharsByName[toolName] =
        (summary.toolResultTextCharsByName[toolName] ?? 0) + resultTextChars;
    }
    if (event.kind === "api_request") {
      summary.apiCalls += 1;
      summary.totalInputTokens += readNumber(event.payload, "inputTokens");
      summary.totalOutputTokens += readNumber(event.payload, "outputTokens");
      summary.totalCacheReadTokens += readNumber(
        event.payload,
        "cacheReadTokens",
      );
      summary.totalCacheCreationTokens += readNumber(
        event.payload,
        "cacheCreationTokens",
      );
    }
    if (event.kind === "condense_complete") summary.condenseCount += 1;
    if (event.kind === "user_interjection") summary.userInterjectionCount += 1;
    if (event.kind === "final_marker") {
      summary.finalMarkerCount += 1;
      const status = readString(event.payload, "status");
      if (status) summary.finalStatus = status;
    }
    if (event.kind === "warning") summary.warningCount += 1;
    if (event.kind === "error") summary.errorCount += 1;
  }

  private sanitizePayload(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return sanitizeValue(payload, {
      maxStringChars: this.maxPayloadStringChars,
      maxArrayItems: this.maxPayloadArrayItems,
    }) as Record<string, unknown>;
  }

  private truncate(text: string, maxChars: number): string {
    return truncate(text, maxChars);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  /**
   * Run a write with the target directory ensured. If the directory was removed
   * out from under the cache (e.g. the session was deleted), recreate it and
   * retry once instead of letting persistence get disabled.
   */
  private async withEnsuredDir(
    dir: string,
    write: () => Promise<void>,
  ): Promise<void> {
    await this.ensureDir(dir);
    try {
      await write();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        throw error;
      }
      this.ensuredDirs.delete(dir);
      await this.ensureDir(dir);
      await write();
    }
  }

  private tracePath(sessionId: string): string {
    return path.join(this.historyDir, sessionId, TRACE_FILE);
  }

  private summaryPath(sessionId: string): string {
    return path.join(this.historyDir, sessionId, SUMMARY_FILE);
  }
}

function normalizeSummary(
  summary: ActivityTraceSummary,
  projectId?: string,
): ActivityTraceSummary {
  return {
    ...summary,
    ...(projectId ? { projectId } : {}),
    toolCallsByName: summary.toolCallsByName ?? {},
    totalToolResultTextChars: summary.totalToolResultTextChars ?? 0,
    toolResultTextCharsByName: summary.toolResultTextCharsByName ?? {},
  };
}

function countToolResultTextChars(result: ToolResult["content"]): number {
  if (!Array.isArray(result)) return 0;
  let total = 0;
  for (const item of result) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      total += item.text.length;
    }
  }
  return total;
}

function summarizeText(prefix: string, text: string): string {
  const trimmed = redactSensitiveText(text).trim().replace(/\s+/g, " ");
  return trimmed ? `${prefix}: ${trimmed}` : prefix;
}

function summarizeToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "path",
    "glob",
    "regex",
    "query",
    "command",
    "cwd",
    "kind",
    "line",
    "column",
    "issue",
    "task",
  ]) {
    if (key in raw) summary[key] = raw[key];
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

const TOOL_RESULT_EVIDENCE_KEYS = new Set([
  "status",
  "error",
  "reason",
  "path",
  "paths",
  "operation",
  "authorization",
  "approval",
  "auto_approved",
  "security",
  "command_sent",
  "command_modified",
  "changed_files",
  "files_changed",
  "files_modified",
  "files",
  "total_replacements",
  "server",
  "tool",
]);

function parseFirstStructuredToolResult(
  result: ToolResult["content"],
): Record<string, unknown> | undefined {
  for (const item of result) {
    if (item.type !== "text") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Plain-text results have no structured diagnostic evidence.
    }
  }
  return undefined;
}

function summarizeToolResultEvidence(
  result: ToolResult["content"],
): Record<string, unknown> | undefined {
  const parsed = parseFirstStructuredToolResult(result);
  if (!parsed) return undefined;
  const evidence = Object.fromEntries(
    Object.entries(parsed).filter(([key]) =>
      TOOL_RESULT_EVIDENCE_KEYS.has(key),
    ),
  );
  const durability = summarizeDurabilityEvidence(parsed.durability);
  if (durability) evidence.durability = durability;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function summarizeDurabilityEvidence(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const key of ["status", "outcome", "policy", "error_code"] as const) {
    if (typeof raw[key] === "string") evidence[key] = raw[key];
  }
  for (const key of ["final_exists", "disk_changed"] as const) {
    if (typeof raw[key] === "boolean" || raw[key] === "unknown") {
      evidence[key] = raw[key];
    }
  }
  if (typeof raw.requires_reread === "boolean") {
    evidence.requires_reread = raw.requires_reread;
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function inferToolResultOutcome(result: ToolResult["content"]): string {
  const parsed = parseFirstStructuredToolResult(result);
  if (!parsed) return "ok";
  if (parsed.status === "rejected" || parsed.status === "rejected_by_user") {
    return "rejected";
  }
  if (parsed.status === "cancelled") return "cancelled";
  if (parsed.status === "partial" || parsed.partial === true) return "partial";
  if (parsed.status === "error" || parsed.error !== undefined) return "error";
  return "ok";
}

function toSessionActivityEvidence(
  event: ActivityTraceEvent,
): SessionActivityEvidence {
  if (event.kind === "tool_result") {
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: "tool_result",
      source: event.source,
      summary: event.summary,
      toolCallId: readString(event.payload, "toolCallId"),
      toolName: readString(event.payload, "toolName"),
      durationMs: readOptionalNumber(event.payload, "durationMs"),
      outcome: readString(event.payload, "outcome"),
      input: event.payload?.input,
      result: event.payload?.result,
    };
  }
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind === "warning" ? "warning" : "error",
    source: event.source,
    summary: event.summary,
    retryable:
      typeof event.payload?.retryable === "boolean"
        ? event.payload.retryable
        : undefined,
    code: readString(event.payload, "code"),
  };
}

function sanitizeValue(
  value: unknown,
  options: { maxStringChars: number; maxArrayItems: number },
): unknown {
  if (typeof value === "string") {
    return truncate(redactSensitiveText(value), options.maxStringChars);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, options.maxArrayItems)
      .map((item) => sanitizeValue(item, options));
  }
  if (typeof value === "object" && value) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeValue(entry, options);
    }
    return result;
  }
  return undefined;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function readString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  payload: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalNumber(
  payload: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

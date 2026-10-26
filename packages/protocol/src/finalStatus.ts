import type { FleetResultEnvelope } from "./fleetResult.js";

export type FinalMessageStatus =
  | "completed"
  | "waiting_for_user"
  | "blocked"
  | "cancelled";

export interface FinalMarkerToolCall {
  id: string;
  name: "set_task_status";
  inputJson: string;
  result?: string;
  durationMs?: number;
}

export interface FinalMessageMarker {
  status: FinalMessageStatus;
  summary?: string;
  /** Structured result returned by a background agent to its coordinator. */
  result?: FleetResultEnvelope;
  source: "tool" | "engine";
  continueAction?: FinalMessageContinueAction;
  /** UI-owned marker that hides a consumed/stale Continue action. */
  continueActionConsumed?: boolean;
  /** @deprecated Legacy tool-set field; ignored so completed markers stay resumable. */
  continueActionSuppressed?: boolean;
  autoContinueStopReason?: string;
  /** Raw set_task_status invocation shown in the final marker inspector. */
  toolCall?: FinalMarkerToolCall;
  /**
   * Host-generated, frozen record of file changes captured through AgentLink
   * file tools. Never supplied by the model.
   */
  workSummary?: WorkSummary;
  /**
   * Host-measured wall-clock time for the ask this marker ends: from the run
   * that opened the ask (after the previous natural stop) to this marker.
   * Interjections, questions and automatic resumes do not reset it.
   */
  elapsedMs?: number;
}

/** One unified-diff hunk; lines keep their " ", "+" or "-" prefix. */
export interface WorkSummaryDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Why a captured comparison has no displayable diff. */
export type WorkSummaryDiffOmission =
  | "too_large"
  | "binary"
  | "content_unavailable"
  | "summary_budget";

/** One continuous run of captured edits with no outside change in between. */
export interface WorkSummaryDiff {
  /** Absent when the comparison could not be counted (binary/unavailable). */
  added?: number;
  removed?: number;
  hunks?: WorkSummaryDiffHunk[];
  omitted?: WorkSummaryDiffOmission;
  /** True when the saved content was changed by format-on-save. */
  formatted?: boolean;
}

export type WorkSummaryOperation = "created" | "modified" | "deleted";

/** Observation of the file at summary time, compared with the last captured edit. */
export type WorkSummaryDiskCheck =
  | "matches"
  | "changed"
  | "missing"
  | "not_checked";

export interface WorkSummaryFileChange {
  /** Workspace-relative display path (absolute outside the workspace). */
  path: string;
  /** Absolute path used to open the file. */
  absolutePath: string;
  operation: WorkSummaryOperation;
  /** Number of accepted AgentLink edits folded into this row. */
  editCount: number;
  /**
   * Continuous captured segments. More than one means the file changed
   * outside AgentLink's edits between them, so no single net diff is shown.
   */
  segments: WorkSummaryDiff[];
  diskCheck: WorkSummaryDiskCheck;
}

export type WorkSummaryCoverageNote =
  | "shell_commands"
  | "mcp_tools"
  | "background_agents"
  | "capture_restarted"
  | "storage_limit";

export interface WorkSummaryScope {
  files: WorkSummaryFileChange[];
  /** Files omitted from `files` because the summary row limit was reached. */
  omittedFiles?: number;
  coverageNotes: WorkSummaryCoverageNote[];
}

export interface WorkSummary {
  version: 1;
  id: string;
  capturedAt: number;
  /** Changes since the previous final status summary in this session. */
  sinceSummary: WorkSummaryScope;
  /** Changes through this summary since capture started for the session. */
  session?: WorkSummaryScope;
  /** True when the session scope is identical to `sinceSummary`. */
  sessionSameAsSince?: boolean;
}

export interface FinalMessageContinueAction {
  label: string;
  prompt: string;
}

export const DEFAULT_COMPLETED_CONTINUE_ACTION: FinalMessageContinueAction = {
  label: "Continue",
  prompt:
    "Continue working from where you left off. Before deciding the overall task is complete, re-check the original user request. If the completed work is a phase, handover, or scoped subtask, treat that boundary as a navigation point—not proof of overall completion—and locate and inspect its parent/source-of-truth plan, following references outward through higher-level plans if nested. Within the user-approved scope, identify and begin the next explicit unfinished phase, plan item, subtask, or validation step. If it needs a missing decision or prerequisite, surface that blocker. Do not invent work or broaden scope. Only if the full approved scope is complete, briefly confirm that no work remains.",
};

export function getFinalMessageContinueAction(
  marker: FinalMessageMarker,
): FinalMessageContinueAction | undefined {
  if (marker.continueActionConsumed) return undefined;
  return (
    marker.continueAction ??
    (marker.status === "completed"
      ? DEFAULT_COMPLETED_CONTINUE_ACTION
      : undefined)
  );
}

export interface FinalMessageWithMarker {
  id: string;
  role: string;
  finalMarker?: FinalMessageMarker;
}

export interface AutoContinueAction extends FinalMessageContinueAction {
  messageId: string;
}

export interface LatestFinalMessageMarker {
  messageId: string;
  marker: FinalMessageMarker;
}

/**
 * Returns the latest assistant final marker. User messages after a marker make
 * it stale, so the scan stops at users rather than continuing backwards to an
 * older assistant response.
 */
export function getLatestFinalMessageMarker(
  messages: readonly FinalMessageWithMarker[],
): LatestFinalMessageMarker | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return undefined;
    if (message.role !== "assistant" || !message.finalMarker) continue;
    return { messageId: message.id, marker: message.finalMarker };
  }
  return undefined;
}

/**
 * Returns the continuation action for the latest assistant final marker.
 */
export function getLatestAutoContinueAction(
  messages: readonly FinalMessageWithMarker[],
): AutoContinueAction | undefined {
  const latest = getLatestFinalMessageMarker(messages);
  if (!latest) return undefined;
  const { marker } = latest;
  const action = getFinalMessageContinueAction(marker);
  if (!action) return undefined;
  return { messageId: latest.messageId, ...action };
}

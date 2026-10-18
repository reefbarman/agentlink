import type { AssistantSessionEvent } from "./SessionEventHub.js";

/**
 * The runaway guard: watches every session's work and tells the owner when
 * one has been working a long time or looks stuck. It never stops anything;
 * only the owner's Stop does.
 *
 * A session's work is one stretch from the turn that starts it until it has
 * been idle for `stretchGapMs`, so turns that carry on by themselves (Auto
 * Continue, a task's fix rounds) count as one piece of work.
 */

export type SessionAlertKind =
  /** Still working past `longRunningMs` (and each multiple after Keep going). */
  | "long_running"
  /** The same tool call with the same input many times in a row. */
  | "repeating"
  /** Working, but no tool result or reply for `quietMs`. */
  | "quiet";

export interface SessionAlert {
  readonly projectId: string;
  readonly sessionId: string;
  readonly kind: SessionAlertKind;
  /** How long this stretch of work has run, in milliseconds. */
  readonly elapsedMs: number;
  /** The repeated tool's name, for `repeating`. */
  readonly toolName?: string;
  /** Times in a row, for `repeating`. */
  readonly repeats?: number;
}

export interface SessionWatchOptions {
  readonly onAlert: (alert: SessionAlert) => void;
  readonly now?: () => number;
  /** Default 2 hours. */
  readonly longRunningMs?: number;
  /** Identical tool calls in a row that look stuck. Default 8. */
  readonly repeatLimit?: number;
  /** Default 30 minutes. */
  readonly quietMs?: number;
  /** Idle time that ends a stretch of work. Default 2 minutes. */
  readonly stretchGapMs?: number;
}

export interface SessionWatch {
  observe(
    projectId: string,
    sessionId: string,
    event: AssistantSessionEvent,
  ): void;
  /** Check the clock-based conditions; call periodically. */
  tick(): void;
  /**
   * The owner said Keep going: no more stuck alerts for what was seen so
   * far, and the next "still working" one after another `longRunningMs`.
   */
  keepGoing(projectId: string, sessionId: string): void;
  /** Sessions with work in progress (tests and diagnostics). */
  activeCount(): number;
}

export const DEFAULT_LONG_RUNNING_MS = 2 * 60 * 60_000;
export const DEFAULT_REPEAT_LIMIT = 8;
export const DEFAULT_QUIET_MS = 30 * 60_000;
export const DEFAULT_STRETCH_GAP_MS = 2 * 60_000;

const POLLING_TOOLS = new Set([
  "get_background_result",
  "get_background_status",
  "get_terminal_output",
]);

interface Stretch {
  readonly projectId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  /** A turn is running (not finished or waiting for the owner). */
  running: boolean;
  endedAt: number | undefined;
  lastActivityAt: number;
  /** When the next "still working" alert is due. */
  longRunningAt: number;
  lastCall: string | undefined;
  lastToolName: string | undefined;
  repeats: number;
  repeatAlerted: boolean;
  quietAlerted: boolean;
}

export function createSessionWatch(options: SessionWatchOptions): SessionWatch {
  const now = options.now ?? Date.now;
  const longRunningMs = options.longRunningMs ?? DEFAULT_LONG_RUNNING_MS;
  const repeatLimit = options.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const stretchGapMs = options.stretchGapMs ?? DEFAULT_STRETCH_GAP_MS;
  const stretches = new Map<string, Stretch>();
  const keyOf = (projectId: string, sessionId: string) =>
    `${projectId}\u0000${sessionId}`;

  const alert = (
    stretch: Stretch,
    kind: SessionAlertKind,
    extra: Partial<SessionAlert> = {},
  ) => {
    try {
      options.onAlert({
        projectId: stretch.projectId,
        sessionId: stretch.sessionId,
        kind,
        elapsedMs: now() - stretch.startedAt,
        ...extra,
      });
    } catch {
      // Notifying is best effort; watching carries on.
    }
  };

  const begin = (projectId: string, sessionId: string, at: number) => {
    const key = keyOf(projectId, sessionId);
    const current = stretches.get(key);
    if (
      current &&
      (current.running ||
        (current.endedAt !== undefined && at - current.endedAt < stretchGapMs))
    ) {
      current.running = true;
      current.endedAt = undefined;
      current.lastActivityAt = at;
      return;
    }
    stretches.set(key, {
      projectId,
      sessionId,
      startedAt: at,
      running: true,
      endedAt: undefined,
      lastActivityAt: at,
      longRunningAt: at + longRunningMs,
      lastCall: undefined,
      lastToolName: undefined,
      repeats: 0,
      repeatAlerted: false,
      quietAlerted: false,
    });
  };

  return {
    observe(projectId, sessionId, event) {
      const at = now();
      if (event.kind === "task") {
        if (event.state === "started") {
          begin(projectId, sessionId, at);
          return;
        }
        const stretch = stretches.get(keyOf(projectId, sessionId));
        if (!stretch) return;
        stretch.running = false;
        stretch.endedAt = at;
        return;
      }
      if (event.kind !== "turn") return;
      const stretch = stretches.get(keyOf(projectId, sessionId));
      if (!stretch || !stretch.running) return;
      const turnEvent = event.event;
      switch (turnEvent.type) {
        case "tool.started": {
          stretch.lastActivityAt = at;
          // Waiting on a background agent is meant to be asked again.
          if (POLLING_TOOLS.has(turnEvent.toolName)) return;
          const call = `${turnEvent.toolName}\u0000${stableJson(turnEvent.displayInput)}`;
          if (call === stretch.lastCall) stretch.repeats += 1;
          else {
            stretch.lastCall = call;
            stretch.lastToolName = turnEvent.toolName;
            stretch.repeats = 1;
            stretch.repeatAlerted = false;
          }
          if (stretch.repeats >= repeatLimit && !stretch.repeatAlerted) {
            stretch.repeatAlerted = true;
            alert(stretch, "repeating", {
              toolName: turnEvent.toolName,
              repeats: stretch.repeats,
            });
          }
          return;
        }
        case "tool.completed":
        case "tool.failed":
        case "text.delta":
        case "turn.completed":
          stretch.lastActivityAt = at;
          stretch.quietAlerted = false;
          return;
        case "interaction.required":
          // Waiting for the owner is not being stuck.
          stretch.running = false;
          stretch.endedAt = at;
          return;
        default:
          return;
      }
    },
    tick() {
      const at = now();
      for (const [key, stretch] of stretches) {
        if (!stretch.running) {
          if (
            stretch.endedAt !== undefined &&
            at - stretch.endedAt >= stretchGapMs
          ) {
            stretches.delete(key);
          }
          continue;
        }
        if (at >= stretch.longRunningAt) {
          // One alert per period, however late the tick.
          while (stretch.longRunningAt <= at) {
            stretch.longRunningAt += longRunningMs;
          }
          alert(stretch, "long_running");
        }
        if (!stretch.quietAlerted && at - stretch.lastActivityAt >= quietMs) {
          stretch.quietAlerted = true;
          alert(stretch, "quiet");
        }
      }
    },
    keepGoing(projectId, sessionId) {
      const stretch = stretches.get(keyOf(projectId, sessionId));
      if (!stretch) return;
      const at = now();
      stretch.longRunningAt = Math.max(
        stretch.longRunningAt,
        at + longRunningMs,
      );
      // Count afresh: the same call again is not yet a new alert.
      stretch.repeats = 0;
      stretch.repeatAlerted = false;
      stretch.lastActivityAt = at;
      stretch.quietAlerted = false;
    },
    activeCount: () =>
      [...stretches.values()].filter((stretch) => stretch.running).length,
  };
}

/** JSON with sorted keys, so equal inputs compare equal. */
function stableJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}

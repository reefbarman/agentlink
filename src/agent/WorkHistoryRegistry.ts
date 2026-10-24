import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";

import type { WorkSummary } from "@agentlink/protocol/final-status";

import {
  hashWorkHistoryContent,
  WorkHistoryJournal,
  type CommittedEditRecord,
  type WorkHistoryActivity,
  type WorkHistoryDiskObservation,
} from "../core/workHistory.js";
import { canonicalizePath } from "../util/canonicalPath.js";

export interface WorkCaptureContext {
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
}

/** Drift checks at summary time: bounded per file, in total and in time. */
const DISK_CHECK_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxDurationMs: 500,
} as const;

const SHELL_TOOLS = new Set(["execute_command"]);
const BACKGROUND_TOOLS = new Set([
  "spawn_background_agent",
  "start_fleet_workflow",
]);

export function classifyWorkHistoryActivity(
  toolName: string,
): WorkHistoryActivity | undefined {
  if (SHELL_TOOLS.has(toolName)) return "shell_commands";
  if (BACKGROUND_TOOLS.has(toolName)) return "background_agents";
  if (toolName === "call_mcp_tool" || toolName.includes("__")) {
    return "mcp_tools";
  }
  return undefined;
}

export type CommittedEditCapture = Omit<
  CommittedEditRecord,
  "fileKey" | "absolutePath"
> & { absolutePath: string };

/**
 * Per-session journals of edits committed through AgentLink's own file tools.
 * Edits are attributed through the async context of the tool call that made
 * them, so concurrent sessions never record each other's work. Journals live
 * for the extension-host lifetime; frozen summaries persist in the transcript.
 */
export class WorkHistoryRegistry {
  private readonly storage = new AsyncLocalStorage<WorkCaptureContext>();
  private readonly journals = new Map<string, WorkHistoryJournal>();
  private readonly frozenSessions = new Set<string>();
  private readonly restartedSessions = new Set<string>();
  private readonly restoredSessions = new Set<string>();

  runWithCapture<T>(context: WorkCaptureContext, operation: () => T): T {
    const activity = context.toolName
      ? classifyWorkHistoryActivity(context.toolName)
      : undefined;
    if (activity) this.journal(context.sessionId).noteActivity(activity);
    return this.storage.run(context, operation);
  }

  /** The tool-call context recording edits, if any. */
  get activeContext(): WorkCaptureContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Record a verified committed edit for the tool call currently running.
   * Edits made outside a captured tool call are ignored. Never throws.
   */
  recordCommittedEdit(edit: CommittedEditCapture): void {
    const context = this.storage.getStore();
    if (!context) return;
    try {
      const fileKey = canonicalizePath(edit.absolutePath);
      this.journal(context.sessionId).record({ ...edit, fileKey });
    } catch {
      // Capture is best effort and must never change the edit's outcome.
    }
  }

  hasSessionChanges(sessionId: string): boolean {
    return this.journals.get(sessionId)?.hasSessionChanges ?? false;
  }

  async freeze(
    sessionId: string,
    options: {
      id: string;
      /** The transcript already has summaries from an earlier host lifetime. */
      hasEarlierSummaries?: boolean;
    },
  ): Promise<WorkSummary | undefined> {
    if (!this.frozenSessions.has(sessionId)) {
      this.frozenSessions.add(sessionId);
      if (options.hasEarlierSummaries || this.restoredSessions.has(sessionId)) {
        this.restartedSessions.add(sessionId);
      }
    }
    const journal = this.journals.get(sessionId);
    if (!journal) return undefined;
    const startedAt = Date.now();
    let totalBytes = 0;
    return journal.freeze({
      id: options.id,
      capturedAt: startedAt,
      captureRestarted: this.restartedSessions.has(sessionId),
      observe: async (absolutePath): Promise<WorkHistoryDiskObservation> => {
        if (Date.now() - startedAt > DISK_CHECK_LIMITS.maxDurationMs) {
          return undefined;
        }
        let stat;
        try {
          stat = await fs.stat(absolutePath);
        } catch (error) {
          return (error as { code?: unknown }).code === "ENOENT"
            ? { exists: false }
            : undefined;
        }
        if (
          !stat.isFile() ||
          stat.size > DISK_CHECK_LIMITS.maxFileBytes ||
          totalBytes + stat.size > DISK_CHECK_LIMITS.maxTotalBytes
        ) {
          return undefined;
        }
        totalBytes += stat.size;
        const content = await fs.readFile(absolutePath, "utf8");
        return { exists: true, hash: hashWorkHistoryContent(true, content) };
      },
    });
  }

  dispose(sessionId: string): void {
    this.journals.get(sessionId)?.clear();
    this.journals.delete(sessionId);
    this.frozenSessions.delete(sessionId);
    this.restartedSessions.delete(sessionId);
    this.restoredSessions.delete(sessionId);
  }

  /**
   * Record that a persisted session was loaded into this host lifetime, so its
   * summaries say that edits from before the reload are not included.
   */
  markRestored(sessionId: string): void {
    if (!this.frozenSessions.has(sessionId) && !this.journals.has(sessionId)) {
      this.restoredSessions.add(sessionId);
    }
  }

  private journal(sessionId: string): WorkHistoryJournal {
    let journal = this.journals.get(sessionId);
    if (!journal) {
      journal = new WorkHistoryJournal();
      this.journals.set(sessionId, journal);
    }
    return journal;
  }
}

export const workHistoryRegistry = new WorkHistoryRegistry();

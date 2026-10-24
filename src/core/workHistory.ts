import * as diffLib from "diff";

import type {
  WorkSummary,
  WorkSummaryCoverageNote,
  WorkSummaryDiff,
  WorkSummaryDiffHunk,
  WorkSummaryDiskCheck,
  WorkSummaryFileChange,
  WorkSummaryOperation,
  WorkSummaryScope,
} from "@agentlink/protocol/final-status";

import { createHash } from "node:crypto";

/**
 * Bounded, in-memory journal of file edits that AgentLink committed and
 * verified for one session. It only knows what hosts record at their verified
 * save boundaries; it never infers authorship from the current filesystem.
 */

export const WORK_HISTORY_LIMITS = {
  /** Largest file content retained for a comparison. */
  maxSnapshotBytes: 1024 * 1024,
  /** Total distinct retained content per session journal. */
  maxRetainedBytes: 10 * 1024 * 1024,
  /** Diff lines kept for one displayed comparison. */
  maxDiffLinesPerComparison: 1_000,
  /** Diff text kept for one displayed comparison. */
  maxDiffBytesPerComparison: 200 * 1024,
  /** Diff text kept across one summary scope. */
  maxDiffBytesPerScope: 256 * 1024,
  /** File rows kept in one summary scope. */
  maxFilesPerScope: 100,
  /** Distinct files tracked per session journal. */
  maxTrackedFiles: 1_000,
  /** Discontinuous segments tracked per file; the oldest are dropped. */
  maxSegmentsPerFile: 20,
  /** Compute budget for one comparison. */
  diffTimeoutMs: 1_000,
} as const;

export type WorkHistoryLimits = {
  [K in keyof typeof WORK_HISTORY_LIMITS]: number;
};

export type WorkHistoryActivity = Extract<
  WorkSummaryCoverageNote,
  "shell_commands" | "mcp_tools" | "background_agents"
>;

export interface WorkHistoryFileState {
  exists: boolean;
  /** Text content; empty when `exists` is false. */
  content: string;
}

export interface CommittedEditRecord {
  /** Canonical identity of the file. */
  fileKey: string;
  absolutePath: string;
  displayPath: string;
  before: WorkHistoryFileState;
  after: WorkHistoryFileState;
  /** Save participants transformed the approved content. */
  formatted?: boolean;
}

/** Observation of the current file, for drift detection at summary time. */
export type WorkHistoryDiskObservation =
  | { exists: true; hash: string }
  | { exists: false }
  | undefined;

export interface WorkHistoryFreezeOptions {
  id: string;
  capturedAt: number;
  /**
   * True when earlier summaries exist in the session but this journal did not
   * see them (for example after a reload), so Session so far is partial.
   */
  captureRestarted?: boolean;
  /** Reads the current file hash; undefined means not checked. */
  observe?: (absolutePath: string) => Promise<WorkHistoryDiskObservation>;
}

interface CapturedState {
  exists: boolean;
  hash: string;
  /** Undefined when content was not retained (too large, binary or budget). */
  content?: string;
  binary: boolean;
  tooLarge: boolean;
}

interface Segment {
  before: CapturedState;
  after: CapturedState;
  edits: number;
  formatted: boolean;
}

interface FileTrack {
  fileKey: string;
  absolutePath: string;
  displayPath: string;
  segments: Segment[];
}

interface ScopeTrack {
  files: Map<string, FileTrack>;
  notes: Set<WorkSummaryCoverageNote>;
}

export function hashWorkHistoryContent(
  exists: boolean,
  content: string,
): string {
  if (!exists) return "absent";
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sameState(a: CapturedState, b: CapturedState): boolean {
  return a.exists === b.exists && a.hash === b.hash;
}

function emptyScope(): ScopeTrack {
  return { files: new Map(), notes: new Set() };
}

export class WorkHistoryJournal {
  private session = emptyScope();
  private interval = emptyScope();
  private readonly contentRefs = new Map<
    string,
    { bytes: number; refs: number }
  >();
  private retainedBytes = 0;
  private storageLimited = false;
  private freezes = 0;
  private readonly limits: WorkHistoryLimits;

  constructor(limits: Partial<WorkHistoryLimits> = {}) {
    this.limits = { ...WORK_HISTORY_LIMITS, ...limits };
  }

  /** Record one verified, committed file edit. No-op edits are ignored. */
  record(edit: CommittedEditRecord): void {
    if (
      !this.session.files.has(edit.fileKey) &&
      this.session.files.size >= this.limits.maxTrackedFiles
    ) {
      this.storageLimited = true;
      return;
    }
    const before = this.capture(edit.before);
    const after = this.capture(edit.after);
    if (sameState(before, after)) {
      this.release(before);
      this.release(after);
      return;
    }
    this.apply(this.session, edit, before, after);
    this.apply(this.interval, edit, before, after);
    // Each scope took its own references; drop the construction references.
    this.release(before);
    this.release(after);
  }

  /** Record that work which AgentLink cannot capture may have changed files. */
  noteActivity(activity: WorkHistoryActivity): void {
    this.session.notes.add(activity);
    this.interval.notes.add(activity);
  }

  get hasSessionChanges(): boolean {
    return this.session.files.size > 0;
  }

  /**
   * Freeze the changes since the previous freeze and the session so far, then
   * start a new interval. Returns undefined when nothing was captured.
   */
  async freeze(
    options: WorkHistoryFreezeOptions,
  ): Promise<WorkSummary | undefined> {
    const interval = this.interval;
    const isFirstFreeze = this.freezes === 0;
    this.freezes += 1;
    this.interval = emptyScope();

    try {
      if (interval.files.size === 0 && this.session.files.size === 0) {
        return undefined;
      }
      const observations = await this.observeFiles(options.observe);
      const extraNotes: WorkSummaryCoverageNote[] = [];
      if (options.captureRestarted) extraNotes.push("capture_restarted");
      if (this.storageLimited) extraNotes.push("storage_limit");

      // After a restart only the first interval can have missed earlier edits;
      // Session so far stays partial for the rest of the host lifetime.
      const sinceSummary = this.buildScope(
        interval,
        observations,
        isFirstFreeze
          ? extraNotes
          : extraNotes.filter((note) => note !== "capture_restarted"),
      );
      this.pruneUnchanged(this.session);
      const sessionSameAsSince = isFirstFreeze;
      const session =
        sessionSameAsSince || this.session.files.size === 0
          ? undefined
          : this.buildScope(this.session, observations, extraNotes);
      if (
        sinceSummary.files.length === 0 &&
        (session?.files.length ?? 0) === 0
      ) {
        return undefined;
      }
      return {
        version: 1,
        id: options.id,
        capturedAt: options.capturedAt,
        sinceSummary,
        ...(session ? { session } : {}),
        ...(sessionSameAsSince ? { sessionSameAsSince: true } : {}),
      };
    } finally {
      this.releaseScope(interval);
    }
  }

  /** Release all retained content. */
  clear(): void {
    this.releaseScope(this.session);
    this.releaseScope(this.interval);
    this.session = emptyScope();
    this.interval = emptyScope();
  }

  private apply(
    scope: ScopeTrack,
    edit: CommittedEditRecord,
    before: CapturedState,
    after: CapturedState,
  ): void {
    let track = scope.files.get(edit.fileKey);
    if (!track) {
      track = {
        fileKey: edit.fileKey,
        absolutePath: edit.absolutePath,
        displayPath: edit.displayPath,
        segments: [],
      };
      scope.files.set(edit.fileKey, track);
    }
    track.displayPath = edit.displayPath;
    const last = track.segments.at(-1);
    this.retain(after);
    if (last && sameState(last.after, before)) {
      // Continuous chain: keep only the boundary states.
      this.release(last.after);
      last.after = after;
      last.edits += 1;
      last.formatted ||= edit.formatted === true;
      return;
    }
    this.retain(before);
    track.segments.push({
      before,
      after,
      edits: 1,
      formatted: edit.formatted === true,
    });
    while (track.segments.length > this.limits.maxSegmentsPerFile) {
      const dropped = track.segments.shift()!;
      this.release(dropped.before);
      this.release(dropped.after);
      this.storageLimited = true;
    }
  }

  /** Forget files whose edits returned them to their starting content. */
  private pruneUnchanged(scope: ScopeTrack): void {
    for (const [key, track] of scope.files) {
      const [only] = track.segments;
      if (track.segments.length === 1 && sameState(only!.before, only!.after)) {
        this.release(only!.before);
        this.release(only!.after);
        scope.files.delete(key);
      }
    }
  }

  private capture(state: WorkHistoryFileState): CapturedState {
    const content = state.exists ? state.content : "";
    const hash = hashWorkHistoryContent(state.exists, content);
    const bytes = Buffer.byteLength(content, "utf8");
    const binary = content.includes("\u0000");
    const tooLarge = bytes > this.limits.maxSnapshotBytes;
    const captured: CapturedState = {
      exists: state.exists,
      hash,
      binary,
      tooLarge,
    };
    if (binary || tooLarge) return captured;
    const existing = this.contentRefs.get(hash);
    if (!existing) {
      if (this.retainedBytes + bytes > this.limits.maxRetainedBytes) {
        this.storageLimited = true;
        return captured;
      }
      this.contentRefs.set(hash, { bytes, refs: 0 });
      this.retainedBytes += bytes;
    }
    captured.content = content;
    this.retain(captured);
    return captured;
  }

  private retain(state: CapturedState): void {
    if (state.content === undefined) return;
    const entry = this.contentRefs.get(state.hash);
    if (entry) entry.refs += 1;
  }

  private release(state: CapturedState): void {
    if (state.content === undefined) return;
    const entry = this.contentRefs.get(state.hash);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.contentRefs.delete(state.hash);
      this.retainedBytes -= entry.bytes;
    }
  }

  private releaseScope(scope: ScopeTrack): void {
    for (const track of scope.files.values()) {
      for (const segment of track.segments) {
        this.release(segment.before);
        this.release(segment.after);
      }
    }
  }

  private async observeFiles(
    observe: WorkHistoryFreezeOptions["observe"],
  ): Promise<Map<string, WorkSummaryDiskCheck>> {
    const result = new Map<string, WorkSummaryDiskCheck>();
    for (const track of this.session.files.values()) {
      const last = track.segments.at(-1);
      if (!last) continue;
      let observation: WorkHistoryDiskObservation;
      try {
        observation = observe ? await observe(track.absolutePath) : undefined;
      } catch {
        observation = undefined;
      }
      if (!observation) {
        result.set(track.fileKey, "not_checked");
      } else if (!observation.exists) {
        result.set(track.fileKey, last.after.exists ? "missing" : "matches");
      } else {
        result.set(
          track.fileKey,
          last.after.exists && observation.hash === last.after.hash
            ? "matches"
            : "changed",
        );
      }
    }
    return result;
  }

  private buildScope(
    scope: ScopeTrack,
    observations: Map<string, WorkSummaryDiskCheck>,
    extraNotes: readonly WorkSummaryCoverageNote[],
  ): WorkSummaryScope {
    const files: WorkSummaryFileChange[] = [];
    let omittedFiles = 0;
    let budget = this.limits.maxDiffBytesPerScope;
    for (const track of scope.files.values()) {
      const first = track.segments[0];
      const last = track.segments.at(-1);
      if (!first || !last) continue;
      // A continuous chain that returned to its starting state has no net change.
      if (track.segments.length === 1 && sameState(first.before, last.after)) {
        continue;
      }
      if (files.length >= this.limits.maxFilesPerScope) {
        omittedFiles += 1;
        continue;
      }
      const segments = track.segments.map((segment) => {
        const diff = this.compare(segment, budget);
        budget -= diff.bytes;
        return diff.diff;
      });
      const operation: WorkSummaryOperation = !first.before.exists
        ? "created"
        : !last.after.exists
          ? "deleted"
          : "modified";
      files.push({
        path: track.displayPath,
        absolutePath: track.absolutePath,
        operation,
        editCount: track.segments.reduce((sum, s) => sum + s.edits, 0),
        segments,
        diskCheck: observations.get(track.fileKey) ?? "not_checked",
      });
    }
    const notes = new Set<WorkSummaryCoverageNote>([
      ...scope.notes,
      ...extraNotes,
    ]);
    return {
      files,
      ...(omittedFiles > 0 ? { omittedFiles } : {}),
      coverageNotes: [...notes],
    };
  }

  private compare(
    segment: Segment,
    budget: number,
  ): { diff: WorkSummaryDiff; bytes: number } {
    const formatted = segment.formatted ? { formatted: true } : {};
    const { before, after } = segment;
    if (before.binary || after.binary) {
      return { diff: { omitted: "binary", ...formatted }, bytes: 0 };
    }
    if (before.tooLarge || after.tooLarge) {
      return { diff: { omitted: "too_large", ...formatted }, bytes: 0 };
    }
    const oldText = before.exists ? before.content : "";
    const newText = after.exists ? after.content : "";
    if (oldText === undefined || newText === undefined) {
      return {
        diff: { omitted: "content_unavailable", ...formatted },
        bytes: 0,
      };
    }
    const patch = diffLib.structuredPatch(
      "a",
      "b",
      oldText,
      newText,
      undefined,
      undefined,
      { context: 3, timeout: this.limits.diffTimeoutMs },
    );
    if (!patch) {
      return { diff: { omitted: "too_large", ...formatted }, bytes: 0 };
    }
    let added = 0;
    let removed = 0;
    let lineCount = 0;
    let bytes = 0;
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        lineCount += 1;
        bytes += line.length + 1;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
    const counts = { added, removed, ...formatted };
    if (
      lineCount > this.limits.maxDiffLinesPerComparison ||
      bytes > this.limits.maxDiffBytesPerComparison
    ) {
      return { diff: { ...counts, omitted: "too_large" }, bytes: 0 };
    }
    if (bytes > budget) {
      return { diff: { ...counts, omitted: "summary_budget" }, bytes: 0 };
    }
    const hunks: WorkSummaryDiffHunk[] = patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...hunk.lines],
    }));
    return { diff: { ...counts, hunks }, bytes };
  }
}

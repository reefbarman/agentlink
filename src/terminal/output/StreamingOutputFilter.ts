import {
  redactCommandOutput,
  type CommandOutputFilterOptions,
  type CommandOutputFilterResult,
} from "@agentlink/core/command-output";

import type {
  StreamedOutputFilterSnapshot,
  StreamedOutputFilterSpec,
} from "../../core/capabilities/terminal.js";
import { cleanTerminalOutput } from "../../util/ansi.js";

/**
 * Streaming retention for caller-requested `output_grep` / `output_head`
 * filters.
 *
 * Raw command output is retained as a bounded tail, so the early lines a
 * caller asked for with `output_grep` or `output_head` can scroll out of
 * retention before the command finishes. This filter runs over the output as
 * it streams and keeps only the bounded candidate lines the final
 * `filterCommandOutput` pass can need, independently of the raw tail.
 *
 * Applying the snapshot reproduces `filterCommandOutput` over the full stream:
 * redact, grep (with context and `--` separators), offset, then head or tail,
 * bounded to the same 64 KiB display limit. Memory stays bounded by that
 * display limit plus one raw line and the grep before-context window.
 */

/** Must match the display bound in `@agentlink/core/command-output`. */
const MAX_FILTERED_OUTPUT_BYTES = 64 * 1024;
/** Longest raw line kept for matching; the rest of the line is discarded. */
const MAX_LINE_CHARS = 64 * 1024;
/** Upper bound on retained grep before-context text. */
const MAX_CONTEXT_CHARS = 64 * 1024;

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

// oxlint-disable-next-line no-control-regex -- terminal control detection
const TERMINAL_CONTROL_RE = /[\x1B\r\x80-\x9F]/;
/**
 * Kubernetes Secret redaction needs whole-document context that line-level
 * streaming cannot provide (`data:` precedes `kind: Secret` in kubectl
 * output). Streamed matches are withheld once a Secret marker appears.
 */
const SENSITIVE_STRUCTURED_OUTPUT_RE = /\bkind\b["']?\s*[:=]\s*["']?Secret\b/i;

// The wire shapes live with the terminal capability contract so terminal
// providers can carry them without depending on this implementation.
export type {
  StreamedOutputFilterSnapshot,
  StreamedOutputFilterSpec,
} from "../../core/capabilities/terminal.js";

export interface StreamedOutputFilterResult extends CommandOutputFilterResult {
  exact: boolean;
  truncatedLines: number;
}

/** Normalize a filter for streaming, or undefined when the raw tail suffices. */
export function streamableOutputFilter(
  options: CommandOutputFilterOptions | undefined,
): StreamedOutputFilterSpec | undefined {
  if (!options) return undefined;
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const grep =
    typeof options.output_grep === "string" ? options.output_grep : undefined;
  const head = count(options.output_head);
  const tail = head === undefined ? count(options.output_tail) : undefined;
  const offset = count(options.output_offset) ?? 0;
  // Without grep or head, only an offset that skips into the start of output
  // needs early lines; tail-only and default filters are served by the tail.
  if (grep === undefined && head === undefined) {
    if (offset === 0 || tail !== undefined) return undefined;
  }
  const spec: StreamedOutputFilterSpec = {};
  if (grep !== undefined) {
    spec.output_grep = grep;
    const context = count(options.output_grep_context) ?? 0;
    if (context > 0) spec.output_grep_context = context;
  }
  if (head !== undefined) spec.output_head = head;
  if (tail !== undefined) spec.output_tail = tail;
  if (offset > 0) spec.output_offset = offset;
  return spec;
}

/** Whether a requested filter selects the same lines as a streamed filter. */
export function sameStreamedOutputFilter(
  requested: CommandOutputFilterOptions | undefined,
  streamed: StreamedOutputFilterSpec,
): boolean {
  const normalized = streamableOutputFilter(requested);
  if (!normalized) return false;
  return (
    normalized.output_grep === streamed.output_grep &&
    normalized.output_grep_context === streamed.output_grep_context &&
    normalized.output_head === streamed.output_head &&
    normalized.output_tail === streamed.output_tail &&
    normalized.output_offset === streamed.output_offset
  );
}

/** Runtime shape check for snapshots that cross provider boundaries. */
export function isStreamedOutputFilterSnapshot(
  value: unknown,
): value is StreamedOutputFilterSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StreamedOutputFilterSnapshot>;
  return (
    !!snapshot.filter &&
    typeof snapshot.filter === "object" &&
    Array.isArray(snapshot.lines) &&
    snapshot.lines.every((line) => typeof line === "string") &&
    typeof snapshot.firstCandidateIndex === "number" &&
    typeof snapshot.candidateLines === "number" &&
    typeof snapshot.totalLines === "number" &&
    typeof snapshot.endsWithNewline === "boolean" &&
    typeof snapshot.exact === "boolean" &&
    typeof snapshot.truncatedLines === "number" &&
    typeof snapshot.sensitive === "boolean"
  );
}

/**
 * Produce the `filterCommandOutput` result for the full stream from a
 * snapshot. Returns undefined for sensitive snapshots.
 */
export function applyStreamedOutputFilter(
  snapshot: StreamedOutputFilterSnapshot,
): StreamedOutputFilterResult | undefined {
  if (snapshot.sensitive) return undefined;
  const { filter } = snapshot;
  // Redaction and grep already ran while streaming. Offset is relative to the
  // retained window; head/tail and the byte bound match filterCommandOutput.
  let lines = snapshot.lines.slice(
    Math.max(0, (filter.output_offset ?? 0) - snapshot.firstCandidateIndex),
  );
  if (filter.output_head !== undefined) {
    lines = lines.slice(0, filter.output_head);
  } else if (filter.output_tail !== undefined) {
    lines = lines.slice(-filter.output_tail);
  }
  const trailingNewline = snapshot.endsWithNewline ? "\n" : "";
  const bounded = boundLines(
    lines,
    filter.output_head === undefined && filter.output_tail !== undefined,
    MAX_FILTERED_OUTPUT_BYTES - trailingNewline.length,
  );
  return {
    filtered:
      bounded.lines.join("\n") +
      (bounded.lines.length > 0 ? trailingNewline : ""),
    totalLines: snapshot.totalLines,
    linesShown: bounded.lines.length,
    truncated: bounded.truncated,
    exact: snapshot.exact,
    truncatedLines: snapshot.truncatedLines,
  };
}

function boundLines(
  lines: string[],
  keepTail: boolean,
  maxBytes: number,
): { lines: string[]; truncated: boolean } {
  const selected = keepTail ? [...lines].reverse() : lines;
  const bounded: string[] = [];
  let bytes = 0;
  for (const line of selected) {
    const cost = (bounded.length > 0 ? 1 : 0) + byteLength(line);
    if (bytes + cost <= maxBytes) {
      bounded.push(line);
      bytes += cost;
      continue;
    }
    if (bounded.length === 0) {
      bounded.push(truncateUtf8(line, maxBytes, keepTail));
    }
    return { lines: keepTail ? bounded.reverse() : bounded, truncated: true };
  }
  return { lines: keepTail ? bounded.reverse() : bounded, truncated: false };
}

function truncateUtf8(value: string, maxBytes: number, keepTail: boolean) {
  const codePoints = keepTail ? [...value].reverse() : [...value];
  const kept: string[] = [];
  let bytes = 0;
  for (const codePoint of codePoints) {
    const codePointBytes = byteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    kept.push(codePoint);
    bytes += codePointBytes;
  }
  return (keepTail ? kept.reverse() : kept).join("");
}

interface ContextLine {
  index: number;
  text: string;
}

export interface StreamingOutputFilterOptions {
  /** Line cleaner; defaults to AgentLink's terminal plain-text cleaning. */
  cleanLine?: (rawLine: string, terminated: boolean) => string;
}

function defaultCleanLine(rawLine: string, terminated: boolean): string {
  if (!TERMINAL_CONTROL_RE.test(rawLine) && terminated) return rawLine;
  // Clean as if the line were inside the whole output so end-of-output
  // trimming only applies to the final unterminated line.
  return terminated
    ? cleanTerminalOutput(`${rawLine}\n`).slice(0, -1)
    : cleanTerminalOutput(rawLine);
}

function compileGrep(pattern: string): RegExp | undefined {
  const normalized = pattern.startsWith("(?i)")
    ? pattern.slice("(?i)".length)
    : pattern;
  if (normalized.length === 0) return undefined;
  try {
    return new RegExp(normalized, "i");
  } catch {
    return new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/**
 * Incremental, memory-bounded implementation of the caller's output filter.
 * Feed raw terminal data with `append`; read with `snapshot`.
 */
export class StreamingOutputFilter {
  readonly filter: StreamedOutputFilterSpec;
  private readonly cleanLine: (rawLine: string, terminated: boolean) => string;
  private readonly regex: RegExp | undefined;
  private readonly context: number;
  private readonly offset: number;

  private pending = "";
  private pendingTruncated = false;
  private lineIndex = 0;
  private endsWithNewline = false;
  private sawOutput = false;

  private contextLines: ContextLine[] = [];
  private contextChars = 0;
  private lastEvictedContextIndex = -1;
  private lastEmittedIndex = -1;
  private afterRemaining = 0;

  private retained: string[] = [];
  private retainedCosts: number[] = [];
  private retainedBytes = 0;
  private firstCandidateIndex: number;
  private candidateLines = 0;
  private exact = true;
  private truncatedLines = 0;
  private sensitive = false;

  constructor(
    filter: StreamedOutputFilterSpec,
    options: StreamingOutputFilterOptions = {},
  ) {
    this.filter = { ...filter };
    this.cleanLine = options.cleanLine ?? defaultCleanLine;
    this.regex =
      filter.output_grep === undefined
        ? undefined
        : compileGrep(filter.output_grep);
    this.context =
      filter.output_grep === undefined ? 0 : (filter.output_grep_context ?? 0);
    this.offset = filter.output_offset ?? 0;
    this.firstCandidateIndex = this.offset;
  }

  append(data: string): void {
    if (this.sensitive || data.length === 0) return;
    this.sawOutput = true;
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf("\n", start);
      const end = newline === -1 ? data.length : newline;
      this.appendPending(data.slice(start, end));
      if (newline === -1) {
        this.endsWithNewline = false;
        return;
      }
      this.endsWithNewline = true;
      this.flushLine(true);
      if (this.sensitive) return;
      start = newline + 1;
    }
  }

  /**
   * Snapshot the filter state. An unterminated final line is evaluated
   * without consuming it, so later output can still extend that line.
   */
  snapshot(): StreamedOutputFilterSnapshot {
    if (this.pending.length > 0 && !this.sensitive) {
      const copy = this.clone();
      copy.flushLine(false);
      return copy.ownSnapshot();
    }
    return this.ownSnapshot();
  }

  private ownSnapshot(): StreamedOutputFilterSnapshot {
    return {
      filter: { ...this.filter },
      lines: this.sensitive ? [] : [...this.retained],
      firstCandidateIndex: this.firstCandidateIndex,
      candidateLines: this.candidateLines,
      totalLines: this.sawOutput ? this.lineIndex : 0,
      endsWithNewline: this.endsWithNewline,
      exact: this.exact,
      truncatedLines: this.truncatedLines,
      sensitive: this.sensitive,
    };
  }

  private clone(): StreamingOutputFilter {
    const copy = new StreamingOutputFilter(this.filter, {
      cleanLine: this.cleanLine,
    });
    copy.pending = this.pending;
    copy.pendingTruncated = this.pendingTruncated;
    copy.lineIndex = this.lineIndex;
    copy.endsWithNewline = this.endsWithNewline;
    copy.sawOutput = this.sawOutput;
    copy.contextLines = [...this.contextLines];
    copy.contextChars = this.contextChars;
    copy.lastEvictedContextIndex = this.lastEvictedContextIndex;
    copy.lastEmittedIndex = this.lastEmittedIndex;
    copy.afterRemaining = this.afterRemaining;
    copy.retained = [...this.retained];
    copy.retainedCosts = [...this.retainedCosts];
    copy.retainedBytes = this.retainedBytes;
    copy.firstCandidateIndex = this.firstCandidateIndex;
    copy.candidateLines = this.candidateLines;
    copy.exact = this.exact;
    copy.truncatedLines = this.truncatedLines;
    copy.sensitive = this.sensitive;
    return copy;
  }

  private appendPending(segment: string): void {
    if (this.pendingTruncated || segment.length === 0) return;
    const room = MAX_LINE_CHARS - this.pending.length;
    if (segment.length <= room) {
      this.pending += segment;
      return;
    }
    this.pending += segment.slice(0, room);
    this.pendingTruncated = true;
  }

  private flushLine(terminated: boolean): void {
    const raw = this.pending;
    const truncated = this.pendingTruncated;
    this.pending = "";
    this.pendingTruncated = false;
    const index = this.lineIndex++;
    if (truncated) this.truncatedLines++;

    const text = redactCommandOutput(this.cleanLine(raw, terminated));
    if (SENSITIVE_STRUCTURED_OUTPUT_RE.test(text)) {
      this.markSensitive();
      return;
    }

    if (this.filter.output_grep === undefined) {
      this.emit(index, text, truncated);
      return;
    }
    const matched = this.regex?.test(text) ?? false;
    if (this.context === 0) {
      if (matched) this.emit(index, text, truncated);
      return;
    }
    if (matched) {
      const start = Math.max(this.lastEmittedIndex + 1, index - this.context);
      if (start <= this.lastEvictedContextIndex) this.exact = false;
      for (const line of this.contextLines) {
        if (line.index >= start) this.emit(line.index, line.text, false);
      }
      this.contextLines = [];
      this.contextChars = 0;
      this.emit(index, text, truncated);
      this.afterRemaining = this.context;
      return;
    }
    if (this.afterRemaining > 0) {
      this.afterRemaining--;
      this.emit(index, text, truncated);
      return;
    }
    this.contextLines.push({ index, text });
    this.contextChars += text.length;
    while (
      this.contextLines.length > this.context ||
      (this.contextChars > MAX_CONTEXT_CHARS && this.contextLines.length > 1)
    ) {
      const evicted = this.contextLines.shift()!;
      this.contextChars -= evicted.text.length;
      if (this.contextLines.length >= this.context) continue;
      this.lastEvictedContextIndex = evicted.index;
    }
  }

  private emit(index: number, text: string, truncated: boolean): void {
    if (
      this.context > 0 &&
      this.lastEmittedIndex !== -1 &&
      index !== this.lastEmittedIndex + 1
    ) {
      this.retainCandidate("--", false);
    }
    this.lastEmittedIndex = index;
    this.retainCandidate(text, truncated);
  }

  private retainCandidate(text: string, truncated: boolean): void {
    const candidate = this.candidateLines++;
    if (candidate < this.offset) return;
    const { output_head: head, output_tail: tail } = this.filter;
    if (tail === undefined) {
      // Head-first selection: the display bound is head-first, so once the
      // retained lines exceed it no later candidate can be shown.
      if (head !== undefined && candidate - this.offset >= head) return;
      // Joined bytes are costs minus one separator; keep one overflowing line
      // so the display bound still reports truncation.
      if (this.retainedBytes - 1 > MAX_FILTERED_OUTPUT_BYTES) return;
      this.push(text, truncated);
      return;
    }
    // Tail selection keeps the newest candidates within count and bytes.
    this.push(text, truncated);
    while (
      this.retained.length > tail ||
      (this.retained.length > 1 &&
        this.retainedBytes - this.retainedCosts[0]! - 1 >
          MAX_FILTERED_OUTPUT_BYTES)
    ) {
      this.retained.shift();
      this.retainedBytes -= this.retainedCosts.shift()!;
      this.firstCandidateIndex++;
    }
  }

  private push(text: string, truncated: boolean): void {
    if (truncated) this.exact = false;
    const cost = byteLength(text) + 1;
    this.retained.push(text);
    this.retainedCosts.push(cost);
    this.retainedBytes += cost;
  }

  private markSensitive(): void {
    this.sensitive = true;
    this.pending = "";
    this.contextLines = [];
    this.contextChars = 0;
    this.retained = [];
    this.retainedCosts = [];
    this.retainedBytes = 0;
  }
}

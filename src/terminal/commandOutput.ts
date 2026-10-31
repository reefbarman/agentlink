import type { CommandOutputFilterOptions } from "@agentlink/core/command-output";

import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import {
  applyStreamedOutputFilter,
  isStreamedOutputFilterSnapshot,
  sameStreamedOutputFilter,
  streamableOutputFilter,
  type StreamedOutputFilterSnapshot,
} from "./output/StreamingOutputFilter.js";

/**
 * Field on retained terminal output that carries streamed caller-filter
 * matches (see StreamingOutputFilter). Read through
 * `readStreamedOutputFilter` so providers without streaming stay compatible.
 */
export const STREAMED_OUTPUT_FILTER_FIELD = "streamed_filter";

export const STILL_RUNNING_OUTPUT_WARNING =
  "Terminal output is still running or was closed before finalization. Filtering applies to retained output so far; no final output file is available.";

const PREVIEW_CAP_OUTPUT_WARNING =
  "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";

export interface CommandOutputPresentationInput {
  /** Retained (possibly tail-only) cleaned output. */
  output: string;
  complete: boolean;
  finalized: boolean;
  droppedBytes?: number;
  filter: CommandOutputFilterOptions;
  /** Streamed caller-filter matches retained independently of the raw tail. */
  streamed?: StreamedOutputFilterSnapshot;
}

export interface CommandOutputPresentation {
  output: string;
  total_lines: number;
  lines_shown: number;
  output_truncated: boolean;
  /**
   * `complete`: counts cover all output. `retained`: counts cover only the
   * retained output. `observed`: streamed counts cover all output so far.
   */
  total_lines_scope: "complete" | "retained" | "observed";
  /** Set when lines came from the streamed filter rather than the raw tail. */
  output_filter_source?: "streamed";
  output_file?: string;
  /** Output was lost, capped, or is still incomplete. */
  output_warning?: string;
  /** The caller's own filter reduced the display; nothing was lost. */
  output_note?: string;
}

/** The output filter fields of a tool request. */
export function outputFilterFromParams(params: {
  output_head?: number;
  output_tail?: number;
  output_offset?: number;
  output_grep?: string;
  output_grep_context?: number;
}): CommandOutputFilterOptions {
  return {
    output_head: params.output_head,
    output_tail: params.output_tail,
    output_offset: params.output_offset,
    output_grep: params.output_grep,
    output_grep_context: params.output_grep_context,
  };
}

/** Whether streamed matches could serve this filter after raw-output loss. */
export function isStreamableFilter(
  filter: CommandOutputFilterOptions,
): boolean {
  return streamableOutputFilter(filter) !== undefined;
}

/** Read a streamed filter snapshot from retained output, if one is present. */
export function readStreamedOutputFilter(
  retained: unknown,
): StreamedOutputFilterSnapshot | undefined {
  if (!retained || typeof retained !== "object") return undefined;
  const value = (retained as Record<string, unknown>)[
    STREAMED_OUTPUT_FILTER_FIELD
  ];
  return isStreamedOutputFilterSnapshot(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function hasExplicitFilter(filter: CommandOutputFilterOptions): boolean {
  return (
    filter.output_head !== undefined ||
    filter.output_tail !== undefined ||
    filter.output_offset !== undefined ||
    filter.output_grep !== undefined
  );
}

/**
 * Apply the caller's output filter and describe the result honestly.
 *
 * - Raw output lost, streamed matches available for this filter: present the
 *   streamed lines and report the raw loss.
 * - Still running or raw output lost: filter the retained output and warn.
 * - Display capped by the default preview or the byte bound: save the full
 *   output and warn strongly.
 * - Display reduced only by the caller's own filter: save the full output
 *   and add a neutral note.
 */
export function presentCommandOutput(
  input: CommandOutputPresentationInput,
): CommandOutputPresentation {
  const rawLost =
    input.droppedBytes !== undefined
      ? input.droppedBytes > 0
      : input.finalized && !input.complete;
  const lostDescription =
    input.droppedBytes === undefined
      ? "Some output"
      : formatBytes(input.droppedBytes);
  const streamed = input.streamed;
  const streamedMatchesFilter =
    streamed !== undefined &&
    !streamed.sensitive &&
    sameStreamedOutputFilter(input.filter, streamed.filter);

  if (rawLost && streamed && streamedMatchesFilter) {
    const applied = applyStreamedOutputFilter(streamed);
    if (applied) {
      const caveats = [
        ...(applied.exact
          ? []
          : [
              "Some matching lines or grep context exceeded the streaming retention bounds, so this selection may be incomplete.",
            ]),
        ...(applied.truncatedLines > 0
          ? [
              `${applied.truncatedLines} very long line(s) were matched only on their first 64K characters.`,
            ]
          : []),
        ...(applied.truncated
          ? ["The selected lines exceeded the 64 KiB display limit."]
          : []),
      ];
      const scope = input.finalized
        ? `⚠️ Terminal output exceeded the bounded capture limit. ${lostDescription} of raw output was not retained and no full-output file is available. Your output filter ran on the complete output stream, so these lines come from the full output, not only the retained tail.`
        : `⚠️ Terminal output is still running and has exceeded the bounded capture limit. ${lostDescription} of raw output was not retained and no final output file is available. Your output filter is running on the live output stream, so these lines cover all output so far, not only the retained tail.`;
      return {
        output: applied.filtered,
        total_lines: applied.totalLines,
        lines_shown: applied.linesShown,
        output_truncated: applied.truncated,
        total_lines_scope: input.finalized ? "complete" : "observed",
        output_filter_source: "streamed",
        output_warning: [scope, ...caveats].join(" "),
      };
    }
  }

  const { filtered, totalLines, linesShown, truncated } = filterOutput(
    input.output,
    input.filter,
  );
  const presentation: CommandOutputPresentation = {
    output: filtered,
    total_lines: totalLines,
    lines_shown: linesShown,
    output_truncated: truncated,
    total_lines_scope:
      input.finalized && input.complete ? "complete" : "retained",
  };

  if (!input.finalized) {
    presentation.output_warning = STILL_RUNNING_OUTPUT_WARNING;
  } else if (!input.complete) {
    const streamedHint =
      streamed && !streamed.sensitive && !streamedMatchesFilter
        ? " Matches were streamed for the output filter requested when the command started; repeat that exact filter to read them."
        : "";
    presentation.output_warning = `⚠️ Terminal output exceeded the bounded capture limit. ${lostDescription} was not retained; filtering applies only to the retained tail and no full-output file is available.${streamedHint}`;
  } else if (truncated || linesShown < totalLines) {
    const outputFile = saveOutputTempFile(input.output);
    if (outputFile) presentation.output_file = outputFile;
    if (truncated || !hasExplicitFilter(input.filter)) {
      if (outputFile) presentation.output_warning = PREVIEW_CAP_OUTPUT_WARNING;
    } else {
      presentation.output_note = `Showing ${linesShown} of ${totalLines} lines selected by your output filter; no output was lost.${outputFile ? " The complete output is in output_file if you need lines outside the filter." : ""}`;
    }
  }
  return presentation;
}

import type { TerminalProvider } from "../core/capabilities/terminal.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { sleep } from "../util/sleep.js";

import { type ToolResult } from "../shared/types.js";

const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
  /\b(y\/n|yes\/no|press\s+(enter|return)|continue\?|are you sure)\b/i,
  /\b(choose|select)\b.*\b(option|number)\b/i,
  /\b(waiting\s+for\s+(input|confirmation)|enter\s+(?:yes|no|y|n))\b/i,
  // Known prompt text emitted by codegen workflows that pause for confirmation.
  /\bcustom code preservation\b/i,
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function detectPromptBlock(output: string): {
  blocked_on_prompt: boolean;
  matched_pattern?: string;
} {
  const trimmed = output.trim();
  if (!trimmed) {
    return { blocked_on_prompt: false };
  }

  const tail = trimmed.slice(Math.max(0, trimmed.length - 4000));
  const nonEmptyLines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentTail = nonEmptyLines.slice(-6).join("\n");

  for (const pattern of INTERACTIVE_PROMPT_PATTERNS) {
    if (pattern.test(recentTail)) {
      return {
        blocked_on_prompt: true,
        matched_pattern: pattern.source,
      };
    }
  }
  return { blocked_on_prompt: false };
}

export interface GetTerminalOutputProviders {
  terminalProvider?: TerminalProvider;
}

function unavailableTerminalOutputResult(params: {
  terminal_id: string;
}): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Terminal output is unavailable in this runtime. Provide a TerminalProvider to enable get_terminal_output.",
          terminal_id: params.terminal_id,
        }),
      },
    ],
  };
}

export async function handleGetTerminalOutput(
  params: {
    terminal_id: string;
    wait_seconds?: number;
    kill?: boolean;
    output_head?: number;
    output_tail?: number;
    output_offset?: number;
    output_grep?: string;
    output_grep_context?: number;
  },
  providers: GetTerminalOutputProviders = {},
): Promise<ToolResult> {
  if (!providers.terminalProvider) {
    return unavailableTerminalOutputResult(params);
  }
  const terminalProvider = providers.terminalProvider;
  const log = terminalProvider.log;
  const startTime = Date.now();

  log?.(
    `[get_terminal_output] ENTER terminal_id=${params.terminal_id} wait_seconds=${params.wait_seconds ?? "none"}`,
  );

  // If wait_seconds is specified, poll until the command finishes or the wait
  // time expires.  We intentionally do NOT break on "new output" — for
  // continuously-producing commands that would exit after ~250ms, making
  // wait_seconds effectively useless.
  if (params.wait_seconds && params.wait_seconds > 0) {
    const deadline = Date.now() + params.wait_seconds * 1000;
    const initialState = terminalProvider.getBackgroundState(
      params.terminal_id,
    );

    log?.(
      `[get_terminal_output] POLL_START is_running=${initialState?.is_running ?? "unknown"}`,
    );

    while (Date.now() < deadline) {
      const current = terminalProvider.getBackgroundState(params.terminal_id);
      if (!current) break;

      // Stop waiting only when the command has finished
      if (!current.is_running) break;

      await sleep(Math.min(250, deadline - Date.now()));
    }

    log?.(`[get_terminal_output] POLL_END elapsed=${Date.now() - startTime}ms`);
  }

  // Kill the running process if requested
  if (params.kill) {
    log?.(`[get_terminal_output] KILL terminal_id=${params.terminal_id}`);
    terminalProvider.interruptTerminal(params.terminal_id);
    // Brief wait for the process to respond to SIGINT
    await sleep(500);
  }

  let state = terminalProvider.getBackgroundState(params.terminal_id);
  const recentlyClosed = state
    ? []
    : terminalProvider.getRecentlyClosedTerminals(20);
  const closedState = recentlyClosed.find(
    (terminal) => terminal.id === params.terminal_id,
  );
  state ??= closedState;

  if (!state) {
    const recent = recentlyClosed.slice(0, 5).map((terminal) => ({
      terminal_id: terminal.id,
      terminal_name: terminal.name,
      closed_at: new Date(terminal.closedAt).toISOString(),
      state: terminal.state,
      exit_code: terminal.exit_code,
      output_captured: terminal.output_captured,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Terminal "${params.terminal_id}" not found. It may have been closed.`,
            ...(recent.length > 0 && { recently_closed_terminals: recent }),
            hint: "Use execute_command with terminal_name for long-running workflows so you can recover by name if terminal_id changes.",
          }),
        },
      ],
    };
  }

  const retainedOutput = terminalProvider.getRetainedOutput?.(
    params.terminal_id,
  );
  const output = retainedOutput?.output ?? state.output;
  const outputComplete =
    retainedOutput?.complete ?? state.output_complete ?? true;
  const outputFinalized =
    retainedOutput?.finalized ?? state.output_finalized ?? !state.is_running;
  const result: Record<string, unknown> = {
    terminal_id: params.terminal_id,
    is_running: state.is_running,
    state: state.state,
    exit_code: state.exit_code,
    output_captured: state.output_captured,
    output_complete: outputComplete,
    output_finalized: outputFinalized,
    ...(retainedOutput
      ? {
          output_total_bytes: retainedOutput.total_bytes,
          output_retained_bytes: retainedOutput.retained_bytes,
          output_dropped_bytes: retainedOutput.dropped_bytes,
        }
      : state.output_total_bytes !== undefined
        ? {
            output_total_bytes: state.output_total_bytes,
            output_retained_bytes: state.output_retained_bytes,
            output_dropped_bytes: state.output_dropped_bytes,
          }
        : {}),
    ...(closedState
      ? {
          terminal_name: closedState.name,
          closed_at: new Date(closedState.closedAt).toISOString(),
          recently_closed: true,
        }
      : {}),
    ...(params.kill && { killed: true }),
  };

  if (state.is_running && state.output_captured) {
    const promptState = detectPromptBlock(state.output);
    if (promptState.blocked_on_prompt) {
      result.blocked_on_prompt = true;
      result.prompt_detection = "heuristic";
      if (promptState.matched_pattern) {
        result.prompt_pattern = promptState.matched_pattern;
      }
      result.prompt_hint =
        "The command appears to be waiting for interactive input. Use terminal_id with get_terminal_output(kill: true) to stop it, or open the terminal UI and answer the prompt.";
    }
  }

  if (state.output_captured && output) {
    const filterOptions = {
      output_head: params.output_head,
      output_tail: params.output_tail,
      output_offset: params.output_offset,
      output_grep: params.output_grep,
      output_grep_context: params.output_grep_context,
    };
    const { filtered, totalLines, linesShown } = filterOutput(
      output,
      filterOptions,
    );

    result.output = filtered;
    result.total_lines = totalLines;
    result.lines_shown = linesShown;
    result.total_lines_scope = outputComplete ? "complete" : "retained";

    if (!outputFinalized) {
      result.output_warning =
        "Terminal output is still running or was closed before finalization. Filtering applies to retained output so far; no final output file is available.";
    } else if (!outputComplete) {
      const droppedBytes =
        retainedOutput?.dropped_bytes ?? state.output_dropped_bytes;
      result.output_warning = `⚠️ Terminal output exceeded the bounded capture limit. ${droppedBytes === undefined ? "Some output" : formatBytes(droppedBytes)} was not retained; filtering applies only to the retained tail and no full-output file is available.`;
    } else if (linesShown < totalLines) {
      const outputFile = saveOutputTempFile(output);
      if (outputFile) {
        result.output_file = outputFile;
        result.output_warning =
          "⚠️ Output was truncated. Full output saved to output_file — use read_file(output_file) to access it. Do NOT re-run this command.";
      }
    }
  } else if (!state.output_captured) {
    result.output =
      "Output capture unavailable — shell integration was not active when the background command started.";
    result.verification_hint =
      `The command was started in terminal_id "${params.terminal_id}" without shell integration capture. ` +
      "Use the visible terminal to inspect progress or completion rather than re-running it.";
  } else {
    result.output = "";
  }

  log?.(
    `[get_terminal_output] EXIT elapsed=${Date.now() - startTime}ms terminal_id=${params.terminal_id}`,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

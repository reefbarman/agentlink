import type { TerminalProvider } from "../core/capabilities/terminal.js";
import { type ToolResult } from "../shared/types.js";
import { detectInteractivePrompt } from "../terminal/interactivePromptDetector.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";
import { sleep } from "../util/sleep.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export interface GetTerminalOutputProviders {
  terminalProvider?: TerminalProvider;
  /** Resolves when a user message arrives while the tool is polling. */
  waitForPendingInterjection?: (timeoutMs: number) => Promise<boolean>;
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
  let waitInterrupted = false;

  log?.(
    `[get_terminal_output] ENTER terminal_id=${params.terminal_id} wait_seconds=${params.wait_seconds ?? "none"}`,
  );

  // If wait_seconds is specified, poll until the command finishes, a user
  // message arrives, or the wait time expires. We intentionally do NOT break
  // on new output — for continuously-producing commands that would exit after
  // ~250ms, making wait_seconds effectively useless.
  if (params.wait_seconds && params.wait_seconds > 0) {
    const deadline = Date.now() + params.wait_seconds * 1000;
    const initialState = terminalProvider.getBackgroundState({
      owner: undefined,
      terminalId: params.terminal_id,
    });

    log?.(
      `[get_terminal_output] POLL_START is_running=${initialState?.is_running ?? "unknown"}`,
    );

    while (Date.now() < deadline) {
      const current = terminalProvider.getBackgroundState({
        owner: undefined,
        terminalId: params.terminal_id,
      });
      if (!current) break;

      // Stop waiting only when the command has finished
      if (!current.is_running) break;

      const pollDelay = Math.min(250, deadline - Date.now());
      const waitStartedAt = Date.now();
      const pendingInterjection = providers.waitForPendingInterjection
        ? await providers.waitForPendingInterjection(pollDelay)
        : false;
      if (!pendingInterjection) {
        await sleep(Math.max(0, pollDelay - (Date.now() - waitStartedAt)));
      }
      if (pendingInterjection) {
        waitInterrupted = true;
        break;
      }
    }

    log?.(
      `[get_terminal_output] POLL_END elapsed=${Date.now() - startTime}ms interrupted=${waitInterrupted}`,
    );
  }

  // Kill the running process if requested
  if (params.kill) {
    log?.(`[get_terminal_output] KILL terminal_id=${params.terminal_id}`);
    terminalProvider.interruptTerminal({
      owner: undefined,
      terminalId: params.terminal_id,
    });
    // Brief wait for the process to respond to SIGINT
    await sleep(500);
  }

  let state = terminalProvider.getBackgroundState({
    owner: undefined,
    terminalId: params.terminal_id,
  });
  const recentlyClosed = state
    ? []
    : terminalProvider.getRecentlyClosedTerminals({
        owner: undefined,
        limit: 20,
      });
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

  const retainedOutput = terminalProvider.getRetainedOutput?.({
    owner: undefined,
    terminalId: params.terminal_id,
  });
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
    ...(state.termination_reason
      ? { termination_reason: state.termination_reason }
      : {}),
    ...(state.interactive_prompt
      ? { interactive_prompt: { ...state.interactive_prompt } }
      : {}),
    ...(params.kill && { killed: true }),
    ...(waitInterrupted &&
      state.is_running &&
      !params.kill && {
        status: "wait_interrupted",
        reason: "user_message_pending",
        retrySafe: true,
        message:
          "Waiting stopped because a user message is pending for your session. The terminal command was not interrupted and may still be running. Handle the user's message first, then call get_terminal_output again when ready to wait.",
      }),
  };

  if (state.is_running && state.output_captured) {
    const prompt = detectInteractivePrompt(output);
    if (prompt) {
      result.blocked_on_prompt = true;
      result.prompt_detection = "observation_only";
      result.interactive_prompt = prompt;
      result.prompt_hint =
        "The background command may be waiting for interactive input. get_terminal_output only observes background commands; use kill: true to stop it, or open the terminal UI and answer the prompt.";
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
    const { filtered, totalLines, linesShown, truncated } = filterOutput(
      output,
      filterOptions,
    );

    result.output = filtered;
    result.total_lines = totalLines;
    result.lines_shown = linesShown;
    result.output_truncated = truncated;
    result.total_lines_scope = outputComplete ? "complete" : "retained";

    if (!outputFinalized) {
      result.output_warning =
        "Terminal output is still running or was closed before finalization. Filtering applies to retained output so far; no final output file is available.";
    } else if (!outputComplete) {
      const droppedBytes =
        retainedOutput?.dropped_bytes ?? state.output_dropped_bytes;
      result.output_warning = `⚠️ Terminal output exceeded the bounded capture limit. ${droppedBytes === undefined ? "Some output" : formatBytes(droppedBytes)} was not retained; filtering applies only to the retained tail and no full-output file is available.`;
    } else if (truncated || linesShown < totalLines) {
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

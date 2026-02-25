import { getTerminalManager } from "../integrations/TerminalManager.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleGetTerminalOutput(params: {
  terminal_id: string;
  wait_seconds?: number;
  output_head?: number;
  output_tail?: number;
  output_offset?: number;
  output_grep?: string;
  output_grep_context?: number;
}): Promise<ToolResult> {
  const terminalManager = getTerminalManager();

  // If wait_seconds is specified, poll until new output arrives, command finishes,
  // or the wait time expires.
  if (params.wait_seconds && params.wait_seconds > 0) {
    const deadline = Date.now() + params.wait_seconds * 1000;
    const initialState = terminalManager.getBackgroundState(params.terminal_id);
    const initialLength = initialState?.output?.length ?? 0;
    const initialRunning = initialState?.is_running ?? false;

    while (Date.now() < deadline) {
      const current = terminalManager.getBackgroundState(params.terminal_id);
      if (!current) break;

      // Stop waiting if: command finished, or new output appeared
      const hasNewOutput = (current.output?.length ?? 0) > initialLength;
      const finished = !current.is_running && initialRunning;
      if (hasNewOutput || finished) break;

      await sleep(Math.min(250, deadline - Date.now()));
    }
  }

  const state = terminalManager.getBackgroundState(params.terminal_id);

  if (!state) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Terminal "${params.terminal_id}" not found. It may have been closed.`,
          }),
        },
      ],
    };
  }

  const result: Record<string, unknown> = {
    terminal_id: params.terminal_id,
    is_running: state.is_running,
    exit_code: state.exit_code,
    output_captured: state.output_captured,
  };

  if (state.output_captured && state.output) {
    const { filtered, totalLines, linesShown } = filterOutput(state.output, {
      output_head: params.output_head,
      output_tail: params.output_tail,
      output_offset: params.output_offset,
      output_grep: params.output_grep,
      output_grep_context: params.output_grep_context,
    });

    result.output = filtered;
    result.total_lines = totalLines;
    result.lines_shown = linesShown;

    if (linesShown < totalLines) {
      const outputFile = saveOutputTempFile(state.output);
      if (outputFile) {
        result.output_file = outputFile;
      }
    }
  } else if (!state.output_captured) {
    result.output =
      "Output capture unavailable — shell integration was not active when the background command started.";
  } else {
    result.output = "";
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

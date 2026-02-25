import { getTerminalManager } from "../integrations/TerminalManager.js";
import { filterOutput, saveOutputTempFile } from "../util/outputFilter.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleGetTerminalOutput(params: {
  terminal_id: string;
  output_head?: number;
  output_tail?: number;
  output_offset?: number;
  output_grep?: string;
  output_grep_context?: number;
}): Promise<ToolResult> {
  const terminalManager = getTerminalManager();
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

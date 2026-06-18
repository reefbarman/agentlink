import type { TerminalProvider } from "../core/capabilities/terminal.js";
import { type ToolResult } from "../shared/types.js";

export interface CloseTerminalsProviders {
  terminalProvider?: TerminalProvider;
}

function unavailableCloseTerminalsResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error:
            "Terminal management is unavailable in this runtime. Provide a TerminalProvider to enable close_terminals.",
        }),
      },
    ],
  };
}

export async function handleCloseTerminals(
  params: { names?: string[] },
  providers: CloseTerminalsProviders = {},
): Promise<ToolResult> {
  if (!providers.terminalProvider) {
    return unavailableCloseTerminalsResult();
  }
  const terminalProvider = providers.terminalProvider;

  const before = terminalProvider.listTerminals();
  if (before.length === 0) {
    return {
      content: [{ type: "text", text: "No managed terminals to close." }],
    };
  }

  const result = terminalProvider.closeTerminals(
    params.names && params.names.length > 0 ? params.names : undefined,
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          closed: result.closed,
          ...(result.not_found && { not_found: result.not_found }),
          remaining: terminalProvider.listTerminals(),
        }),
      },
    ],
  };
}

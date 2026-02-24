import { getTerminalManager } from "../integrations/TerminalManager.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleCloseTerminals(params: {
  names?: string[];
}): Promise<ToolResult> {
  const tm = getTerminalManager();

  const before = tm.listTerminals();
  if (before.length === 0) {
    return {
      content: [{ type: "text", text: "No managed terminals to close." }],
    };
  }

  const closed = tm.closeTerminals(
    params.names && params.names.length > 0 ? params.names : undefined,
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ closed, remaining: tm.listTerminals() }),
      },
    ],
  };
}

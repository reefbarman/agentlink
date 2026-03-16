import { handleExecuteCommand } from "../../tools/executeCommand.js";
import { handleGetTerminalOutput } from "../../tools/getTerminalOutput.js";
import { handleCloseTerminals } from "../../tools/closeTerminals.js";
import {
  executeCommandSchema,
  getTerminalOutputSchema,
  closeTerminalsSchema,
} from "../../shared/toolSchemas.js";
import type { ToolRegistrationContext } from "./types.js";

export function registerTerminalTools(ctx: ToolRegistrationContext): void {
  const { server, tracker, approvalManager, approvalPanel, sid, touch, desc } =
    ctx;

  server.registerTool(
    "execute_command",
    {
      description: desc("execute_command"),
      inputSchema: executeCommandSchema,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    tracker.wrapHandler(
      "execute_command",
      (params, ctx) => {
        touch();
        return handleExecuteCommand(
          params,
          approvalManager,
          approvalPanel,
          sid(),
          ctx,
        );
      },
      (p) => String(p.command ?? "").slice(0, 80),
      sid,
    ),
  );

  server.registerTool(
    "close_terminals",
    {
      description: desc("close_terminals"),
      inputSchema: closeTerminalsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    tracker.wrapHandler(
      "close_terminals",
      (params) => {
        touch();
        return handleCloseTerminals(params);
      },
      (p) =>
        Array.isArray(p.names) ? (p.names as string[]).join(", ") : "all",
      sid,
    ),
  );

  server.registerTool(
    "get_terminal_output",
    {
      description: desc("get_terminal_output"),
      inputSchema: getTerminalOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    tracker.wrapHandler(
      "get_terminal_output",
      (params) => {
        touch();
        return handleGetTerminalOutput(params);
      },
      (p) => String(p.terminal_id ?? ""),
      sid,
    ),
  );
}

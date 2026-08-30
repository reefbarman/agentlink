import type { TerminalProvider } from "../core/capabilities/terminal.js";
import type { TrackedCall } from "./AgentToolCallTracker.js";
import {
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import { handleGetTerminalOutput } from "../tools/getTerminalOutput.js";

interface AgentToolCompletionRequest {
  call: TrackedCall;
  log: (message: string) => void;
  terminalProvider?: TerminalProvider;
  status: "force-completed" | "continued-in-background" | undefined;
}

export type AgentToolCompletionStrategy = (
  request: AgentToolCompletionRequest,
) => Promise<void>;

const completeExecuteCommand: AgentToolCompletionStrategy = async ({
  call,
  log,
  terminalProvider,
}) => {
  log(
    `COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`,
  );
  let partialOutput = "";
  if (call.terminalId) {
    partialOutput =
      terminalProvider?.getCurrentOutput?.({
        owner: undefined,
        terminalId: call.terminalId,
        force: true,
      }) ??
      terminalProvider?.getBackgroundState({
        owner: undefined,
        terminalId: call.terminalId,
      })?.output ??
      "";
    log(`COMPLETE_EXEC output captured: ${partialOutput.length} chars`);
  }

  if (call.terminalId) {
    log(`COMPLETE_EXEC interrupting terminal ${call.terminalId}`);
    terminalProvider?.interruptTerminal({
      owner: undefined,
      terminalId: call.terminalId,
    });
  }

  call.forceResolve(
    successResult({
      exit_code: null,
      output: partialOutput || "[No output captured]",
      output_captured: !!partialOutput,
      terminal_id: call.terminalId ?? null,
      status: "force-completed",
      message: "Command force-completed by user. Process was interrupted.",
    }),
  );
};

function parseTerminalOutputParams(call: TrackedCall): Record<string, unknown> {
  try {
    const parsed = call.params ? JSON.parse(call.params) : undefined;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function addCompletionStatus(
  result: ToolResult,
  status: "force-completed" | "continued-in-background",
): ToolResult {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (!text) return result;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    payload.status = status;
    payload.message =
      status === "continued-in-background"
        ? "Returned control to the agent without interrupting the terminal command. Use get_terminal_output when ready to inspect or wait again."
        : "Output returned immediately — wait was interrupted by user.";
    return successResult(payload);
  } catch {
    return result;
  }
}

const completeGetTerminalOutput: AgentToolCompletionStrategy = async ({
  call,
  log,
  terminalProvider,
  status = "force-completed",
}) => {
  const terminalId = call.terminalId ?? call.displayArgs;
  log(
    `COMPLETE_GET_OUTPUT ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${terminalId}`,
  );
  if (!terminalProvider) {
    call.forceResolve(
      successResult({
        error: "Terminal output is unavailable in this runtime.",
        terminal_id: terminalId,
      }),
    );
    return;
  }

  const params = parseTerminalOutputParams(call);
  const result = await handleGetTerminalOutput(
    {
      terminal_id: terminalId,
      output_head:
        typeof params.output_head === "number" ? params.output_head : undefined,
      output_tail:
        typeof params.output_tail === "number" ? params.output_tail : undefined,
      output_offset:
        typeof params.output_offset === "number"
          ? params.output_offset
          : undefined,
      output_grep:
        typeof params.output_grep === "string" ? params.output_grep : undefined,
      output_grep_context:
        typeof params.output_grep_context === "number"
          ? params.output_grep_context
          : undefined,
    },
    {
      terminalProvider,
      allowDirectOutputFallback: true,
    },
  );
  call.forceResolve(addCompletionStatus(result, status));
};

const completeWriteTool: AgentToolCompletionStrategy = async ({
  call,
  log,
}) => {
  log(`COMPLETE_WRITE ${call.toolName} (${call.id.slice(0, 8)})`);
  const { resolveCurrentDiff } =
    await import("../integrations/DiffViewProvider.js");

  if (resolveCurrentDiff("accept")) {
    log(`COMPLETE_WRITE auto-accepted diff for ${call.toolName}`);
    return;
  }
  log(`COMPLETE_WRITE no pending diff, force-resolving ${call.toolName}`);

  call.forceResolve(
    successResult({
      status: "force-completed",
      path: call.displayArgs,
      message:
        "No pending diff to accept — file may already be saved or approval was not yet shown",
    }),
  );
};

const completeGenericTool: AgentToolCompletionStrategy = async ({ call }) => {
  call.forceResolve(
    successResult({
      status: "force-completed",
      tool: call.toolName,
      message: "Force-completed by user from VS Code",
    }),
  );
};

const COMPLETION_STRATEGIES = new Map<string, AgentToolCompletionStrategy>([
  ["execute_command", completeExecuteCommand],
  ["get_terminal_output", completeGetTerminalOutput],
  ["write_file", completeWriteTool],
  ["apply_diff", completeWriteTool],
]);

export function getAgentToolCompletionStrategy(
  toolName: string,
): AgentToolCompletionStrategy {
  return COMPLETION_STRATEGIES.get(toolName) ?? completeGenericTool;
}

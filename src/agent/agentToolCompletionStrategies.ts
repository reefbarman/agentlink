import type { TerminalProvider } from "../core/capabilities/terminal.js";
import type { TrackedCall } from "./AgentToolCallTracker.js";
import { successResult } from "../shared/types.js";

export type AgentToolCompletionStrategy = (
  call: TrackedCall,
  log: (message: string) => void,
  terminalProvider?: TerminalProvider,
) => Promise<void>;

const completeExecuteCommand: AgentToolCompletionStrategy = async (
  call,
  log,
  terminalProvider,
) => {
  log(
    `COMPLETE_EXEC ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${call.terminalId ?? "none"}`,
  );
  let partialOutput = "";
  if (call.terminalId) {
    partialOutput =
      terminalProvider?.getCurrentOutput?.(call.terminalId, { force: true }) ??
      terminalProvider?.getBackgroundState(call.terminalId)?.output ??
      "";
    log(`COMPLETE_EXEC output captured: ${partialOutput.length} chars`);
  }

  if (call.terminalId) {
    log(`COMPLETE_EXEC interrupting terminal ${call.terminalId}`);
    terminalProvider?.interruptTerminal(call.terminalId);
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

const completeGetTerminalOutput: AgentToolCompletionStrategy = async (
  call,
  log,
  terminalProvider,
) => {
  const terminalId = call.displayArgs;
  log(
    `COMPLETE_GET_OUTPUT ${call.toolName} (${call.id.slice(0, 8)}), terminalId=${terminalId}`,
  );

  const state = terminalProvider?.getBackgroundState(terminalId);

  if (!state) {
    const directOutput = terminalProvider?.getCurrentOutput?.(terminalId, {
      force: true,
    });
    call.forceResolve(
      successResult(
        directOutput
          ? {
              terminal_id: terminalId,
              is_running: false,
              exit_code: null,
              output_captured: true,
              output: directOutput,
              status: "force-completed",
              message:
                "Output returned immediately — wait was interrupted by user.",
            }
          : {
              error: `Terminal "${terminalId}" not found. It may have been closed.`,
            },
      ),
    );
    return;
  }

  const output = state.output_captured
    ? state.output
    : (terminalProvider?.getCurrentOutput?.(terminalId, { force: true }) ?? "");

  call.forceResolve(
    successResult({
      terminal_id: terminalId,
      is_running: state.is_running,
      exit_code: state.exit_code,
      output_captured: state.output_captured || !!output,
      output: output || "[No output captured]",
      status: "force-completed",
      message: "Output returned immediately — wait was interrupted by user.",
      ...(!state.output_captured &&
        !output && {
          verification_hint:
            `Terminal_id "${terminalId}" did not have shell integration capture available. ` +
            "Use the visible terminal to verify command state rather than re-running it.",
        }),
    }),
  );
};

const completeWriteTool: AgentToolCompletionStrategy = async (call, log) => {
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

const completeGenericTool: AgentToolCompletionStrategy = async (call) => {
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

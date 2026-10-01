import type {
  TerminalBackgroundState,
  TerminalCommandResult,
} from "../core/capabilities/terminal.js";

import { splitCompoundCommand } from "../approvals/commandSplitter.js";

const DOCKER_SOCKET_DENIAL =
  /(?:permission denied|operation not permitted|\bEACCES\b|\bEPERM\b)[^\r\n]{0,512}(?:docker (?:daemon socket|API)|unix:\/\/[^\r\n]{0,384}docker\.sock)/i;

export function sandboxDockerRecovery(input: {
  command: string;
  cwd: string;
  output: string;
  security: TerminalCommandResult["security"];
  temporaryHome: boolean;
  replayable: boolean;
  exitCode: number | null;
  running?: boolean;
  complete?: boolean;
  finalized?: boolean;
  state?: TerminalBackgroundState["state"];
}) {
  if (
    !input.replayable ||
    input.security?.route !== "sandbox" ||
    input.security.confinement !== "verified-baseline" ||
    input.security.commandExecutionPolicySnapshot === "read-only" ||
    input.exitCode === 0 ||
    input.exitCode === null ||
    input.running ||
    input.complete === false ||
    input.finalized === false ||
    (input.state && input.state !== "completed") ||
    !DOCKER_SOCKET_DENIAL.test(input.output)
  ) {
    return undefined;
  }
  const compound = splitCompoundCommand(input.command).length > 1;
  return {
    code: "sandbox_host_integration" as const,
    message:
      "The sandbox denied access to a local Docker socket. Inspect which test or command failed, then request separately reviewed native execution only for the failed step. AgentLink will not replay commands automatically or change socket permissions.",
    automatic_retry: false as const,
    options: [
      {
        action: compound
          ? "isolate_failed_step_for_reviewed_native_retry"
          : input.temporaryHome
            ? "reviewed_native_retry_without_disposable_home"
            : "reviewed_native_retry",
        same_command: !compound,
        ...(!compound ? { command: input.command } : {}),
        cwd: input.cwd,
        sandbox_permissions: "require_escalated",
        reason_required: true,
        reviewed_native_execution: true,
        ...(input.temporaryHome ? { temporary_home: false } : {}),
      },
    ],
    prohibited_workarounds: [
      "blindly_replay_successful_prefixes",
      "weaken_container_socket_permissions",
      "grant_unrestricted_unix_ipc",
    ],
  };
}

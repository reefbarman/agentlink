import {
  launchSandboxedProcess,
  type SandboxManagedNetworkDestination,
  type SandboxedProcessHandle,
  type SandboxedProcessLauncherOptions,
  type SandboxedProcessRequest,
} from "@agentlink/sandbox";

import {
  WorkspaceProcessLaunchError,
  type WorkspaceProcessExit,
  type WorkspaceProcessLaunchRequest,
  type WorkspaceProcessLauncher,
} from "./workspaceExecutionBackend.js";

export interface SandboxedWorkspaceProcessLauncherOptions extends SandboxedProcessLauncherOptions {
  /** Shell for launches that are not already `<shell> -c <command>`. */
  readonly fallbackShell?: string;
  /**
   * Run every launch through the sandbox's public proxy, asking about each
   * public destination (with the launch it came from). Creating a launcher
   * with this set is the approval to use the proxy; private, local and
   * metadata addresses stay blocked.
   */
  readonly publicNetwork?: {
    readonly onNetworkRequest: (
      destination: SandboxManagedNetworkDestination,
      request: WorkspaceProcessLaunchRequest,
    ) => Promise<"allow-once" | "reject">;
  };
  /** Test seam; defaults to `launchSandboxedProcess`. */
  readonly launch?: (
    options: SandboxedProcessLauncherOptions,
    request: SandboxedProcessRequest,
    onOutput: (stream: "stdout" | "stderr", text: string) => void,
  ) => SandboxedProcessHandle;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launchErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code ? code : "sandbox_launch_failed";
}

/**
 * Run workspace processes (commands, search, git probes) through the macOS
 * sandbox on pipes. Workspace commands arrive as `<shell> -c <command>` and
 * keep their shell; any other argv is quoted and run by `fallbackShell`.
 */
export function createSandboxedWorkspaceProcessLauncher(
  options: SandboxedWorkspaceProcessLauncherOptions,
): WorkspaceProcessLauncher {
  const { fallbackShell = "/bin/sh", launch = launchSandboxedProcess } =
    options;
  return {
    launchProcess({ request, onOutput }) {
      const shellCommand =
        request.args.length === 2 && request.args[0] === "-c"
          ? { shell: request.executable, command: request.args[1]! }
          : {
              shell: fallbackShell,
              command: [request.executable, ...request.args]
                .map(shellQuote)
                .join(" "),
            };
      const handle = launch(
        options,
        {
          sessionId: request.sessionId,
          operationId: request.operationId,
          ...shellCommand,
          cwd: request.cwd,
          environment: request.environment,
          ...(options.publicNetwork
            ? {
                publicNetwork: {
                  onNetworkRequest: (destination) =>
                    options.publicNetwork!.onNetworkRequest(
                      destination,
                      request,
                    ),
                },
              }
            : {}),
        },
        (stream, text) => onOutput(stream, Buffer.from(text, "utf8")),
      );
      let running = false;
      const started = handle.started.then(
        () => {
          running = true;
        },
        (error: unknown) => {
          throw new WorkspaceProcessLaunchError(launchErrorCode(error));
        },
      );
      // Avoid an unhandled rejection when the caller only awaits `exited`.
      started.catch(() => undefined);
      const exited = handle.exited.then((exit): WorkspaceProcessExit => {
        if (exit.error && running) {
          onOutput(
            "stderr",
            Buffer.from(`\nAgentLink sandbox: ${exit.error.message}\n`, "utf8"),
          );
        }
        return {
          ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
          ...(exit.signal ? { signal: exit.signal } : {}),
        };
      });
      return {
        get pid() {
          return handle.pid;
        },
        started,
        exited,
        signal: (signal) => handle.signal(signal),
      };
    },
  };
}

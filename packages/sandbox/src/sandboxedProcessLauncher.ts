import { randomUUID } from "node:crypto";
import os from "node:os";

import type { SandboxExecutionMetadata } from "@agentlink/protocol/terminal-security";

import {
  SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
  type SandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";
import { CURRENT_SANDBOX_POLICY_VERSION } from "./sandboxPolicy.js";
import type {
  SandboxManagedNetworkDestination,
  SandboxOutputStream,
} from "./sandboxHelperProtocol.js";
import type {
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  DEFAULT_SANDBOX_PRIVATE_DIRECTORY_PREFIX,
  prepareWorkspaceSandboxLaunch,
} from "./workspaceSandboxPolicy.js";

/**
 * Non-interactive sandboxed process launches for hosts without a terminal UI
 * (the Ask Agent helper, workspace-host backends). Each launch runs on pipes
 * through the packaged sandbox helper: stdin is closed, stdout and stderr stay
 * separate, network is loopback-only unless a request opts into the public
 * proxy, and only `writableRoots` plus private per-command directories are
 * writable.
 */
export interface SandboxedProcessLauncherOptions {
  /** Usually `new SandboxHelperClient(createNodeSandboxHelperTransportFactory(...))`. */
  readonly runtime: SandboxRuntimeProvider;
  /** Writable roots; each launch's `cwd` must be inside one. */
  readonly writableRoots: readonly string[];
  /** Host-reserved non-interactive variables (pagers, prompts, markers). */
  readonly agentEnvironment?: Readonly<Record<string, string>>;
  /**
   * Defaults to inheriting the request environment minus `*KEY*`,
   * `*SECRET*` and `*TOKEN*` variables, unlike the VS Code terminal default.
   */
  readonly environmentPolicy?: SandboxShellEnvironmentPolicy;
  readonly environmentBudgetBytes?: number;
  readonly homeDirectory?: string;
  readonly hostTemporaryDirectory?: string;
  readonly privateDirectoryPrefix?: string;
  readonly trustedRuntimeRoots?: readonly string[];
  /** Give commands a fresh private HOME. Defaults to false. */
  readonly temporaryHome?: boolean;
  /**
   * Also allow writes to host temporary directories. Defaults to false, which
   * gives each command a private `TMPDIR` instead.
   */
  readonly shareHostTemporaryDirectories?: boolean;
  /**
   * Roots hidden from reads (for example the user's home folder). Inside
   * them only `writableRoots`, the private per-command directories and
   * `trustedRuntimeRoots` stay readable. Requires `temporaryHome` when the
   * host home is denied. Defaults to none.
   */
  readonly deniedReadRoots?: readonly string[];
  /** Host platform; picks the reported backend. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export interface SandboxedProcessRequest {
  /** Owning agent session, bound into the launch digest. */
  readonly sessionId: string;
  /** Stable operation identity; a fresh ID when omitted. */
  readonly operationId?: string;
  readonly command: string;
  /** Absolute shell that runs `command` with `-c`. */
  readonly shell: string;
  readonly cwd: string;
  /** Source environment, filtered by the shell environment policy. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * Route the command's network through the sandbox's public proxy. Each
   * public destination pauses until `onNetworkRequest` answers; private,
   * local and metadata addresses stay blocked. Launching with this set is
   * itself the caller's approval: the launcher issues and consumes the
   * one-launch capability grant the compiler requires.
   */
  readonly publicNetwork?: {
    readonly onNetworkRequest: (
      destination: SandboxManagedNetworkDestination,
    ) => Promise<"allow-once" | "reject">;
  };
}

export interface SandboxedProcessExit {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  /** Set when the sandbox could not start or lost the command. */
  readonly error?: Error;
}

export interface SandboxedProcessHandle {
  /** Process-group leader once started. */
  readonly pid: number | undefined;
  /** Resolves with the applied sandbox metadata once the command runs. */
  readonly started: Promise<SandboxExecutionMetadata>;
  /** Resolves after the command exits and its output is delivered. Never rejects. */
  readonly exited: Promise<SandboxedProcessExit>;
  /**
   * `SIGINT` interrupts; `SIGTERM` and `SIGKILL` terminate the process group
   * (the helper escalates to `SIGKILL` after a short grace period). Returns
   * false only when the request could not be delivered.
   */
  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): boolean;
}

const UNUSED_PIPE_DIMENSIONS = { columns: 80, rows: 24 } as const;

function signalName(signal: number | undefined): NodeJS.Signals | undefined {
  if (signal === undefined) return undefined;
  for (const [name, value] of Object.entries(os.constants.signals)) {
    if (value === signal) return name as NodeJS.Signals;
  }
  return undefined;
}

function toExit(exit: SandboxCommandExit): SandboxedProcessExit {
  const signal = signalName(exit.signal);
  return {
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(signal ? { signal } : {}),
  };
}

export function launchSandboxedProcess(
  options: SandboxedProcessLauncherOptions,
  request: SandboxedProcessRequest,
  onOutput: (stream: SandboxOutputStream, text: string) => void,
): SandboxedProcessHandle {
  let process: SandboxCommandProcess | undefined;
  let pid: number | undefined;
  let pendingSignal: "SIGINT" | "SIGTERM" | undefined;
  let settled = false;
  let resolveExited!: (exit: SandboxedProcessExit) => void;
  const exited = new Promise<SandboxedProcessExit>((resolve) => {
    resolveExited = resolve;
  });
  const settle = (exit: SandboxedProcessExit) => {
    if (settled) return;
    settled = true;
    resolveExited(exit);
  };

  const deliver = (
    target: SandboxCommandProcess,
    signal: "SIGINT" | "SIGTERM",
  ) => (signal === "SIGINT" ? target.interrupt() : target.terminate());

  const started = (async () => {
    const prepared = await prepareWorkspaceSandboxLaunch({
      workspaceRoots: options.writableRoots,
      cwd: request.cwd,
      command: request.command,
      sessionId: request.sessionId,
      capability: {
        publicNetwork: request.publicNetwork !== undefined,
        localBinding: false,
      },
      hostEnvironment: request.environment,
      agentEnvironment: options.agentEnvironment ?? {},
      environmentPolicy: options.environmentPolicy ?? {
        ignoreDefaultExcludes: false,
      },
      environmentBudgetBytes:
        options.environmentBudgetBytes ?? SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
      homeDirectory: options.homeDirectory ?? os.homedir(),
      hostTemporaryDirectory: options.hostTemporaryDirectory ?? os.tmpdir(),
      privateDirectoryPrefix:
        options.privateDirectoryPrefix ??
        DEFAULT_SANDBOX_PRIVATE_DIRECTORY_PREFIX,
      trustedRuntimeRoots: options.trustedRuntimeRoots ?? [],
      temporaryHome: options.temporaryHome ?? false,
      shareHostTemporaryDirectories:
        options.shareHostTemporaryDirectories ?? false,
      ...(options.deniedReadRoots
        ? { deniedReadRoots: options.deniedReadRoots }
        : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    const now = Date.now();
    const authorization = request.publicNetwork
      ? {
          ...prepared.authorization,
          grant: {
            grantId: randomUUID(),
            bindingDigest: prepared.bindingDigest,
            policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
            sessionId: request.sessionId,
            issuedAt: now,
            expiresAt: now + 60_000,
            auditId: randomUUID(),
            consumedAt: now,
          },
        }
      : prepared.authorization;
    let launched: SandboxCommandProcess;
    try {
      launched = options.runtime.launch(
        compileSandboxHelperLaunchRequest({
          channelId: `sandboxed-process:${request.sessionId}`,
          commandId: request.operationId ?? randomUUID(),
          generation: 1,
          command: request.command,
          cwd: prepared.cwd,
          shell: request.shell,
          dimensions: { ...UNUSED_PIPE_DIMENSIONS },
          authorization,
          stdio: "pipe",
        }),
      );
    } catch (error) {
      prepared.directories.cleanup();
      throw error;
    }
    process = launched;
    const publicNetwork = request.publicNetwork;
    const subscription = launched.onEvent((event) => {
      if (event.type === "data") onOutput(event.stream ?? "stdout", event.data);
      if (event.type !== "network-request") return;
      const answer = publicNetwork
        ? publicNetwork
            .onNetworkRequest({
              ...event.request,
              dnsAnswers: event.request.dnsAnswers.map((entry) => ({
                ...entry,
              })),
            })
            .catch(() => "reject" as const)
        : Promise.resolve("reject" as const);
      void answer.then((decision) =>
        launched.respondToNetworkRequest?.(
          event.request.requestId,
          decision === "allow-once" ? "allow-once" : "reject",
        ),
      );
    });
    void launched.completion
      .then(toExit, (error: unknown) => ({
        error: error instanceof Error ? error : new Error(String(error)),
      }))
      .then((exit) => {
        subscription.dispose();
        prepared.directories.cleanup();
        settle(exit);
      });
    if (pendingSignal) deliver(launched, pendingSignal);
    const ready = await launched.ready;
    pid = ready.pid;
    return prepared.metadata;
  })();
  started.catch((error: unknown) => {
    if (process) return; // completion reports failures after launch
    settle({
      error: error instanceof Error ? error : new Error(String(error)),
    });
  });

  return {
    get pid() {
      return pid;
    },
    started,
    exited,
    signal(signal) {
      if (settled) return true;
      const requested = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
      if (!process) {
        if (pendingSignal !== "SIGTERM") pendingSignal = requested;
        return true;
      }
      return deliver(process, requested);
    },
  };
}

import { spawn } from "node:child_process";

/**
 * Process execution seam for workspace commands. The trusted host prepares,
 * authorises, records, and redacts every launch; the backend only starts the
 * exact prepared process and reports its output and exit. A remote worker
 * implementation must treat every field as host-resolved, never model-supplied.
 *
 * This seam covers `execute_command` only. File tools, search, language
 * services, and stdio MCP still execute in the host process.
 */
export interface WorkspaceProcessLaunchRequest {
  readonly schemaVersion: 1;
  /** Stable operation identity; equal to the supervisor command ID. */
  readonly operationId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly policyFingerprint: string;
  readonly operationDigest: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Host-canonical absolute working directory. */
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export type WorkspaceProcessSignal = "SIGTERM" | "SIGKILL";

export interface WorkspaceProcessExit {
  /** Present when the process exited normally. */
  readonly exitCode?: number;
  /** Present when the process was terminated by a signal. */
  readonly signal?: NodeJS.Signals;
}

export interface WorkspaceProcessHandle {
  readonly pid?: number;
  /** Resolves once the process is running; rejects with a coded launch error. */
  readonly started: Promise<void>;
  /** Resolves after the process exits and its output streams close. Never rejects. */
  readonly exited: Promise<WorkspaceProcessExit>;
  /**
   * Signal the process and its descendants. Returns false when the signal
   * could not be delivered; an already-exited process counts as delivered.
   */
  signal(signal: WorkspaceProcessSignal): boolean;
}

export interface WorkspaceProcessLaunch {
  readonly request: WorkspaceProcessLaunchRequest;
  readonly onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => void;
}

export interface WorkspaceExecutionBackend {
  launchProcess(launch: WorkspaceProcessLaunch): WorkspaceProcessHandle;
}

/** Error carrying a launch failure code such as `ENOENT`. */
export class WorkspaceProcessLaunchError extends Error {
  constructor(readonly code: string) {
    super(`workspace_process_launch_failed:${code}`);
    this.name = "WorkspaceProcessLaunchError";
  }
}

/** Default backend: spawn directly on this machine, unsandboxed. */
export function createLocalWorkspaceExecutionBackend(): WorkspaceExecutionBackend {
  return {
    launchProcess({ request, onOutput }) {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: { ...request.environment },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (bytes: Buffer | string) => {
        onOutput("stdout", Buffer.from(bytes));
      });
      child.stderr?.on("data", (bytes: Buffer | string) => {
        onOutput("stderr", Buffer.from(bytes));
      });
      // Wait for `close`, not merely `exit`, so all stdout/stderr delivered
      // before the process handles close has been reported.
      const exited = new Promise<WorkspaceProcessExit>((resolve) => {
        child.once("close", (code, exitSignal) => {
          resolve({
            ...(code !== null ? { exitCode: code } : {}),
            ...(exitSignal !== null ? { signal: exitSignal } : {}),
          });
        });
      });
      const started = new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => {
          reject(
            new WorkspaceProcessLaunchError(errorCode(error) ?? "unknown"),
          );
        });
      });
      // Avoid an unhandled rejection when the caller only awaits `exited`.
      started.catch(() => undefined);
      return {
        get pid() {
          return child.pid;
        },
        started,
        exited,
        signal(signal) {
          if (!child.pid) return false;
          try {
            if (process.platform === "win32") child.kill(signal);
            else process.kill(-child.pid, signal);
            return true;
          } catch (error) {
            return errorCode(error) === "ESRCH";
          }
        },
      };
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

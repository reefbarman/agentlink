import { createHash, randomUUID } from "node:crypto";

import type { WorkspaceProcessLauncher } from "@agentlink/workspace-host";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept per command: enough for refs and short status listings. */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ProcessRunnerOptions {
  /** Where processes run: the command worker, or this machine. */
  readonly launcher: WorkspaceProcessLauncher;
  /** Environment for every process, including any egress proxy. */
  readonly environment: Readonly<Record<string, string>>;
  readonly ownerId: string;
  readonly timeoutMs?: number;
}

export interface GitCommandOptions extends ProcessRunnerOptions {
  /** Absolute git binary where the launcher runs processes. */
  readonly gitExecutable: string;
}

export interface ProcessResult {
  /** Undefined when the process was stopped by a signal. */
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  /** The kept output (see `keep`). */
  readonly output: string;
  /** Some output was dropped to stay within `maxOutputBytes`. */
  readonly truncated: boolean;
  /** Killed for running past its time limit. */
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export type GitCommandResult = ProcessResult;

/** Thrown when a process could not be started at all. */
export class GitLaunchError extends Error {
  constructor(readonly code: string) {
    super(`the process could not start (${code})`);
    this.name = "GitLaunchError";
  }
}

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  /** Canonical absolute folder the process runs in. */
  readonly cwd: string;
  /** Labels the operation in the worker's records. */
  readonly purpose: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** `tail` (default) keeps the end of long output, `head` the start. */
  readonly keep?: "head" | "tail";
  /** `both` (default) keeps stdout and stderr together. */
  readonly streams?: "both" | "stdout";
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export type GitCommand = (
  request: Omit<ProcessRequest, "executable" | "environment">,
) => Promise<GitCommandResult>;

/** Run one process where commands run, keeping bounded output. */
export function createProcessRunner(
  options: ProcessRunnerOptions,
): ProcessRunner {
  return async (request) => {
    const { executable, args, cwd, purpose } = request;
    const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const keepHead = request.keep === "head";
    const output: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const started = Date.now();
    const handle = options.launcher.launchProcess({
      request: {
        schemaVersion: 1,
        operationId: randomUUID(),
        ownerId: options.ownerId,
        sessionId: purpose,
        turnId: purpose,
        policyFingerprint: `${purpose}-v1`,
        operationDigest: createHash("sha256")
          .update(JSON.stringify({ executable, args, cwd }))
          .digest("hex"),
        executable,
        args: [...args],
        cwd,
        environment: { ...options.environment, ...request.environment },
      },
      onOutput: (stream, bytes) => {
        if (request.streams === "stdout" && stream !== "stdout") return;
        if (keepHead) {
          if (size >= limit) {
            truncated = true;
            return;
          }
          const room = limit - size;
          if (bytes.length > room) truncated = true;
          const kept = bytes.subarray(0, room);
          output.push(kept);
          size += kept.length;
          return;
        }
        output.push(bytes);
        size += bytes.length;
        while (size > limit && output.length > 1) {
          truncated = true;
          size -= output.shift()!.length;
        }
      },
    });
    try {
      await handle.started;
    } catch (error) {
      throw new GitLaunchError(
        (error as { code?: string }).code ?? "launch_failed",
      );
    }
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        handle.signal("SIGKILL");
      },
      request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();
    const exit = await handle.exited.finally(() => clearTimeout(timer));
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      output: Buffer.concat(output).toString("utf8"),
      truncated,
      timedOut,
      durationMs: Date.now() - started,
    };
  };
}

/**
 * Run one git command where commands run. Git never prompts (a repository
 * that needs credentials fails instead of hanging).
 */
export function createGitCommand(options: GitCommandOptions): GitCommand {
  const run = createProcessRunner(options);
  return (request) =>
    run({
      ...request,
      executable: options.gitExecutable,
      environment: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
    });
}

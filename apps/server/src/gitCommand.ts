import { createHash, randomUUID } from "node:crypto";

import type { WorkspaceProcessLauncher } from "@agentlink/workspace-host";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept per command: enough for refs and short status listings. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface GitCommandOptions {
  /** Where git runs: the command worker, or this machine. */
  readonly launcher: WorkspaceProcessLauncher;
  /** Absolute git binary where the launcher runs processes. */
  readonly gitExecutable: string;
  /** Environment for git, including any egress proxy. */
  readonly environment: Readonly<Record<string, string>>;
  readonly ownerId: string;
  readonly timeoutMs?: number;
}

export interface GitCommandResult {
  /** Undefined when git was stopped by a signal. */
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  /** stdout and stderr together, the tail when it was long. */
  readonly output: string;
}

/** Thrown when git could not be started at all. */
export class GitLaunchError extends Error {
  constructor(readonly code: string) {
    super(`git could not start (${code})`);
    this.name = "GitLaunchError";
  }
}

export type GitCommand = (request: {
  readonly args: readonly string[];
  /** Canonical absolute folder git runs in. */
  readonly cwd: string;
  /** Labels the operation in the worker's records. */
  readonly purpose: string;
  readonly timeoutMs?: number;
}) => Promise<GitCommandResult>;

/**
 * Run one git command where commands run. Git never prompts (a repository
 * that needs credentials fails instead of hanging), and only the tail of
 * its output is kept.
 */
export function createGitCommand(options: GitCommandOptions): GitCommand {
  return async ({ args, cwd, purpose, timeoutMs }) => {
    const output: Buffer[] = [];
    let size = 0;
    const handle = options.launcher.launchProcess({
      request: {
        schemaVersion: 1,
        operationId: randomUUID(),
        ownerId: options.ownerId,
        sessionId: purpose,
        turnId: purpose,
        policyFingerprint: `${purpose}-v1`,
        operationDigest: createHash("sha256")
          .update(
            JSON.stringify({ executable: options.gitExecutable, args, cwd }),
          )
          .digest("hex"),
        executable: options.gitExecutable,
        args: [...args],
        cwd,
        environment: {
          ...options.environment,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/false",
        },
      },
      onOutput: (_stream, bytes) => {
        output.push(bytes);
        size += bytes.length;
        while (size > MAX_OUTPUT_BYTES && output.length > 1) {
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
    const timer = setTimeout(
      () => handle.signal("SIGKILL"),
      timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();
    const exit = await handle.exited.finally(() => clearTimeout(timer));
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      output: Buffer.concat(output).toString("utf8"),
    };
  };
}

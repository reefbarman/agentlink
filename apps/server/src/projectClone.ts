import type { WorkspaceProcessLauncher } from "@agentlink/workspace-host";
import { createHash, randomUUID } from "node:crypto";

import { ProjectCloneError, type CloneRepository } from "./projectCatalog.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_OUTPUT = 4_000;

export interface GitClonerOptions {
  /** Where git runs: the command worker, or this machine. */
  readonly launcher: WorkspaceProcessLauncher;
  /** Absolute git binary where the launcher runs processes. */
  readonly gitExecutable: string;
  /** Environment for git, including any egress proxy. */
  readonly environment: Readonly<Record<string, string>>;
  readonly ownerId: string;
  readonly timeoutMs?: number;
}

/**
 * Clone with `git clone -- <url> <directory>` in the project folder. Git
 * never prompts (a private repository fails instead of hanging), and only
 * the tail of its output is kept for the error.
 */
export function createGitCloner(options: GitClonerOptions): CloneRepository {
  return async ({ url, directory, cwd }) => {
    const args = ["clone", "--", url, directory];
    const output: Buffer[] = [];
    let size = 0;
    const handle = options.launcher.launchProcess({
      request: {
        schemaVersion: 1,
        operationId: randomUUID(),
        ownerId: options.ownerId,
        sessionId: "project-setup",
        turnId: "project-setup",
        policyFingerprint: "project-clone-v1",
        operationDigest: createHash("sha256")
          .update(
            JSON.stringify({ executable: options.gitExecutable, args, cwd }),
          )
          .digest("hex"),
        executable: options.gitExecutable,
        args,
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
        while (size > MAX_ERROR_OUTPUT * 2 && output.length > 1) {
          size -= output.shift()!.length;
        }
      },
    });
    try {
      await handle.started;
    } catch (error) {
      throw new ProjectCloneError(
        url,
        `git could not start (${(error as { code?: string }).code ?? "launch_failed"})`,
      );
    }
    const timer = setTimeout(
      () => handle.signal("SIGKILL"),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();
    const exit = await handle.exited.finally(() => clearTimeout(timer));
    if (exit.exitCode === 0) return;
    const text = Buffer.concat(output).toString("utf8").trim();
    throw new ProjectCloneError(
      url,
      text.slice(-MAX_ERROR_OUTPUT) ||
        (exit.signal ? `git stopped (${exit.signal})` : "git clone failed"),
    );
  };
}

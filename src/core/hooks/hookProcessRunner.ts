import type {
  HookProcessRequest,
  HookProcessResult,
  HookProcessRunner,
} from "./contracts";

import { spawn } from "node:child_process";

const KILL_GRACE_MS = 250;

export const runHookProcess: HookProcessRunner = async (
  request: Readonly<HookProcessRequest>,
): Promise<HookProcessResult> => {
  const startedAt = Date.now();
  const command = applyReplacements(
    request.command,
    request.replacements ?? {},
  );
  const env = applyEnvironmentReplacements(
    request.env ?? {},
    request.replacements ?? {},
  );

  return await new Promise<HookProcessResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    let stdout = "";
    let stderr = "";
    let forceKillTimer: NodeJS.Timeout | undefined;

    const shell =
      process.platform === "win32"
        ? { program: process.env.COMSPEC ?? "cmd.exe", args: ["/C"] }
        : { program: process.env.SHELL ?? "/bin/sh", args: ["-lc"] };
    const child = spawn(shell.program, [...shell.args, command], {
      cwd: request.cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        outputLimitExceeded,
        durationMs: Date.now() - startedAt,
      });
    };

    const killTree = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
      forceKillTimer.unref();
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (outputLimitExceeded) return;
      const remaining = request.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputLimitExceeded = true;
        killTree();
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      outputBytes += accepted.byteLength;
      if (target === "stdout") stdout += accepted.toString("utf8");
      else stderr += accepted.toString("utf8");
      if (accepted.byteLength < chunk.byteLength) {
        outputLimitExceeded = true;
        killTree();
      }
    };

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, request.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", finish);

    if (request.signal?.aborted) onAbort();
    try {
      child.stdin.end(JSON.stringify(request.input));
    } catch {
      child.stdin.destroy();
    }
  });
};

export function applyReplacements(
  value: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = value;
  for (const [needle, replacement] of Object.entries(replacements)) {
    result = result.split(needle).join(replacement);
  }
  return result;
}

function applyEnvironmentReplacements(
  env: Readonly<Record<string, string>>,
  replacements: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      applyReplacements(value, replacements),
    ]),
  );
}

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

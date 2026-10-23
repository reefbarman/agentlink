import type {
  SandboxRuntimeProvider,
  SandboxedProcessExit,
  SandboxedProcessRequest,
} from "@agentlink/sandbox";
import { describe, expect, it } from "vitest";

import { WorkspaceProcessLaunchError } from "./workspaceExecutionBackend.js";
import { createSandboxedWorkspaceProcessLauncher } from "./sandboxedProcessLauncher.js";

const runtime = {} as SandboxRuntimeProvider;
const identity = {
  schemaVersion: 1 as const,
  operationId: "op-1",
  ownerId: "owner",
  sessionId: "session-1",
  turnId: "turn-1",
  policyFingerprint: "policy",
  operationDigest: "digest",
  cwd: "/work",
  environment: { PATH: "/usr/bin:/bin" },
};

function harness(
  outcome: {
    started?: Promise<never>;
    exit?: SandboxedProcessExit;
  } = {},
) {
  const requests: SandboxedProcessRequest[] = [];
  const signals: string[] = [];
  let emit!: (stream: "stdout" | "stderr", text: string) => void;
  const launcher = createSandboxedWorkspaceProcessLauncher({
    runtime,
    writableRoots: ["/work"],
    launch(_options, request, onOutput) {
      requests.push(request);
      emit = onOutput;
      return {
        pid: 77,
        started: outcome.started ?? Promise.resolve({} as never),
        exited: Promise.resolve(outcome.exit ?? { exitCode: 0 }),
        signal(signal) {
          signals.push(signal);
          return true;
        },
      };
    },
  });
  return {
    launcher,
    requests,
    signals,
    emit: (...args: Parameters<typeof emit>) => emit(...args),
  };
}

describe("createSandboxedWorkspaceProcessLauncher", () => {
  it("keeps the shell for `<shell> -c` launches and forwards output and signals", async () => {
    const test = harness();
    const output: Array<[string, string]> = [];
    const handle = test.launcher.launchProcess({
      request: { ...identity, executable: "/bin/zsh", args: ["-c", "ls -la"] },
      onOutput: (stream, bytes) => output.push([stream, bytes.toString()]),
    });
    expect(test.requests).toEqual([
      {
        sessionId: "session-1",
        operationId: "op-1",
        shell: "/bin/zsh",
        command: "ls -la",
        cwd: "/work",
        environment: { PATH: "/usr/bin:/bin" },
      },
    ]);
    test.emit("stderr", "warn");
    expect(output).toEqual([["stderr", "warn"]]);
    expect(handle.signal("SIGTERM")).toBe(true);
    expect(test.signals).toEqual(["SIGTERM"]);
    expect(handle.pid).toBe(77);
    await expect(handle.started).resolves.toBeUndefined();
    await expect(handle.exited).resolves.toEqual({ exitCode: 0 });
  });

  it("quotes other argv through the fallback shell", () => {
    const test = harness();
    test.launcher.launchProcess({
      request: {
        ...identity,
        executable: "/usr/bin/rg",
        args: ["--json", "it's", "--", "/work"],
      },
      onOutput: () => undefined,
    });
    expect(test.requests[0]).toMatchObject({
      shell: "/bin/sh",
      command: `'/usr/bin/rg' '--json' 'it'\\''s' '--' '/work'`,
    });
  });

  it("maps launch failures to coded workspace launch errors", async () => {
    const failure = Object.assign(new Error("structural"), {
      code: "sandbox_structural_protection",
    });
    const test = harness({
      started: Promise.reject(failure),
      exit: { error: failure },
    });
    const handle = test.launcher.launchProcess({
      request: { ...identity, executable: "/bin/sh", args: ["-c", "true"] },
      onOutput: () => undefined,
    });
    const error = await handle.started.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceProcessLaunchError);
    expect((error as WorkspaceProcessLaunchError).code).toBe(
      "sandbox_structural_protection",
    );
    await expect(handle.exited).resolves.toEqual({});
  });
});

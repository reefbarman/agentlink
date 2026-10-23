import type {
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SandboxHelperClient } from "./SandboxHelperClient.js";
import type { SandboxHelperLaunchRequest } from "./sandboxHelperProtocol.js";
import { createNodeSandboxHelperTransportFactory } from "./NodeSandboxHelperTransport.js";
import { launchSandboxedProcess } from "./sandboxedProcessLauncher.js";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fakeRuntime() {
  const launches: SandboxHelperLaunchRequest[] = [];
  let listener: ((event: SandboxCommandEvent) => void) | undefined;
  let finish!: (exit: SandboxCommandExit) => void;
  const terminations: string[] = [];
  const runtime: SandboxRuntimeProvider = {
    launch(request) {
      launches.push(request);
      const completion = new Promise<SandboxCommandExit>((resolve) => {
        finish = resolve;
      });
      const process: SandboxCommandProcess = {
        identity: request,
        ready: Promise.resolve({ pid: 4321, pgid: 4321, backend: "seatbelt" }),
        completion,
        onEvent(next) {
          listener = next;
          return { dispose: () => (listener = undefined) };
        },
        write: () => false,
        resize: () => false,
        interrupt: () => {
          terminations.push("interrupt");
          return true;
        },
        terminate: () => {
          terminations.push("terminate");
          return true;
        },
        dispose() {},
      };
      return process;
    },
    dispose() {},
  };
  return {
    runtime,
    launches,
    terminations,
    emit: (event: SandboxCommandEvent) => listener?.(event),
    finish: (exit: SandboxCommandExit) => finish(exit),
  };
}

describe("launchSandboxedProcess", () => {
  it("launches a strict piped request and maps streams, exit and signals", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const privateRoot = await temporaryDirectory("al-sbx-private-");
    const fake = fakeRuntime();
    const output: Array<[string, string]> = [];
    const handle = launchSandboxedProcess(
      {
        runtime: fake.runtime,
        writableRoots: [root],
        privateDirectoryPrefix: path.join(privateRoot, "p-"),
        agentEnvironment: { GIT_TERMINAL_PROMPT: "0" },
      },
      {
        sessionId: "session-1",
        operationId: "operation-1",
        command: "printf hi",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin", API_TOKEN: "secret" },
      },
      (stream, text) => output.push([stream, text]),
    );

    const metadata = await handle.started;
    expect(handle.pid).toBe(4321);
    expect(metadata.capabilities.privateTmp).toBe(true);
    const [request] = fake.launches;
    expect(request).toMatchObject({
      stdio: "pipe",
      commandId: "operation-1",
      command: "printf hi",
      shell: "/bin/sh",
      cwd: root,
      network: { mode: "loopback" },
    });
    const privateDirectory = request!.filesystem.allowWrite.find((entry) =>
      entry.startsWith(privateRoot),
    );
    expect(request!.filesystem.allowWrite).toEqual(
      [root, privateDirectory].sort(),
    );
    expect(request!.environment.TMPDIR).toBe(path.join(privateDirectory!, "t"));
    expect(request!.environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(request!.environment).not.toHaveProperty("API_TOKEN");

    fake.emit({ type: "data", data: "out", stream: "stdout" });
    fake.emit({ type: "data", data: "err", stream: "stderr" });
    expect(handle.signal("SIGTERM")).toBe(true);
    expect(fake.terminations).toEqual(["terminate"]);
    fake.finish({ signal: 15, timedOut: false });

    await expect(handle.exited).resolves.toEqual({ signal: "SIGTERM" });
    expect(output).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
    ]);
    expect(await exists(privateDirectory!)).toBe(false);
  });

  it("resolves exited with an error when the cwd is outside the writable roots", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const outside = await temporaryDirectory("al-sbx-outside-");
    const fake = fakeRuntime();
    const handle = launchSandboxedProcess(
      { runtime: fake.runtime, writableRoots: [root] },
      {
        sessionId: "session-1",
        command: "true",
        shell: "/bin/sh",
        cwd: outside,
        environment: {},
      },
      () => undefined,
    );
    await expect(handle.started).rejects.toThrow(
      "Sandbox cwd must be inside an active workspace root",
    );
    const exit = await handle.exited;
    expect(exit.error?.message).toContain("inside an active workspace root");
    expect(fake.launches).toEqual([]);
  });

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "denies writes outside the writable root through the production helper",
    async () => {
      // Stage the current helper scripts so the test never runs a stale build.
      const extensionRoot = await temporaryDirectory("al-sbx-runtime-");
      const stagePath = path.join(
        REPO_ROOT,
        "scripts",
        "package-sandbox-runtime.mjs",
      );
      const { stageSandboxRuntime } = (await import(
        pathToFileURL(stagePath).href
      )) as {
        stageSandboxRuntime(options: {
          repoRoot: string;
          destinationRoot: string;
        }): Promise<unknown>;
      };
      await stageSandboxRuntime({
        repoRoot: REPO_ROOT,
        destinationRoot: path.join(extensionRoot, "dist", "sandbox-runtime"),
      });

      const base = await temporaryDirectory("al-sbx-real-");
      const root = path.join(base, "work");
      const outside = path.join(base, "outside");
      await Promise.all([mkdir(root), mkdir(outside)]);
      const runtime = new SandboxHelperClient(
        createNodeSandboxHelperTransportFactory({
          extensionRoot,
          nodeExecutable: process.execPath,
        }),
      );
      cleanups.push(async () => runtime.dispose());

      const output = { stdout: "", stderr: "" };
      const handle = launchSandboxedProcess(
        {
          runtime,
          writableRoots: [root],
          trustedRuntimeRoots: [path.dirname(process.execPath)],
        },
        {
          sessionId: "sandboxed-process-real-test",
          command: [
            "printf inside > inside.txt",
            "printf escaped > ../outside/escaped.txt || echo outside-denied >&2",
            'printf tmp > "$TMPDIR/private.txt" && echo tmp-ok',
            "printf host-tmp > /tmp/al-sbx-real-escape.txt || echo host-tmp-denied >&2",
            "read line || echo stdin-closed",
          ].join("; "),
          shell: "/bin/sh",
          cwd: root,
          environment: { PATH: "/usr/bin:/bin" },
        },
        (stream, text) => {
          output[stream] += text;
        },
      );

      await handle.started;
      const exit = await handle.exited;
      expect(exit.error).toBeUndefined();
      expect(exit.exitCode).toBe(0);
      expect(await readFile(path.join(root, "inside.txt"), "utf8")).toBe(
        "inside",
      );
      expect(await exists(path.join(outside, "escaped.txt"))).toBe(false);
      expect(await exists("/tmp/al-sbx-real-escape.txt")).toBe(false);
      expect(output.stderr).toContain("outside-denied");
      expect(output.stderr).toContain("host-tmp-denied");
      expect(output.stdout).toContain("tmp-ok");
      expect(output.stdout).toContain("stdin-closed");
    },
    60_000,
  );
});

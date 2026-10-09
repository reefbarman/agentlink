import type { WorkspaceProcessLaunchRequest } from "@agentlink/workspace-host";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commandHostOptions } from "./assistantService.js";
import { startCommandWorker, type CommandWorker } from "./commandWorker.js";
import {
  canExecuteOnCommandWorker,
  createCommandWorkerLauncher,
  pingCommandWorker,
} from "./commandWorkerClient.js";
import {
  MAX_COMMAND_WORKER_FRAME_BYTES,
  readFrames,
} from "./commandWorkerProtocol.js";

const TOKEN = "worker-test-token";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture(
  options: { maxProcesses?: number; allowLocalPeers?: boolean } = {},
) {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "command-worker-")),
  );
  cleanup.push(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "projects");
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  const worker: CommandWorker = await startCommandWorker({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    roots: [root],
    handshakeTimeoutMs: 500,
    // Tests connect over loopback; the refusal itself is tested below.
    allowLocalPeers: options.allowLocalPeers ?? true,
    ...(options.maxProcesses ? { maxProcesses: options.maxProcesses } : {}),
  });
  cleanup.push(() => worker.close());
  const client = (token = TOKEN) => ({
    host: "127.0.0.1",
    port: worker.port,
    readToken: async () => token,
    connectTimeoutMs: 2_000,
  });
  const launcher = createCommandWorkerLauncher(client());
  const request = (
    script: string,
    overrides: Partial<WorkspaceProcessLaunchRequest> = {},
  ): WorkspaceProcessLaunchRequest => ({
    schemaVersion: 1,
    operationId: "op-1",
    ownerId: "owner",
    sessionId: "session",
    turnId: "turn",
    policyFingerprint: "policy",
    operationDigest: "digest",
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: path.join(root, "home"),
    environment: { PATH: "/usr/bin:/bin", MARKER: "from-server" },
    ...overrides,
  });
  const run = async (
    launch: WorkspaceProcessLaunchRequest,
    using = launcher,
  ) => {
    const output: Record<"stdout" | "stderr", Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    const handle = using.launchProcess({
      request: launch,
      onOutput: (stream, bytes) => output[stream].push(bytes),
    });
    const startError = await handle.started.then(
      () => undefined,
      (error: unknown) => error as { code?: string },
    );
    const exit = await handle.exited;
    return {
      handle,
      startError,
      exit,
      stdout: Buffer.concat(output.stdout).toString(),
      stderr: Buffer.concat(output.stderr).toString(),
    };
  };
  return { worker, root, client, launcher, request, run };
}

describe("command worker", () => {
  it("runs a process with only the server's environment and streams its output in order", async () => {
    process.env.WORKER_PRIVATE = "must-not-leak";
    cleanup.push(async () => {
      delete process.env.WORKER_PRIVATE;
    });
    const test = await fixture();
    const result = await test.run(
      test.request(
        'pwd; echo "$MARKER"; echo "[$WORKER_PRIVATE]"; echo oops >&2; head -c 300000 /dev/zero | tr "\\0" x; exit 3',
      ),
    );
    expect(result.startError).toBeUndefined();
    expect(result.exit).toEqual({ exitCode: 3 });
    const [cwd, marker, leaked, bulk] = result.stdout.split("\n");
    expect(cwd).toBe(path.join(test.root, "home"));
    expect(marker).toBe("from-server");
    expect(leaked).toBe("[]");
    expect(bulk).toHaveLength(300_000);
    expect(result.stderr).toBe("oops\n");
  });

  it("stops the whole process group on SIGTERM", async () => {
    const test = await fixture();
    const handle = test.launcher.launchProcess({
      request: test.request("sleep 30 & sleep 30; wait"),
      onOutput: () => undefined,
    });
    await handle.started;
    expect(handle.signal("SIGTERM")).toBe(true);
    await expect(handle.exited).resolves.toEqual({ signal: "SIGTERM" });
    expect(handle.signal("SIGKILL")).toBe(true);
  });

  it("reports launch failures as coded errors", async () => {
    const test = await fixture();
    const missing = await test.run(
      test.request("", { executable: "/nonexistent/shell" }),
    );
    expect(missing.startError?.code).toBe("ENOENT");
    const outside = await test.run(test.request("pwd", { cwd: os.tmpdir() }));
    expect(outside.startError?.code).toBe("cwd_outside_roots");
    // A symlinked path is not canonical, even when it points inside a root.
    const link = path.join(test.root, "link");
    await fs.symlink(path.join(test.root, "home"), link);
    const linked = await test.run(test.request("pwd", { cwd: link }));
    expect(linked.startError?.code).toBe("cwd_outside_roots");
    const relative = await test.run(
      test.request("", { executable: "sh" as string }),
    );
    expect(relative.startError?.code).toBe("executable_invalid");
  });

  it("refuses a wrong token and reports an unreachable worker", async () => {
    const test = await fixture();
    const wrong = createCommandWorkerLauncher(test.client("wrong-token"));
    const refused = await test.run(test.request("echo hi"), wrong);
    expect(refused.startError?.code).toBe("unauthorized");
    expect(refused.stdout).toBe("");
    await expect(pingCommandWorker(test.client())).resolves.toEqual({
      ok: true,
    });
    await expect(
      pingCommandWorker(test.client("wrong-token")),
    ).resolves.toEqual({ ok: false, code: "unauthorized" });
    await test.worker.close();
    await expect(pingCommandWorker(test.client())).resolves.toMatchObject({
      ok: false,
      code: "worker_ECONNREFUSED",
    });
  });

  it("answers whether a binary can run on the worker, and the server asks it there", async () => {
    const test = await fixture();
    await expect(
      canExecuteOnCommandWorker(test.client(), "/bin/sh"),
    ).resolves.toBe(true);
    for (const target of ["/nonexistent/rg", "/bin", "relative/rg"]) {
      await expect(
        canExecuteOnCommandWorker(test.client(), target),
      ).resolves.toBe(false);
    }
    await expect(
      canExecuteOnCommandWorker(test.client("wrong-token"), "/bin/sh"),
    ).resolves.toBe(false);

    const { executionBackend, commands } = commandHostOptions(
      {
        commandWorker: {
          host: "127.0.0.1",
          port: test.worker.port,
          token: { file: "/unused" },
          shell: "/bin/bash",
        },
      },
      test.client(),
    );
    expect(commands).toMatchObject({
      enabled: true,
      shellExecutable: "/bin/bash",
    });
    await expect(
      executionBackend!.fileSystem.canExecute("/bin/sh"),
    ).resolves.toBe(true);
    // Files stay local, but "can it run" follows the processes to the worker.
    await test.worker.close();
    await expect(
      executionBackend!.fileSystem.canExecute("/bin/sh"),
    ).resolves.toBe(false);
    await expect(
      executionBackend!.fileSystem.realpath(test.root),
    ).resolves.toBe(test.root);
    expect(commandHostOptions({}, undefined)).toEqual({});
  });

  it("kills the process when the server connection drops", async () => {
    const test = await fixture();
    const marker = path.join(test.root, "home", "survived");
    // Speak the protocol directly so the connection can be cut mid-run.
    const socket = net.connect({ host: "127.0.0.1", port: test.worker.port });
    await new Promise((resolve) => socket.once("connect", resolve));
    const started = new Promise((resolve) =>
      socket.on("data", (chunk) => {
        if (chunk.toString().includes('"started"')) resolve(undefined);
      }),
    );
    socket.write(
      `${JSON.stringify({
        type: "launch",
        protocol: 1,
        token: TOKEN,
        request: test.request(`sleep 1; touch ${marker}`),
      })}\n`,
    );
    await started;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("refuses connections from its own machine unless told otherwise", async () => {
    // A command running on the worker can read the token; it must not be
    // able to use it to launch more commands without approval.
    const test = await fixture({ allowLocalPeers: false });
    await expect(pingCommandWorker(test.client())).resolves.toMatchObject({
      ok: false,
    });
    const refused = await test.run(test.request("echo hi"));
    expect(refused.startError).toBeDefined();
    expect(refused.stdout).toBe("");
  });

  it("kills background jobs left in the process group when the command exits", async () => {
    const test = await fixture();
    const result = await test.run(
      test.request("sleep 30 >/dev/null 2>&1 & echo $!"),
    );
    expect(result.exit).toEqual({ exitCode: 0 });
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 40 && alive(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive()).toBe(false);
  });

  it("closes promptly while a command is still running", async () => {
    const test = await fixture();
    const handle = test.launcher.launchProcess({
      request: test.request("sleep 30"),
      onOutput: () => undefined,
    });
    await handle.started;
    await test.worker.close();
    await expect(handle.exited).resolves.toBeDefined();
  });

  it("rejects an oversized frame before parsing it", () => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
    }) as unknown as Socket;
    const frames: unknown[] = [];
    const errors: string[] = [];
    readFrames(
      socket,
      (frame) => frames.push(frame),
      (code) => errors.push(code),
    );
    const huge = JSON.stringify({
      type: "ping",
      padding: "x".repeat(MAX_COMMAND_WORKER_FRAME_BYTES),
    });
    socket.emit("data", Buffer.from(`${huge}\n`));
    expect(frames).toEqual([]);
    expect(errors).toEqual(["frame_too_large"]);
  });

  it("drops a connection that never authenticates and limits concurrency", async () => {
    const test = await fixture({ maxProcesses: 1 });
    const idle = net.connect({ host: "127.0.0.1", port: test.worker.port });
    await new Promise((resolve) => idle.once("close", resolve));

    const first = test.launcher.launchProcess({
      request: test.request("sleep 5"),
      onOutput: () => undefined,
    });
    await first.started;
    const second = await test.run(test.request("echo hi"));
    expect(second.startError?.code).toBe("worker_busy");
    first.signal("SIGKILL");
    await expect(first.exited).resolves.toEqual({ signal: "SIGKILL" });
  });
});

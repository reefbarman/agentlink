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
  writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SandboxHelperClient } from "./SandboxHelperClient.js";
import type { SandboxHelperLaunchRequest } from "./sandboxHelperProtocol.js";
import { SandboxPreparationError } from "./SandboxPreparationError.js";
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
  const networkDecisions: Array<[string, string]> = [];
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
        respondToNetworkRequest: (requestId, decision) => {
          networkDecisions.push([requestId, decision]);
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
    networkDecisions,
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

  it("opts into the public proxy with a consumed grant and asks per destination", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const privateRoot = await temporaryDirectory("al-sbx-private-");
    const fake = fakeRuntime();
    const asked: string[] = [];
    const handle = launchSandboxedProcess(
      {
        runtime: fake.runtime,
        writableRoots: [root],
        privateDirectoryPrefix: path.join(privateRoot, "p-"),
      },
      {
        sessionId: "session-net",
        command: "npm view left-pad",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
        publicNetwork: {
          onNetworkRequest: async (destination) => {
            asked.push(destination.host);
            return destination.host === "registry.npmjs.org"
              ? "allow-once"
              : "reject";
          },
        },
      },
      () => undefined,
    );
    const metadata = await handle.started;
    expect(fake.launches[0]!.network).toEqual({ mode: "public-proxy" });
    expect(metadata.capabilities.network).toBe("proxy-only");
    const destination = (requestId: string, host: string) => ({
      type: "network-request" as const,
      request: {
        requestId,
        host,
        protocol: "https" as const,
        port: 443,
        address: "104.16.0.1",
        family: 4 as const,
        dnsAnswers: [{ address: "104.16.0.1", family: 4 as const }],
        destinationClass: "public" as const,
      },
    });
    fake.emit(destination("n-1", "registry.npmjs.org"));
    fake.emit(destination("n-2", "evil.example"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual(["registry.npmjs.org", "evil.example"]);
    expect(fake.networkDecisions).toEqual([
      ["n-1", "allow-once"],
      ["n-2", "reject"],
    ]);
    fake.finish({ exitCode: 0, timedOut: false });
    await handle.exited;
  });

  it("lets a launcher with allowLocalBinding listen on local ports", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const fake = fakeRuntime();
    const handle = launchSandboxedProcess(
      { runtime: fake.runtime, writableRoots: [root], allowLocalBinding: true },
      {
        sessionId: "session-bind",
        command: "node server.js",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
      },
      () => undefined,
    );
    const metadata = await handle.started;
    expect(fake.launches[0]!.network).toEqual({
      mode: "loopback",
      allowLocalBinding: true,
    });
    expect(metadata.capabilities.network).toBe("loopback-listener");
    fake.finish({ exitCode: 0, timedOut: false });
    await handle.exited;
  });

  it("rejects network requests from a launch without the public proxy", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const fake = fakeRuntime();
    const handle = launchSandboxedProcess(
      { runtime: fake.runtime, writableRoots: [root] },
      {
        sessionId: "session-offline",
        command: "true",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
      },
      () => undefined,
    );
    await handle.started;
    expect(fake.launches[0]!.network).toEqual({ mode: "loopback" });
    fake.emit({
      type: "network-request",
      request: {
        requestId: "n-1",
        host: "example.com",
        protocol: "https",
        port: 443,
        address: "93.184.216.34",
        family: 4,
        dnsAnswers: [{ address: "93.184.216.34", family: 4 }],
        destinationClass: "public",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.networkDecisions).toEqual([["n-1", "reject"]]);
    fake.finish({ exitCode: 0, timedOut: false });
    await handle.exited;
  });

  it("reports the bubblewrap backend and its limits on Linux", async () => {
    const root = await temporaryDirectory("al-sbx-launch-");
    const privateRoot = await temporaryDirectory("al-sbx-private-");
    const fake = fakeRuntime();
    const handle = launchSandboxedProcess(
      {
        runtime: fake.runtime,
        writableRoots: [root],
        privateDirectoryPrefix: path.join(privateRoot, "p-"),
        platform: "linux",
      },
      {
        sessionId: "session-linux",
        command: "true",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
      },
      () => {},
    );

    const metadata = await handle.started;
    expect(metadata.backend).toBe("bubblewrap");
    // glibc always ships C.UTF-8; en_US.UTF-8 is often missing on Linux.
    expect(fake.launches[0]!.environment).toMatchObject({
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
    expect(metadata.capabilities.backend).toBe("bubblewrap");
    expect(metadata.capabilities.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Loopback is private to the sandbox"),
        expect.stringContaining("Unix socket creation is blocked"),
      ]),
    );
    fake.finish({ exitCode: 0, timedOut: false });
    await handle.exited;
  });

  it.each([
    ["linux", ["/tmp"], ["/tmp/claude"]],
    [
      "darwin",
      ["/tmp", "/private/tmp"],
      ["/tmp/claude", "/private/tmp/claude"],
    ],
  ] as const)(
    "shares only %s temporary roots that exist there",
    async (platform, writable, denied) => {
      const root = await temporaryDirectory("al-sbx-launch-");
      const hostTmp = await temporaryDirectory("al-sbx-hosttmp-");
      const fake = fakeRuntime();
      const handle = launchSandboxedProcess(
        {
          runtime: fake.runtime,
          writableRoots: [root],
          platform,
          shareHostTemporaryDirectories: true,
          hostTemporaryDirectory: hostTmp,
        },
        {
          sessionId: `session-tmp-${platform}`,
          command: "true",
          shell: "/bin/sh",
          cwd: root,
          environment: { PATH: "/usr/bin:/bin" },
        },
        () => {},
      );
      await handle.started;
      const [request] = fake.launches;
      for (const entry of writable) {
        expect(request!.filesystem.allowWrite).toContain(entry);
      }
      for (const entry of denied) {
        expect(request!.filesystem.denyWrite).toContain(entry);
      }
      if (platform === "linux") {
        // The private per-command root may resolve under /private/tmp when
        // this test runs on macOS; only the shared roots matter here.
        const shared = [
          ...request!.filesystem.allowWrite,
          ...request!.filesystem.denyWrite,
        ];
        expect(shared).not.toContain("/private/tmp");
        expect(shared).not.toContain("/private/tmp/claude");
      }
      fake.finish({ exitCode: 0, timedOut: false });
      await handle.exited;
    },
  );

  it("hides denied read roots except the workspace and private directories", async () => {
    const home = await temporaryDirectory("al-sbx-home-");
    const root = path.join(home, "work");
    await mkdir(root);
    const fake = fakeRuntime();
    const handle = launchSandboxedProcess(
      {
        runtime: fake.runtime,
        writableRoots: [root],
        temporaryHome: true,
        deniedReadRoots: [home],
      },
      {
        sessionId: "session-1",
        command: "true",
        shell: "/bin/sh",
        cwd: root,
        environment: { PATH: "/usr/bin:/bin" },
      },
      () => undefined,
    );
    const metadata = await handle.started;
    expect(metadata.capabilities.filesystemRead).toBe("isolated");
    const [request] = fake.launches;
    expect(request!.filesystem.denyRead).toEqual([home]);
    expect(request!.filesystem.allowRead).not.toContain("/");
    expect(request!.filesystem.allowRead).toContain(root);
    expect(
      request!.filesystem.allowRead.some((entry) =>
        request!.environment.HOME!.startsWith(entry),
      ),
    ).toBe(true);
    fake.finish({ exitCode: 0, timedOut: false });
    await handle.exited;
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
    const expectedError = {
      name: "SandboxPreparationError",
      code: "sandbox_preparation_failed",
      reason: "preparation_failed",
      commandStarted: false,
      diagnostic: {
        phase: "working_directory",
        category: "validation_failed",
      },
    };
    await expect(handle.started).rejects.toMatchObject(expectedError);
    const exit = await handle.exited;
    expect(exit.error).toBeInstanceOf(SandboxPreparationError);
    expect(exit.error).toMatchObject(expectedError);
    expect(JSON.stringify(exit.error)).not.toContain(outside);
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
          target: string;
        }): Promise<unknown>;
      };
      await stageSandboxRuntime({
        repoRoot: REPO_ROOT,
        destinationRoot: path.join(extensionRoot, "dist", "sandbox-runtime"),
        target: `darwin-${process.arch}`,
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

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "hides denied read roots through the production helper",
    async () => {
      const extensionRoot = await temporaryDirectory("al-sbx-runtime-");
      const { stageSandboxRuntime } = (await import(
        pathToFileURL(
          path.join(REPO_ROOT, "scripts", "package-sandbox-runtime.mjs"),
        ).href
      )) as {
        stageSandboxRuntime(options: {
          repoRoot: string;
          destinationRoot: string;
          target: string;
          includeNodePty: boolean;
        }): Promise<unknown>;
      };
      await stageSandboxRuntime({
        repoRoot: REPO_ROOT,
        destinationRoot: path.join(extensionRoot, "dist", "sandbox-runtime"),
        target: `darwin-${process.arch}`,
        includeNodePty: false,
      });

      const home = await temporaryDirectory("al-sbx-fake-home-");
      const root = path.join(home, "chat", "work");
      const sibling = path.join(home, "other-chat");
      await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(sibling, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(home, "secret.txt"), "home-secret"),
        writeFile(path.join(sibling, "data.txt"), "sibling-secret"),
        writeFile(path.join(root, "input.txt"), "work-input"),
      ]);
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
          temporaryHome: true,
          deniedReadRoots: [home],
        },
        {
          sessionId: "sandboxed-process-read-denial-test",
          command: [
            "cat input.txt",
            `cat ${JSON.stringify(path.join(home, "secret.txt"))} || echo home-denied >&2`,
            `cat ${JSON.stringify(path.join(sibling, "data.txt"))} || echo sibling-denied >&2`,
            "printf made > out.txt",
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
      expect(output.stdout).toContain("work-input");
      expect(output.stdout).not.toContain("home-secret");
      expect(output.stdout).not.toContain("sibling-secret");
      expect(output.stderr).toContain("home-denied");
      expect(output.stderr).toContain("sibling-denied");
      expect(await readFile(path.join(root, "out.txt"), "utf8")).toBe("made");
    },
    60_000,
  );
});

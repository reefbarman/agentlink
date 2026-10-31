import { EventEmitter, once } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createNodeSandboxHelperTransportFactory,
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  type SandboxHelperChildProcess,
} from "./NodeSandboxHelperTransport.js";
import { SandboxHelperClient } from "./SandboxHelperClient.js";
import {
  MAX_SANDBOX_HELPER_DATA_BYTES,
  MAX_SANDBOX_HELPER_EVENT_FRAME_BYTES,
  SANDBOX_HELPER_PROTOCOL_VERSION,
  type SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";

const extensionRoot = "/Applications/AgentLink Extension";
const helperPath = path.join(
  extensionRoot,
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
);
const nodeExecutable = "/usr/local/bin/node";

class FakeReadable extends EventEmitter {}

class FakeStdin {
  readonly write = vi.fn(() => true);
  readonly end = vi.fn();
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly kill = vi.fn(() => true);

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", code, signal);
  }
}

function regularFile() {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
  } as ReturnType<
    NonNullable<
      Parameters<typeof createNodeSandboxHelperTransportFactory>[0]["lstat"]
    >
  >;
}

function harness(
  overrides: Partial<
    Parameters<typeof createNodeSandboxHelperTransportFactory>[0]
  > = {},
) {
  const child = new FakeChild();
  const spawn = vi.fn(() => child as unknown as SandboxHelperChildProcess);
  const options = {
    extensionRoot,
    platform: "darwin" as const,
    architecture: "arm64",
    nodeExecutable,
    lstat: vi.fn(() => regularFile()),
    realpath: vi.fn((candidate: string) => candidate),
    spawn,
    ...overrides,
  };
  return {
    child,
    factory: createNodeSandboxHelperTransportFactory(options),
    options,
    spawn,
  };
}

describe("NodeSandboxHelperTransport", () => {
  it("spawns the packaged helper with a fixed sanitized environment", () => {
    const test = harness();
    const transport = test.factory.create();

    expect(test.spawn).toHaveBeenCalledWith(nodeExecutable, [helperPath], {
      cwd: path.dirname(path.dirname(helperPath)),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
      detached: false,
      shell: false,
      windowsHide: true,
    });
    expect(transport.write("frame\n")).toBe(true);
    expect(test.child.stdin.write).toHaveBeenCalledWith("frame\n", "utf8");

    transport.kill();
    expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
    transport.dispose();
    expect(test.child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it("passes a host ripgrep to the Linux helper only", () => {
    const linux = harness({
      platform: "linux",
      architecture: "x64",
      ripgrepPath:
        "/opt/vscode/resources/app/node_modules/@vscode/ripgrep/bin/rg",
    });
    linux.factory.create();
    expect(linux.spawn).toHaveBeenCalledWith(
      nodeExecutable,
      [helperPath],
      expect.objectContaining({
        env: {
          AGENTLINK_SANDBOX_RIPGREP_PATH:
            "/opt/vscode/resources/app/node_modules/@vscode/ripgrep/bin/rg",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
        },
      }),
    );

    const darwin = harness({ ripgrepPath: "/opt/homebrew/bin/rg" });
    darwin.factory.create();
    expect(darwin.spawn).toHaveBeenCalledWith(
      nodeExecutable,
      [helperPath],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
        },
      }),
    );
    expect(
      () => harness({ platform: "linux", ripgrepPath: "rg" }).factory,
    ).toThrow("ripgrepPath must be an absolute path");
  });

  it("closes gracefully before forcing a wedged helper", () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const transport = test.factory.create();

      transport.closeGracefully(2_000);
      expect(test.child.stdin.end).toHaveBeenCalledTimes(1);
      expect(test.child.kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_999);
      expect(test.child.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
      transport.dispose();
      expect(test.child.stdin.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels graceful forced kill when the helper closes", () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const transport = test.factory.create();

      transport.closeGracefully(2_000);
      test.child.emitClose(0, null);
      vi.advanceTimersByTime(2_000);

      expect(test.child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats writable backpressure as an accepted frame", () => {
    const test = harness();
    test.child.stdin.write.mockReturnValue(false);
    const transport = test.factory.create();

    expect(transport.write("large-frame\n")).toBe(true);
    expect(test.child.stdin.write).toHaveBeenCalledWith(
      "large-frame\n",
      "utf8",
    );
    expect(test.child.kill).not.toHaveBeenCalled();
  });

  it("decodes split UTF-8 and multiple newline-delimited frames", () => {
    const test = harness();
    const transport = test.factory.create();
    const lines = vi.fn();
    transport.onLine(lines);

    const bytes = Buffer.from('{"data":"€"}\n{"data":"two"}\n', "utf8");
    const euroStart = bytes.indexOf(Buffer.from("€"));
    test.child.stdout.emit("data", bytes.subarray(0, euroStart + 1));
    test.child.stdout.emit("data", bytes.subarray(euroStart + 1));

    expect(lines.mock.calls.map(([line]) => line)).toEqual([
      '{"data":"€"}',
      '{"data":"two"}',
    ]);
  });

  it("kills the helper when one unterminated frame exceeds the bound", () => {
    const test = harness();
    const transport = test.factory.create();
    const errors = vi.fn();
    transport.onError(errors);

    test.child.stdout.emit(
      "data",
      Buffer.alloc(MAX_SANDBOX_HELPER_EVENT_FRAME_BYTES + 1, "x"),
    );

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sandbox helper output frame exceeds maximum size",
      }),
    );
    expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("adds bounded stderr context to protocol errors", () => {
    const test = harness();
    const transport = test.factory.create();
    const errors = vi.fn();
    transport.onError(errors);

    test.child.stderr.emit("data", Buffer.alloc(70 * 1024, "e"));
    test.child.stdout.emit(
      "data",
      Buffer.alloc(MAX_SANDBOX_HELPER_EVENT_FRAME_BYTES + 1, "x"),
    );

    const error = errors.mock.calls[0][0] as Error;
    expect(error.message).toContain("Sandbox helper output frame exceeds");
    expect(Buffer.byteLength(error.message)).toBeLessThan(66 * 1024);
  });

  it("includes bounded stderr context in close events", () => {
    const test = harness();
    const transport = test.factory.create();
    const closes = vi.fn();
    transport.onClose(closes);

    test.child.stderr.emit("data", "native helper failed\n");
    test.child.emitClose(null, "SIGTRAP");

    expect(closes).toHaveBeenCalledWith({
      exitCode: null,
      signal: "SIGTRAP",
      stderr: "native helper failed",
    });
  });

  it("reports an incomplete final frame before close", () => {
    const test = harness();
    const transport = test.factory.create();
    const errors = vi.fn();
    const closes = vi.fn();
    transport.onError(errors);
    transport.onClose(closes);

    test.child.stdout.emit("data", Buffer.from('{"partial":true'));
    test.child.emitClose(1, null);

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sandbox helper closed with an incomplete frame",
      }),
    );
    expect(closes).toHaveBeenCalledWith({ exitCode: 1, signal: null });
    expect(transport.write("after close")).toBe(false);
  });

  it("requires an explicit standalone Node executable", () => {
    expect(() =>
      createNodeSandboxHelperTransportFactory({
        extensionRoot,
        platform: "darwin",
        architecture: "arm64",
        nodeExecutable: "" as never,
        lstat: vi.fn(() => regularFile()),
        realpath: vi.fn((candidate: string) => candidate),
      }),
    ).toThrow("nodeExecutable must be an absolute path");
  });

  describe("process output through the real transport and client", () => {
    const launchRequest: SandboxHelperLaunchRequest = {
      version: SANDBOX_HELPER_PROTOCOL_VERSION,
      type: "launch",
      channelId: "channel-1",
      commandId: "command-1",
      generation: 1,
      command: "xcrun metal -c shader.metal",
      cwd: "/workspace",
      shell: "/bin/zsh",
      environment: { HOME: "/private/tmp/home" },
      filesystem: {
        denyRead: [],
        allowRead: ["/workspace"],
        allowWrite: ["/workspace"],
        denyWrite: [],
      },
      network: { mode: "loopback" },
      protectedRoots: [],
      structurallyProtectedRoots: [],
      dimensions: { columns: 80, rows: 24 },
      stdio: "pipe",
    };

    /** Decode raw child bytes exactly as the helper does (`setEncoding("utf8")`). */
    async function decodeLikeHelper(chunks: Buffer[]): Promise<string[]> {
      const stream = new PassThrough();
      stream.setEncoding("utf8");
      const decoded: string[] = [];
      stream.on("data", (chunk: string) => decoded.push(chunk));
      for (const chunk of chunks) stream.write(chunk);
      stream.end();
      await once(stream, "end");
      return decoded;
    }

    /** Run helper-serialized frames through the real transport and client. */
    async function runThroughClient(
      frames: Array<Record<string, unknown>>,
      chunkBytes: number,
    ) {
      const test = harness();
      const client = new SandboxHelperClient(test.factory);
      const commandProcess = client.launch(launchRequest);
      const output: string[] = [];
      commandProcess.onEvent((event) => {
        if (event.type === "data") output.push(event.data);
      });
      const identity = commandProcess.identity;
      // The helper serializes each frame with JSON.stringify plus a newline.
      const bytes = Buffer.from(
        frames
          .map((frame) => `${JSON.stringify({ ...identity, ...frame })}\n`)
          .join(""),
        "utf8",
      );
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        test.child.stdout.emit(
          "data",
          bytes.subarray(offset, offset + chunkBytes),
        );
      }
      const completion = await commandProcess.completion;
      await Promise.resolve();
      test.child.emitClose(0, null);
      return { completion, output: output.join(""), child: test.child };
    }

    it("preserves exit status for NUL, control, invalid and split UTF-8 output", async () => {
      const euro = Buffer.from("€", "utf8");
      const emoji = Buffer.from("😀", "utf8");
      const rawChunks = [
        Buffer.from("build/v1_baseline.metallib:1:1: ", "utf8"),
        // Binary container bytes: magic, NUL, C0 controls, ESC, BEL, DEL,
        // invalid UTF-8 and a truncated lead byte.
        Buffer.from([
          0x4d, 0x54, 0x4c, 0x42, 0x00, 0x01, 0x1b, 0x07, 0x7f, 0xff, 0xfe,
          0xc3,
        ]),
        // Multibyte characters split across child output chunks.
        euro.subarray(0, 1),
        euro.subarray(1),
        emoji.subarray(0, 2),
        Buffer.concat([emoji.subarray(2), Buffer.from("\0 error\n", "utf8")]),
      ];
      const decoded = await decodeLikeHelper(rawChunks);
      const expected = decoded.join("");
      expect(expected).toContain("\0");
      expect(expected).toContain("\uFFFD");
      expect(expected).toContain("€😀");

      // Odd chunk sizes also split the multibyte characters inside frames.
      for (const chunkBytes of [1, 3, 7, 4096]) {
        const result = await runThroughClient(
          [
            { type: "ready", pid: 77, pgid: 77, backend: "seatbelt" },
            ...decoded.map((data) => ({
              type: "data",
              data,
              stream: "stderr",
            })),
            { type: "exit", exitCode: 1, timedOut: false },
          ],
          chunkBytes,
        );
        expect(result.completion).toEqual({ exitCode: 1, timedOut: false });
        expect(result.output).toBe(expected);
        expect(result.child.kill).not.toHaveBeenCalled();
      }
    });

    it("accepts a maximum-size output chunk at worst-case JSON escaping", async () => {
      const data = "\u0001".repeat(MAX_SANDBOX_HELPER_DATA_BYTES);
      expect(
        Buffer.byteLength(JSON.stringify({ data }), "utf8"),
      ).toBeGreaterThan(5 * MAX_SANDBOX_HELPER_DATA_BYTES);

      const result = await runThroughClient(
        [
          { type: "ready", pid: 77, pgid: 77, backend: "seatbelt" },
          { type: "data", data, stream: "stdout" },
          { type: "exit", exitCode: 0, timedOut: false },
        ],
        64 * 1024,
      );

      expect(result.completion).toEqual({ exitCode: 0, timedOut: false });
      expect(result.output).toBe(data);
      expect(result.child.kill).not.toHaveBeenCalled();
    });

    it("still fails closed on a genuinely malformed frame", async () => {
      const test = harness();
      const client = new SandboxHelperClient(test.factory);
      const commandProcess = client.launch(launchRequest);
      const failure = commandProcess.completion.catch(
        (error: unknown) => error,
      );
      const identity = commandProcess.identity;
      test.child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ ...identity, type: "ready", pid: 77, pgid: 77, backend: "seatbelt" })}\n${JSON.stringify({ ...identity, type: "data", data: "\0ok", authority: "host" })}\n`,
        ),
      );

      expect(await failure).toMatchObject({
        message: "Sandbox helper emitted an invalid event frame",
        category: "protocol_validation",
      });
      expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  it("rejects unsupported hosts, missing/symlinked helpers, and path escape", () => {
    expect(() => harness({ platform: "win32" }).factory).toThrow(
      "supports local macOS and Linux only",
    );
    expect(() => harness({ architecture: "riscv64" }).factory).toThrow(
      "does not support architecture riscv64",
    );
    expect(
      () =>
        harness({
          lstat: () => {
            throw new Error("missing");
          },
        }).factory,
    ).toThrow("is missing");
    expect(
      () =>
        harness({
          lstat: () =>
            ({
              isSymbolicLink: () => true,
              isFile: () => true,
            }) as ReturnType<
              NonNullable<
                Parameters<
                  typeof createNodeSandboxHelperTransportFactory
                >[0]["lstat"]
              >
            >,
        }).factory,
    ).toThrow("regular non-symlink file");
    expect(
      () =>
        harness({
          realpath: (candidate) =>
            candidate === helperPath ? "/tmp/untrusted-helper.mjs" : candidate,
        }).factory,
    ).toThrow("must resolve inside the extension root");
  });
});

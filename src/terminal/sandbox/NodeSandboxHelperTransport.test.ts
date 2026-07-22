import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createNodeSandboxHelperTransportFactory,
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  type SandboxHelperChildProcess,
} from "./NodeSandboxHelperTransport.js";
import { MAX_SANDBOX_HELPER_FRAME_BYTES } from "./sandboxHelperProtocol.js";

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
      Buffer.alloc(MAX_SANDBOX_HELPER_FRAME_BYTES + 1, "x"),
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
      Buffer.alloc(MAX_SANDBOX_HELPER_FRAME_BYTES + 1, "x"),
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

  it("rejects unsupported hosts, missing/symlinked helpers, and path escape", () => {
    expect(() => harness({ platform: "linux" }).factory).toThrow(
      "supports local macOS only",
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

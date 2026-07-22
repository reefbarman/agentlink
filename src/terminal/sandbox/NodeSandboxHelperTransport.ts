import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { spawn } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { MAX_SANDBOX_HELPER_FRAME_BYTES } from "./sandboxHelperProtocol.js";
import type {
  SandboxHelperTransport,
  SandboxHelperTransportFactory,
} from "./SandboxHelperClient.js";
import type { SandboxCommandDisposable } from "./SandboxRuntimeProvider.js";

export const SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH = path.join(
  "dist",
  "sandbox-runtime",
  "scripts",
  "sandbox-interactive-helper.mjs",
);
const MAX_STDERR_BYTES = 64 * 1024;

export interface SandboxHelperChildProcess {
  stdin: ChildProcessWithoutNullStreams["stdin"];
  stdout: ChildProcessWithoutNullStreams["stdout"];
  stderr: ChildProcessWithoutNullStreams["stderr"];
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface NodeSandboxHelperTransportOptions {
  extensionRoot: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  nodeExecutable: string;
  lstat?: (filePath: string) => Stats;
  realpath?: (filePath: string) => string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => SandboxHelperChildProcess;
}

function assertAbsolutePath(value: string, label: string): string {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path without NUL`);
  }
  return path.resolve(value);
}

function assertOwnedFile(
  filePath: string,
  label: string,
  lstat: (filePath: string) => Stats,
): void {
  let metadata: Stats;
  try {
    metadata = lstat(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
}

function assertSupportedHost(
  platform: NodeJS.Platform,
  architecture: string,
): void {
  if (platform !== "darwin") {
    throw new Error("The interactive sandbox helper supports local macOS only");
  }
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(
      `The interactive sandbox helper does not support architecture ${architecture}`,
    );
  }
}

class NodeSandboxHelperTransport implements SandboxHelperTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<
    (event: {
      exitCode: number | null;
      signal: string | null;
      stderr?: string;
    }) => void
  >();
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  private stderr = "";
  private stderrBytes = 0;
  private closed = false;
  private disposed = false;

  constructor(private readonly child: SandboxHelperChildProcess) {
    child.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.onStderr(chunk));
    child.once("error", (error) => this.emitError(error));
    child.once("close", (exitCode, signal) => {
      if (this.closed) return;
      this.closed = true;
      const tail = this.decoder.end();
      if (tail) this.appendDecoded(tail);
      if (this.pending.length > 0) {
        this.emitError(
          new Error("Sandbox helper closed with an incomplete frame"),
        );
      }
      const stderr = this.stderr.trim();
      for (const listener of this.closeListeners) {
        listener({
          exitCode,
          signal: signal ?? null,
          ...(stderr ? { stderr } : {}),
        });
      }
    });
  }

  write(data: string): boolean {
    if (this.disposed || this.closed) return false;
    this.child.stdin.write(data, "utf8");
    return true;
  }

  onLine(listener: (line: string) => void): SandboxCommandDisposable {
    this.lineListeners.add(listener);
    return { dispose: () => this.lineListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void): SandboxCommandDisposable {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  onClose(
    listener: (event: {
      exitCode: number | null;
      signal: string | null;
      stderr?: string;
    }) => void,
  ): SandboxCommandDisposable {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  kill(): void {
    if (this.closed) return;
    this.child.kill("SIGKILL");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdin.end();
    this.lineListeners.clear();
    this.errorListeners.clear();
    this.closeListeners.clear();
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.disposed || this.closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.appendDecoded(this.decoder.write(bytes));
  }

  private appendDecoded(decoded: string): void {
    this.pending += decoded;

    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline === -1) {
        if (
          Buffer.byteLength(this.pending, "utf8") >
          MAX_SANDBOX_HELPER_FRAME_BYTES
        ) {
          this.protocolFailure(
            "Sandbox helper output frame exceeds maximum size",
          );
        }
        return;
      }
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);

      if (Buffer.byteLength(line, "utf8") > MAX_SANDBOX_HELPER_FRAME_BYTES) {
        this.protocolFailure(
          "Sandbox helper output frame exceeds maximum size",
        );
        return;
      }
      for (const listener of this.lineListeners) listener(line);
    }
  }

  private onStderr(chunk: Buffer | string): void {
    if (this.disposed || this.closed || this.stderrBytes >= MAX_STDERR_BYTES)
      return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const remaining = MAX_STDERR_BYTES - this.stderrBytes;
    const bytes = Buffer.from(text, "utf8");
    const accepted = bytes.subarray(0, remaining);
    this.stderr += accepted.toString("utf8");
    this.stderrBytes += accepted.byteLength;
  }

  private protocolFailure(message: string): void {
    const detail = this.stderr.trim();
    this.emitError(new Error(detail ? `${message}: ${detail}` : message));
    this.kill();
  }

  private emitError(error: Error): void {
    if (this.disposed) return;
    const detail = this.stderr.trim();
    const enriched =
      detail && !error.message.includes(detail)
        ? new Error(`${error.message}: ${detail}`, { cause: error })
        : error;
    for (const listener of this.errorListeners) listener(enriched);
  }
}

export function createNodeSandboxHelperTransportFactory(
  options: NodeSandboxHelperTransportOptions,
): SandboxHelperTransportFactory {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  assertSupportedHost(platform, architecture);

  const extensionRoot = assertAbsolutePath(
    options.extensionRoot,
    "extensionRoot",
  );
  const nodeExecutable = assertAbsolutePath(
    options.nodeExecutable,
    "nodeExecutable",
  );
  const helperPath = path.join(
    extensionRoot,
    SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  );
  const lstat = options.lstat ?? lstatSync;
  const realpath = options.realpath ?? realpathSync;
  assertOwnedFile(helperPath, "Packaged interactive sandbox helper", lstat);
  assertOwnedFile(nodeExecutable, "Node executable", lstat);
  const realExtensionRoot = realpath(extensionRoot);
  const realHelperPath = realpath(helperPath);
  if (
    realHelperPath !== realExtensionRoot &&
    !realHelperPath.startsWith(`${realExtensionRoot}${path.sep}`)
  ) {
    throw new Error(
      "Packaged interactive sandbox helper must resolve inside the extension root",
    );
  }
  const runtimeRoot = path.dirname(path.dirname(realHelperPath));

  const spawnChild =
    options.spawn ??
    ((command, args, spawnOptions) =>
      spawn(command, args, {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams);

  return {
    create(): SandboxHelperTransport {
      const child = spawnChild(nodeExecutable, [realHelperPath], {
        cwd: runtimeRoot,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
        },
        detached: false,
        shell: false,
        windowsHide: true,
      });
      return new NodeSandboxHelperTransport(child);
    },
  };
}

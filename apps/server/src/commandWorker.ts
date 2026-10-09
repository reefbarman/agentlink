import { spawn, type ChildProcess } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  COMMAND_WORKER_PROTOCOL,
  readFrames,
  tokensMatch,
  writeFrame,
  type CommandWorkerServerFrame,
} from "./commandWorkerProtocol.js";

/**
 * The command worker runs approved processes for the assistant server in a
 * separate container. It trusts the server's decisions (the server prepares,
 * approves, records, and redacts every launch) but only after the shared
 * token, and it never forwards its own environment: each process gets exactly
 * the environment the server sent. Working directories must already be
 * canonical and inside a configured root.
 */
export interface CommandWorkerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Absolute directories processes may run in, as seen by this worker. */
  readonly roots: readonly string[];
  readonly maxProcesses?: number;
  /** How long a connection may stay silent before its first frame. */
  readonly handshakeTimeoutMs?: number;
  /**
   * Accept connections from this machine's own addresses. Off by default:
   * commands run here and can read the token, so a connection that comes
   * from inside the worker's own network namespace is a command trying to
   * launch more commands without approval. Turn it on only when the server
   * runs on the same host without a container boundary.
   */
  readonly allowLocalPeers?: boolean;
  /**
   * Kill every other process this user can signal whenever no command is
   * running, so a command that escaped its process group (`setsid`, double
   * fork) cannot outlive it. Only for a worker that is alone in its
   * container: elsewhere this would kill unrelated processes.
   */
  readonly reapOrphans?: boolean;
  readonly log?: (line: string) => void;
}

export interface CommandWorker {
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PROCESSES = 16;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_ARGS = 1_024;
const MAX_ARG_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 512;

export async function startCommandWorker(
  options: CommandWorkerOptions,
): Promise<CommandWorker> {
  if (!options.token.trim()) throw new Error("Command worker token is empty");
  if (options.roots.length === 0) {
    throw new Error("Command worker needs at least one --root");
  }
  const roots: string[] = [];
  for (const root of options.roots) {
    if (!path.isAbsolute(root)) {
      throw new Error(`Command worker root must be absolute: ${root}`);
    }
    roots.push(await fs.realpath(root));
  }
  const maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
  const handshakeTimeoutMs =
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const live = new Set<ChildProcess>();
  const sockets = new Set<Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (!options.allowLocalPeers && isLocalPeer(socket.remoteAddress)) {
      options.log?.("command worker: rejected a connection from this machine");
      socket.destroy();
      return;
    }
    handleConnection(socket);
  });

  const reapOrphans = () => {
    if (!options.reapOrphans || live.size > 0) return;
    try {
      // Every process this user may signal except this one (and init).
      process.kill(-1, "SIGKILL");
    } catch {
      // Nothing else is running.
    }
  };

  function handleConnection(socket: Socket): void {
    let child: ChildProcess | undefined;
    let exited = false;
    let authenticated = false;
    const send = (frame: CommandWorkerServerFrame) => writeFrame(socket, frame);
    const reject = (code: string) => {
      send({ type: "error", code });
      socket.end();
    };
    const handshake = setTimeout(() => {
      if (!authenticated) socket.destroy();
    }, handshakeTimeoutMs);
    handshake.unref();
    socket.once("close", () => {
      clearTimeout(handshake);
      // The server went away: nothing can observe or stop this process now.
      if (child && !exited) killGroup(child, "SIGKILL");
    });

    readFrames(
      socket,
      (frame) => {
        if (!authenticated) {
          clearTimeout(handshake);
          if (
            (frame.type !== "launch" &&
              frame.type !== "ping" &&
              frame.type !== "probe") ||
            frame.protocol !== COMMAND_WORKER_PROTOCOL
          ) {
            reject("protocol_unsupported");
            return;
          }
          if (!tokensMatch(options.token, frame.token)) {
            options.log?.(
              "command worker: rejected a connection with a bad token",
            );
            reject("unauthorized");
            return;
          }
          authenticated = true;
          if (frame.type === "ping") {
            send({ type: "pong", protocol: COMMAND_WORKER_PROTOCOL });
            socket.end();
            return;
          }
          if (frame.type === "probe") {
            void canExecute(frame.path).then((executable) => {
              send({ type: "probe_result", executable });
              socket.end();
            });
            return;
          }
          void launch(frame.request);
          return;
        }
        if (frame.type === "signal" && child && !exited) {
          if (frame.signal === "SIGTERM" || frame.signal === "SIGKILL") {
            killGroup(child, frame.signal);
          }
          return;
        }
        reject("frame_unexpected");
      },
      (code) => reject(code),
    );

    async function launch(request: unknown): Promise<void> {
      const valid = await validateRequest(request, roots);
      if (!valid.ok) {
        send({ type: "launch_failed", code: valid.code });
        socket.end();
        return;
      }
      if (live.size >= maxProcesses) {
        send({ type: "launch_failed", code: "worker_busy" });
        socket.end();
        return;
      }
      if (socket.destroyed) return;
      const { executable, args, cwd, environment } = valid.request;
      const process_ = spawn(executable, args, {
        cwd,
        env: environment,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = process_;
      live.add(process_);
      process_.once("spawn", () => send({ type: "started" }));
      process_.once("error", (error) => {
        if (process_.pid === undefined) {
          exited = true;
          live.delete(process_);
          send({ type: "launch_failed", code: errorCode(error) ?? "unknown" });
          socket.end();
        }
      });
      let paused = false;
      const forward = (stream: "stdout" | "stderr") => (bytes: Buffer) => {
        const flushed = send({
          type: "output",
          stream,
          data: Buffer.from(bytes).toString("base64"),
        });
        // Backpressure: stop reading the process until the server catches up.
        if (!flushed && !paused && !socket.destroyed) {
          paused = true;
          process_.stdout?.pause();
          process_.stderr?.pause();
          socket.once("drain", () => {
            paused = false;
            process_.stdout?.resume();
            process_.stderr?.resume();
          });
        }
      };
      process_.stdout?.on("data", forward("stdout"));
      process_.stderr?.on("data", forward("stderr"));
      // `close` follows the last output, so the exit frame is always last.
      process_.once("close", (code, signal) => {
        exited = true;
        live.delete(process_);
        if (process_.pid === undefined) return;
        // Background jobs the command left in its process group end with it.
        killGroup(process_, "SIGKILL");
        reapOrphans();
        send({
          type: "exit",
          ...(code !== null ? { exitCode: code } : {}),
          ...(signal !== null ? { signal } : {}),
        });
        socket.end();
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= (async () => {
        // Stop accepting first; the callback runs once every connection has
        // closed, which only happens after the commands and sockets go.
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        for (const process_ of live) killGroup(process_, "SIGKILL");
        for (const socket of sockets) socket.destroy();
        await closed;
      })();
      return closing;
    },
  };
}

interface ValidatedRequest {
  readonly executable: string;
  readonly args: string[];
  readonly cwd: string;
  readonly environment: Record<string, string>;
}

async function validateRequest(
  value: unknown,
  roots: readonly string[],
): Promise<
  | { readonly ok: true; readonly request: ValidatedRequest }
  | { readonly ok: false; readonly code: string }
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "request_invalid" };
  }
  const request = value as Record<string, unknown>;
  if (request.schemaVersion !== 1) {
    return { ok: false, code: "request_version_unsupported" };
  }
  const { executable, args, cwd, environment } = request;
  if (
    typeof executable !== "string" ||
    !path.isAbsolute(executable) ||
    executable.includes("\0")
  ) {
    return { ok: false, code: "executable_invalid" };
  }
  if (
    !Array.isArray(args) ||
    args.length > MAX_ARGS ||
    !args.every(
      (arg) =>
        typeof arg === "string" &&
        !arg.includes("\0") &&
        Buffer.byteLength(arg) <= MAX_ARG_BYTES,
    )
  ) {
    return { ok: false, code: "args_invalid" };
  }
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.keys(environment).length > MAX_ENVIRONMENT_ENTRIES ||
    !Object.entries(environment).every(
      ([key, entry]) =>
        key.length > 0 &&
        !key.includes("=") &&
        !key.includes("\0") &&
        typeof entry === "string" &&
        !entry.includes("\0"),
    )
  ) {
    return { ok: false, code: "environment_invalid" };
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    return { ok: false, code: "cwd_invalid" };
  }
  // The server sends host-canonical paths; the same mount must resolve to
  // the same place here, inside a root, with no symlink indirection.
  const canonical = await fs.realpath(cwd).catch(() => undefined);
  if (canonical !== cwd || !roots.some((root) => isWithin(root, canonical))) {
    return { ok: false, code: "cwd_outside_roots" };
  }
  return {
    ok: true,
    request: {
      executable,
      args: [...(args as string[])],
      cwd: canonical,
      environment: { ...(environment as Record<string, string>) },
    },
  };
}

async function canExecute(target: unknown): Promise<boolean> {
  if (
    typeof target !== "string" ||
    !path.isAbsolute(target) ||
    target.includes("\0")
  ) {
    return false;
  }
  try {
    await fs.access(target, constants.X_OK);
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Whether a peer address belongs to this machine (loopback or an interface). */
function isLocalPeer(address: string | undefined): boolean {
  if (!address) return true;
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  if (normalized === "::1" || normalized.startsWith("127.")) return true;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address.toLowerCase().replace(/^::ffff:/u, "") === normalized) {
        return true;
      }
    }
  }
  return false;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

import {
  WorkspaceProcessLaunchError,
  type WorkspaceProcessExit,
  type WorkspaceProcessLauncher,
  type WorkspaceProcessSignal,
} from "@agentlink/workspace-host";
import net from "node:net";

import {
  COMMAND_WORKER_PROTOCOL,
  readFrames,
  writeFrame,
  type CommandWorkerClientFrame,
} from "./commandWorkerProtocol.js";

export interface CommandWorkerClientOptions {
  readonly host: string;
  readonly port: number;
  /** Reread on every connection, so a rotated token applies without restart. */
  readonly readToken: () => Promise<string>;
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Process launcher that runs every process on the command worker. One
 * connection per process; closing it makes the worker kill the process.
 */
export function createCommandWorkerLauncher(
  options: CommandWorkerClientOptions,
): WorkspaceProcessLauncher {
  return {
    launchProcess({ request, onOutput }) {
      let state: "connecting" | "running" | "exited" = "connecting";
      let socket: net.Socket | undefined;
      let pendingSignal: WorkspaceProcessSignal | undefined;
      let resolveStarted!: () => void;
      let rejectStarted!: (error: Error) => void;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      started.catch(() => undefined);
      let resolveExited!: (exit: WorkspaceProcessExit) => void;
      const exited = new Promise<WorkspaceProcessExit>((resolve) => {
        resolveExited = resolve;
      });

      const failLaunch = (code: string) => {
        if (state !== "connecting") return;
        state = "exited";
        rejectStarted(new WorkspaceProcessLaunchError(code));
        resolveExited({});
        socket?.destroy();
      };
      const finish = (exit: WorkspaceProcessExit) => {
        if (state === "exited") return;
        state = "exited";
        resolveExited(exit);
        socket?.end();
      };

      void (async () => {
        let token: string;
        try {
          token = await options.readToken();
        } catch {
          failLaunch("worker_token_unavailable");
          return;
        }
        if (state !== "connecting") return;
        const connection = net.connect({
          host: options.host,
          port: options.port,
        });
        socket = connection;
        connection.setNoDelay(true);
        const timer = setTimeout(
          () => failLaunch("worker_timeout"),
          options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        );
        timer.unref();
        connection.once("connect", () => {
          writeFrame(connection, {
            type: "launch",
            protocol: COMMAND_WORKER_PROTOCOL,
            token,
            request,
          });
        });
        connection.on("error", (error: NodeJS.ErrnoException) => {
          failLaunch(
            error.code ? `worker_${error.code}` : "worker_unreachable",
          );
        });
        connection.once("close", () => {
          clearTimeout(timer);
          failLaunch("worker_closed");
          // The worker kills the process when the connection drops.
          if (state === "running") finish({ signal: "SIGKILL" });
        });
        readFrames(
          connection,
          (frame) => {
            if (frame.type === "started" && state === "connecting") {
              clearTimeout(timer);
              state = "running";
              resolveStarted();
              if (pendingSignal) {
                writeFrame(connection, {
                  type: "signal",
                  signal: pendingSignal,
                });
              }
            } else if (
              frame.type === "launch_failed" ||
              frame.type === "error"
            ) {
              const code =
                typeof frame.code === "string" ? frame.code : "worker_error";
              if (state === "connecting") failLaunch(code);
              else connection.destroy();
            } else if (frame.type === "output" && state === "running") {
              if (
                (frame.stream === "stdout" || frame.stream === "stderr") &&
                typeof frame.data === "string"
              ) {
                onOutput(frame.stream, Buffer.from(frame.data, "base64"));
              }
            } else if (frame.type === "exit" && state === "running") {
              finish({
                ...(typeof frame.exitCode === "number"
                  ? { exitCode: frame.exitCode }
                  : {}),
                ...(typeof frame.signal === "string"
                  ? { signal: frame.signal as NodeJS.Signals }
                  : {}),
              });
            }
          },
          () => connection.destroy(),
        );
      })();

      return {
        pid: undefined,
        started,
        exited,
        signal(signal) {
          if (state === "exited") return true;
          if (state === "connecting") {
            pendingSignal = signal;
            return true;
          }
          return socket
            ? writeFrame(socket, { type: "signal", signal }) ||
                !socket.destroyed
            : false;
        },
      };
    },
  };
}

type OneShotResult =
  | { readonly ok: true; readonly frame: Record<string, unknown> }
  | { readonly ok: false; readonly code: string };

/** Send one authenticated request frame and read one reply frame. */
async function requestOnce(
  options: CommandWorkerClientOptions,
  frame: (token: string) => CommandWorkerClientFrame,
  expectedType: string,
): Promise<OneShotResult> {
  let token: string;
  try {
    token = await options.readToken();
  } catch {
    return { ok: false, code: "worker_token_unavailable" };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const done = (result: OneShotResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    const connection = net.connect({ host: options.host, port: options.port });
    const timer = setTimeout(
      () => done({ ok: false, code: "worker_timeout" }),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    timer.unref();
    connection.once("connect", () => {
      writeFrame(connection, frame(token));
    });
    connection.on("error", (error: NodeJS.ErrnoException) =>
      done({
        ok: false,
        code: error.code ? `worker_${error.code}` : "worker_unreachable",
      }),
    );
    connection.once("close", () => done({ ok: false, code: "worker_closed" }));
    readFrames(
      connection,
      (reply) => {
        if (reply.type === expectedType) done({ ok: true, frame: reply });
        else
          done({
            ok: false,
            code: typeof reply.code === "string" ? reply.code : "worker_error",
          });
      },
      (code) => done({ ok: false, code }),
    );
  });
}

/** Check the worker is reachable and accepts the token. */
export async function pingCommandWorker(
  options: CommandWorkerClientOptions,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly code: string }
> {
  const result = await requestOnce(
    options,
    (token) => ({ type: "ping", protocol: COMMAND_WORKER_PROTOCOL, token }),
    "pong",
  );
  return result.ok ? { ok: true } : result;
}

/**
 * Whether an absolute path is an executable file on the worker, where the
 * launcher runs processes. False when the worker cannot be asked.
 */
export async function canExecuteOnCommandWorker(
  options: CommandWorkerClientOptions,
  target: string,
): Promise<boolean> {
  const result = await requestOnce(
    options,
    (token) => ({
      type: "probe",
      protocol: COMMAND_WORKER_PROTOCOL,
      token,
      path: target,
    }),
    "probe_result",
  );
  return result.ok && result.frame.executable === true;
}

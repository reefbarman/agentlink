import { createHash, timingSafeEqual } from "node:crypto";

import type { Socket } from "node:net";
import type { WorkspaceProcessLaunchRequest } from "@agentlink/workspace-host";

/**
 * Wire protocol between the assistant server and its command worker: one TCP
 * connection per process, newline-delimited JSON frames. The first frame from
 * the server carries the shared token; anything unauthenticated is dropped.
 *
 * server → worker: `launch`, `ping`, or `probe` (first), then `signal`
 * worker → server: `started`, `launch_failed`, `output`, `exit`, `pong`,
 *   `probe_result`, `error`
 */
export const COMMAND_WORKER_PROTOCOL = 1;

export type CommandWorkerSignal = "SIGTERM" | "SIGKILL";

export type CommandWorkerClientFrame =
  | {
      readonly type: "launch";
      readonly protocol: number;
      readonly token: string;
      readonly request: WorkspaceProcessLaunchRequest;
    }
  | {
      readonly type: "ping";
      readonly protocol: number;
      readonly token: string;
    }
  | {
      /** Whether an absolute path is executable on the worker. */
      readonly type: "probe";
      readonly protocol: number;
      readonly token: string;
      readonly path: string;
    }
  | { readonly type: "signal"; readonly signal: CommandWorkerSignal };

export type CommandWorkerServerFrame =
  | { readonly type: "started" }
  | { readonly type: "launch_failed"; readonly code: string }
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      /** Base64 bytes. */
      readonly data: string;
    }
  | {
      readonly type: "exit";
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals;
    }
  | { readonly type: "pong"; readonly protocol: number }
  | { readonly type: "probe_result"; readonly executable: boolean }
  | { readonly type: "error"; readonly code: string };

/** Largest frame either side accepts; output frames are well below it. */
export const MAX_COMMAND_WORKER_FRAME_BYTES = 1024 * 1024;

export function writeFrame(
  socket: Socket,
  frame: CommandWorkerClientFrame | CommandWorkerServerFrame,
): boolean {
  if (socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Parse newline-delimited JSON frames from a socket. Calls `onError` once and
 * stops on an oversized or malformed frame.
 */
export function readFrames(
  socket: Socket,
  onFrame: (frame: Record<string, unknown>) => void,
  onError: (code: string) => void,
): void {
  let buffered = Buffer.alloc(0);
  let failed = false;
  socket.on("data", (chunk: Buffer) => {
    if (failed) return;
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf(0x0a);
      if (end < 0) break;
      // Check before parsing: a huge line that happens to end in this chunk
      // must not be parsed just because the remainder is small.
      if (end > MAX_COMMAND_WORKER_FRAME_BYTES) {
        failed = true;
        onError("frame_too_large");
        return;
      }
      const line = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      if (line.length === 0) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line.toString("utf8"));
      } catch {
        failed = true;
        onError("frame_invalid");
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        failed = true;
        onError("frame_invalid");
        return;
      }
      onFrame(frame as Record<string, unknown>);
      if (socket.destroyed) return;
    }
    if (buffered.length > MAX_COMMAND_WORKER_FRAME_BYTES) {
      failed = true;
      onError("frame_too_large");
    }
  });
}

/** Constant-time token comparison that does not leak the expected length. */
export function tokensMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(left, right);
}

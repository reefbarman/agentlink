import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import {
  encodeSandboxHelperFrame,
  parseSandboxHelperEventLine,
  type SandboxCommandIdentity,
  type SandboxHelperControlFrame,
  type SandboxHelperEventFrame,
  type SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";
import {
  SandboxPreCommandLaunchError,
  type SandboxCommandDisposable,
  type SandboxCommandEvent,
  type SandboxCommandExit,
  type SandboxCommandProcess,
  type SandboxCommandReady,
  type SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";

export const SANDBOX_HELPER_GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;

export interface SandboxHelperTransport {
  /** Accept a complete control frame for delivery; backpressure is handled internally. */
  write(data: string): boolean;
  onLine(listener: (line: string) => void): SandboxCommandDisposable;
  onError(listener: (error: Error) => void): SandboxCommandDisposable;
  onClose(
    listener: (event: {
      exitCode: number | null;
      signal: string | null;
      stderr?: string;
    }) => void,
  ): SandboxCommandDisposable;
  closeGracefully(killAfterMs: number): void;
  kill(): void;
  dispose(): void;
}

export interface SandboxHelperTransportFactory {
  create(): SandboxHelperTransport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sameIdentity(
  left: SandboxCommandIdentity,
  right: SandboxCommandIdentity,
): boolean {
  return (
    left.channelId === right.channelId &&
    left.commandId === right.commandId &&
    left.generation === right.generation
  );
}

class SandboxHelperCommandProcess implements SandboxCommandProcess {
  readonly identity: SandboxCommandIdentity;
  readonly ready: Promise<SandboxCommandReady>;
  readonly completion: Promise<SandboxCommandExit>;

  private readonly readyDeferred = deferred<SandboxCommandReady>();
  private readonly completionDeferred = deferred<SandboxCommandExit>();
  private readonly listeners = new Set<(event: SandboxCommandEvent) => void>();
  private readonly pendingEvents: SandboxCommandEvent[] = [];
  private readonly subscriptions: SandboxCommandDisposable[];
  private eventReplayScheduled = false;
  private state: "launching" | "running" | "completed" | "failed" = "launching";
  private disposed = false;
  private readySettled = false;
  private completionSettled = false;
  private transportFinalized = false;

  constructor(
    private readonly transport: SandboxHelperTransport,
    request: SandboxHelperLaunchRequest,
  ) {
    this.identity = {
      channelId: request.channelId,
      commandId: request.commandId,
      generation: request.generation,
    };
    this.ready = this.readyDeferred.promise;
    this.completion = this.completionDeferred.promise;
    void this.ready.catch(() => undefined);
    this.subscriptions = [
      transport.onLine((line) => this.handleLine(line)),
      transport.onError((error) => this.fail(error)),
      transport.onClose((event) => this.handleClose(event)),
    ];

    try {
      if (!this.send(request)) {
        throw new Error("Sandbox helper rejected the launch frame");
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  onEvent(
    listener: (event: SandboxCommandEvent) => void,
  ): SandboxCommandDisposable {
    if (this.disposed && this.pendingEvents.length === 0) {
      return { dispose() {} };
    }
    this.listeners.add(listener);
    this.schedulePendingEventReplay();
    return { dispose: () => this.listeners.delete(listener) };
  }

  write(data: string): boolean {
    return this.sendWhileRunning({ ...this.identity, type: "input", data });
  }

  resize(dimensions: TerminalDimensions): boolean {
    return this.sendWhileRunning({
      ...this.identity,
      type: "resize",
      dimensions,
    });
  }

  interrupt(): boolean {
    return this.sendWhileRunning({ ...this.identity, type: "interrupt" });
  }

  respondToNetworkRequest(
    requestId: string,
    decision: "allow-once" | "reject",
  ): boolean {
    return this.sendWhileRunning({
      ...this.identity,
      type: "network-decision",
      requestId,
      decision,
    });
  }

  terminate(): boolean {
    if (this.state !== "launching" && this.state !== "running") return false;
    return this.send({ ...this.identity, type: "terminate" });
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.state === "launching" || this.state === "running") {
      this.send({ ...this.identity, type: "terminate" });
      this.fail(new Error("Sandbox command process was disposed"), false);
      return;
    }
    this.disposed = true;
    this.finalizeTransport(false);
  }

  private sendWhileRunning(frame: SandboxHelperControlFrame): boolean {
    return this.state === "running" && this.send(frame);
  }

  private send(frame: SandboxHelperControlFrame): boolean {
    if (this.disposed) return false;
    return this.transport.write(encodeSandboxHelperFrame(frame));
  }

  private handleLine(line: string): void {
    if (this.state === "completed" || this.state === "failed") return;
    let event: SandboxHelperEventFrame;
    try {
      event = parseSandboxHelperEventLine(line);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!sameIdentity(event, this.identity)) return;

    if (event.type === "ready") {
      if (this.state !== "launching") {
        this.fail(new Error("Sandbox helper emitted duplicate readiness"));
        return;
      }
      this.state = "running";
      this.resolveReady({
        pid: event.pid,
        pgid: event.pgid,
        backend: event.backend,
        ...(event.backendVersion === undefined
          ? {}
          : { backendVersion: event.backendVersion }),
      });
      return;
    }
    if (event.type === "error") {
      this.fail(
        event.code === "sandbox_environment_too_large" && event.details
          ? new SandboxPreCommandLaunchError(event.message, event.details)
          : new Error(event.message),
      );
      return;
    }
    if (event.type === "exit") {
      if (this.state === "launching") {
        this.fail(new Error("Sandbox helper exited before readiness"));
        return;
      }
      this.state = "completed";
      this.resolveCompletion({
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        ...(event.signal === undefined ? {} : { signal: event.signal }),
        timedOut: event.timedOut,
      });
      this.finalizeTransport(false);
      return;
    }
    if (this.state !== "running") {
      this.fail(
        new Error("Sandbox helper emitted command data before readiness"),
      );
      return;
    }

    const commandEvent: SandboxCommandEvent =
      event.type === "data"
        ? { type: "data", data: event.data }
        : event.type === "cwd"
          ? { type: "cwd", cwd: event.cwd, nonce: event.nonce }
          : event.type === "network-request"
            ? { type: "network-request", request: event.request }
            : { type: "violation", violation: event.violation };
    this.pendingEvents.push(commandEvent);
    this.schedulePendingEventReplay();
  }

  private schedulePendingEventReplay(): void {
    if (this.eventReplayScheduled || this.pendingEvents.length === 0) return;
    this.eventReplayScheduled = true;
    queueMicrotask(() => {
      this.eventReplayScheduled = false;
      if (this.state === "failed" || this.listeners.size === 0) return;
      while (this.pendingEvents.length > 0) {
        const event = this.pendingEvents.shift();
        if (event) this.emitEvent(event);
      }
      if (this.disposed) this.listeners.clear();
    });
  }

  private emitEvent(event: SandboxCommandEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private handleClose(event: {
    exitCode: number | null;
    signal: string | null;
    stderr?: string;
  }): void {
    if (this.state === "completed" || this.state === "failed") return;
    const detail = event.stderr?.trim();
    this.fail(
      new Error(
        `Sandbox helper closed before command completion: code=${event.exitCode} signal=${event.signal}${detail ? `: ${detail}` : ""}`,
      ),
    );
  }

  private fail(error: Error, kill = true): void {
    if (this.state === "completed" || this.state === "failed") return;
    this.state = "failed";
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyDeferred.reject(error);
    }
    if (!this.completionSettled) {
      this.completionSettled = true;
      this.completionDeferred.reject(error);
    }
    this.finalizeTransport(kill);
  }

  private finalizeTransport(kill: boolean): void {
    if (this.transportFinalized) return;
    this.transportFinalized = true;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    if (kill || this.pendingEvents.length === 0) {
      this.listeners.clear();
      this.pendingEvents.length = 0;
    }
    if (kill) this.transport.kill();
    else
      this.transport.closeGracefully(SANDBOX_HELPER_GRACEFUL_CLOSE_TIMEOUT_MS);
    this.transport.dispose();
  }

  private resolveReady(ready: SandboxCommandReady): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyDeferred.resolve(ready);
  }

  private resolveCompletion(exit: SandboxCommandExit): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.completionDeferred.resolve(exit);
  }
}

export class SandboxHelperClient implements SandboxRuntimeProvider {
  private readonly processes = new Set<SandboxHelperCommandProcess>();
  private disposed = false;

  constructor(private readonly transports: SandboxHelperTransportFactory) {}

  launch(request: SandboxHelperLaunchRequest): SandboxCommandProcess {
    if (this.disposed) throw new Error("Sandbox helper client is disposed");
    const process = new SandboxHelperCommandProcess(
      this.transports.create(),
      request,
    );
    this.processes.add(process);
    void process.completion.then(
      () => this.processes.delete(process),
      () => this.processes.delete(process),
    );
    return process;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const process of this.processes) process.dispose();
    this.processes.clear();
  }
}

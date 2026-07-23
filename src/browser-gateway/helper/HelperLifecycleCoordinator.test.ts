import { EventEmitter } from "events";
import type * as http from "http";
import type * as net from "net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HelperLifecycleCoordinator,
  type HelperTrackedStream,
} from "./HelperLifecycleCoordinator.js";

class FakeServer extends EventEmitter {
  closeAllConnectionsCount = 0;
  closeIdleConnectionsCount = 0;
  closeCount = 0;
  private closeCallback: (() => void) | undefined;

  close(callback?: () => void): this {
    this.closeCount += 1;
    this.closeCallback = callback;
    return this;
  }

  closeAllConnections(): void {
    this.closeAllConnectionsCount += 1;
  }

  closeIdleConnections(): void {
    this.closeIdleConnectionsCount += 1;
  }

  finishClose(): void {
    this.closeCallback?.();
    this.closeCallback = undefined;
  }

  asServer(): http.Server {
    return this as unknown as http.Server;
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroyCount = 0;

  destroy(): this {
    this.destroyCount += 1;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  asSocket(): net.Socket {
    return this as unknown as net.Socket;
  }
}

class FakeStream extends EventEmitter implements HelperTrackedStream {
  destroyed = false;
  writableEnded = false;
  endCount = 0;
  destroyCount = 0;
  closeOnEnd = true;

  end(): this {
    this.endCount += 1;
    this.writableEnded = true;
    if (this.closeOnEnd) this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyCount += 1;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HelperLifecycleCoordinator", () => {
  it("tracks accepted sockets until close", () => {
    const server = new FakeServer();
    const coordinator = new HelperLifecycleCoordinator({
      server: server.asServer(),
    });
    const socket = new FakeSocket();

    server.emit("connection", socket.asSocket());
    expect(coordinator.acceptedSocketCount).toBe(1);

    socket.emit("close");
    expect(coordinator.acceptedSocketCount).toBe(0);
  });

  it("reference-counts browser stream and Ask Agent turn liveness", () => {
    const changes: string[][] = [];
    const coordinator = new HelperLifecycleCoordinator({
      server: new FakeServer().asServer(),
      onLivenessChanged: (reasons) => changes.push([...reasons]),
    });
    const stream = new FakeStream();
    const releaseStream = coordinator.trackStream(stream);
    const releaseFirstTurn = coordinator.acquireLiveness("ask_agent_turn");
    const releaseSecondTurn = coordinator.acquireLiveness("ask_agent_turn");

    expect(coordinator.getLivenessReasons()).toEqual([
      "ask_agent_turn",
      "browser_stream",
    ]);

    releaseFirstTurn();
    expect(coordinator.getLivenessReasons()).toEqual([
      "ask_agent_turn",
      "browser_stream",
    ]);
    releaseSecondTurn();
    releaseStream();

    expect(coordinator.getLivenessReasons()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it("tracks owner command streams without acquiring liveness", () => {
    const coordinator = new HelperLifecycleCoordinator({
      server: new FakeServer().asServer(),
    });
    const stream = new FakeStream();

    const release = coordinator.trackStream(stream, undefined, null);
    expect(coordinator.activeStreamCount).toBe(1);
    expect(coordinator.hasLivenessReasons()).toBe(false);

    release();
    expect(coordinator.activeStreamCount).toBe(0);
  });

  it("gracefully drains streams and waits for server close", async () => {
    const server = new FakeServer();
    const stream = new FakeStream();
    const coordinator = new HelperLifecycleCoordinator({
      server: server.asServer(),
      shutdownTimeoutMs: 1_000,
    });
    coordinator.trackStream(stream);
    const cleanup = vi.fn(async () => undefined);
    let drainCompleted!: () => void;
    const drained = new Promise<void>((resolve) => {
      drainCompleted = resolve;
    });

    const shutdown = coordinator.shutdown({
      drain: async () => {
        drainCompleted();
      },
      cleanup,
    });
    await drained;
    await vi.waitFor(() => expect(stream.endCount).toBe(1));

    expect(stream.destroyCount).toBe(0);
    expect(server.closeCount).toBe(1);
    server.finishClose();

    await expect(shutdown).resolves.toMatchObject({
      timedOut: false,
      destroyedSockets: 0,
      destroyedStreams: 0,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("forces streams and sockets closed when the shared deadline expires", async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    const socket = new FakeSocket();
    const stream = new FakeStream();
    stream.closeOnEnd = false;
    const coordinator = new HelperLifecycleCoordinator({
      server: server.asServer(),
      shutdownTimeoutMs: 100,
    });
    server.emit("connection", socket.asSocket());
    coordinator.trackStream(stream, () => stream.end());

    const shutdown = coordinator.shutdown({
      drain: () => new Promise<void>(() => undefined),
      cleanup: () => new Promise<void>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(shutdown).resolves.toMatchObject({
      timedOut: true,
      destroyedSockets: 1,
      destroyedStreams: 1,
    });
    expect(stream.endCount).toBe(1);
    expect(stream.destroyCount).toBe(1);
    expect(socket.destroyCount).toBe(1);
    expect(server.closeAllConnectionsCount).toBe(1);
    expect(coordinator.acceptedSocketCount).toBe(0);
    expect(coordinator.activeStreamCount).toBe(0);
  });

  it("reports drain and cleanup failures without rejecting shutdown", async () => {
    const server = new FakeServer();
    const coordinator = new HelperLifecycleCoordinator({
      server: server.asServer(),
    });
    const drainError = new Error("drain failed");
    const cleanupError = new Error("cleanup failed");

    const shutdown = coordinator.shutdown({
      drain: () => Promise.reject(drainError),
      cleanup: () => Promise.reject(cleanupError),
    });
    await vi.waitFor(() => expect(server.closeCount).toBe(1));
    server.finishClose();

    await expect(shutdown).resolves.toMatchObject({
      timedOut: false,
      drainError,
      cleanupError,
    });
  });

  it("returns one shutdown promise to concurrent callers", async () => {
    const server = new FakeServer();
    const coordinator = new HelperLifecycleCoordinator({
      server: server.asServer(),
    });
    const drain = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);

    const first = coordinator.shutdown({ drain, cleanup });
    const second = coordinator.shutdown({ drain, cleanup });
    expect(second).toBe(first);

    await Promise.resolve();
    server.finishClose();
    await first;

    expect(drain).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

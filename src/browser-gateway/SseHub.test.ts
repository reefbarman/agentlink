import { EventEmitter } from "events";
import * as http from "http";
import { describe, expect, it, vi } from "vitest";
import { SseHub, type SsePublication } from "./SseHub.js";

class FakeRequest extends EventEmitter {
  readonly socket = { setTimeout: vi.fn() };
}

class FakeResponse extends EventEmitter {
  readonly socket = { setTimeout: vi.fn() };
  readonly writeHead = vi.fn();
  readonly flushHeaders = vi.fn();
  readonly end = vi.fn(() => {
    this.writableEnded = true;
  });
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("close");
  });
  readonly write = vi.fn((_chunk: string) => true);
  destroyed = false;
  writableEnded = false;
}

function request(value = new FakeRequest()): http.IncomingMessage {
  return value as unknown as http.IncomingMessage;
}

function response(value = new FakeResponse()): http.ServerResponse {
  return value as unknown as http.ServerResponse;
}

function publication(
  revision: number,
  value = `value-${revision}`,
): SsePublication<string> {
  const serialized = JSON.stringify(value);
  return { revision, value, serialized, bytes: Buffer.byteLength(serialized) };
}

describe("SseHub", () => {
  it("prepares one serialized publication for any number of clients", async () => {
    const serialize = vi.fn((value: string) => JSON.stringify({ value }));
    const hub = new SseHub({ serialize, keepaliveIntervalMs: 0 });
    const clients = [new FakeResponse(), new FakeResponse()];
    await Promise.all(
      clients.map((client) =>
        hub.subscribe(request(), response(client), () => hub.prepare(1, "one")),
      ),
    );
    serialize.mockClear();
    for (const client of clients) client.write.mockClear();

    const prepared = hub.prepare(2, "two");
    expect(hub.broadcast(prepared)).toEqual({ attempted: 2, delivered: 2 });

    expect(serialize).toHaveBeenCalledOnce();
    for (const client of clients) {
      expect(client.write).toHaveBeenCalledWith(
        'event: update\ndata: {"value":"two"}\n\n',
      );
    }
  });

  it("records first delivery latency and bytes after a successful snapshot write", async () => {
    let now = 100;
    const deliveries: Array<{ durationMs: number; bytes: number }> = [];
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
      now: () => now,
      onFirstDelivery: (sample) => deliveries.push(sample),
    });
    const res = new FakeResponse();

    const subscribed = hub.subscribe(request(), response(res), async () => {
      now = 135;
      return publication(1);
    });

    await expect(subscribed).resolves.toEqual(publication(1));
    expect(deliveries).toEqual([
      { durationMs: 35, bytes: publication(1).bytes },
    ]);
  });

  it("does not record first delivery when the initial write backpressures", async () => {
    const onFirstDelivery = vi.fn();
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
      onFirstDelivery,
    });
    const res = new FakeResponse();
    res.write.mockReturnValueOnce(false);

    await expect(
      hub.subscribe(request(), response(res), () => publication(1)),
    ).resolves.toBeNull();

    expect(onFirstDelivery).not.toHaveBeenCalled();
  });

  it("disconnects only the client whose write reports backpressure", async () => {
    const removals: string[] = [];
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
      onClientRemoved: (reason) => removals.push(reason),
    });
    const blocked = new FakeResponse();
    const healthy = new FakeResponse();
    await hub.subscribe(request(), response(blocked), () => publication(1));
    await hub.subscribe(request(), response(healthy), () => publication(1));
    blocked.write.mockReturnValueOnce(false);

    expect(hub.broadcast(publication(2))).toEqual({
      attempted: 2,
      delivered: 1,
    });

    expect(blocked.destroy).toHaveBeenCalledOnce();
    expect(blocked.end).not.toHaveBeenCalled();
    expect(healthy.end).not.toHaveBeenCalled();
    expect(removals).toEqual(["backpressure"]);
    expect(blocked.listenerCount("drain")).toBe(0);
    blocked.emit("drain");
    expect(hub.size).toBe(1);
  });

  it("hard-closes a real HTTP response on backpressure without waiting for drain", async () => {
    let resolveResponseClosed!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const server = http.createServer((req, res) => {
      res.on("close", resolveResponseClosed);
      const write = res.write.bind(res);
      res.write = ((chunk: unknown) => {
        write(chunk);
        return false;
      }) as typeof res.write;
      void hub.subscribe(req, res, () => publication(1));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP test server address");
    }
    const clientClosed = new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${address.port}`, (res) => {
        res.on("aborted", resolve);
        res.on("close", resolve);
        res.resume();
      });
      req.on("error", resolve);
    });

    try {
      await responseClosed;
      await clientClosed;
      expect(hub.size).toBe(0);
    } finally {
      hub.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hard-destroys failed transports even if they already report writableEnded", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();
    await hub.subscribe(request(), response(res), () => publication(1));
    res.writableEnded = true;
    res.emit("error", new Error("transport failed"));

    expect(res.destroy).toHaveBeenCalledOnce();
    expect(hub.size).toBe(0);
  });

  it("removes a throwing writer without affecting peers", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const failed = new FakeResponse();
    const healthy = new FakeResponse();
    await hub.subscribe(request(), response(failed), () => publication(1));
    await hub.subscribe(request(), response(healthy), () => publication(1));
    failed.write.mockImplementationOnce(() => {
      throw new Error("socket closed");
    });

    expect(hub.broadcast(publication(2))).toEqual({
      attempted: 2,
      delivered: 1,
    });
    expect(failed.destroy).toHaveBeenCalledOnce();
    expect(healthy.write).toHaveBeenCalledWith(
      'event: update\ndata: "value-2"\n\n',
    );
  });

  it.each(["request close", "response close", "response error"])(
    "cleans up on %s",
    async (trigger) => {
      const counts: number[] = [];
      const hub = new SseHub<string>({
        serialize: JSON.stringify,
        keepaliveIntervalMs: 0,
        onClientCountChanged: (count) => counts.push(count),
      });
      const req = new FakeRequest();
      const res = new FakeResponse();
      await hub.subscribe(request(req), response(res), () => publication(1));

      if (trigger === "request close") req.emit("close");
      else if (trigger === "response close") res.emit("close");
      else res.emit("error", new Error("failed"));

      expect(hub.size).toBe(0);
      if (trigger === "response error") {
        expect(res.destroy).toHaveBeenCalledOnce();
        expect(res.end).not.toHaveBeenCalled();
      } else {
        expect(res.end).toHaveBeenCalledOnce();
      }
      expect(counts).toEqual([1, 0]);
    },
  );

  it("writes keepalives with injected time and clears the timer", async () => {
    let tick: (() => void) | undefined;
    const timer = { fake: true } as unknown as NodeJS.Timeout;
    const clearInterval = vi.fn();
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 25,
      now: () => 123,
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(25);
        tick = callback;
        return timer;
      },
      clearInterval,
    });
    const res = new FakeResponse();
    await hub.subscribe(request(), response(res), () => publication(1));
    res.write.mockClear();

    tick?.();
    expect(res.write).toHaveBeenCalledWith(
      ": keepalive 123\n\nevent: heartbeat\ndata: 123\n\n",
    );

    hub.remove(response(res));
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it("disconnects when a keepalive reports backpressure", async () => {
    let tick: (() => void) | undefined;
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 25,
      setInterval: (callback) => {
        tick = callback;
        return {} as NodeJS.Timeout;
      },
    });
    const res = new FakeResponse();
    await hub.subscribe(request(), response(res), () => publication(1));
    res.write.mockReturnValueOnce(false);

    tick?.();

    expect(hub.size).toBe(0);
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it("uses adapter-supplied headers without forcing a flush", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      headers: { "Content-Type": "text/event-stream", "X-Test": "helper" },
      flushHeaders: false,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();

    await hub.subscribe(request(), response(res), () => publication(1));

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "X-Test": "helper",
    });
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it("isolates throwing lifecycle observers", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
      onClientCountChanged: () => {
        throw new Error("count observer failed");
      },
      onClientRemoved: () => {
        throw new Error("remove observer failed");
      },
    });
    const first = new FakeResponse();
    const second = new FakeResponse();

    await expect(
      hub.subscribe(request(), response(first), () => publication(1)),
    ).resolves.toEqual(publication(1));
    await hub.subscribe(request(), response(second), () => publication(1));

    expect(() => hub.dispose()).not.toThrow();
    expect(hub.size).toBe(0);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
  });

  it("removes a partially registered client when initial capture rejects", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();

    await expect(
      hub.subscribe(request(), response(res), async () => {
        throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");

    expect(hub.size).toBe(0);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("aborts and releases an unresolved initial capture when removed", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const req = new FakeRequest();
    const res = new FakeResponse();
    let captureSignal: AbortSignal | undefined;
    const subscribed = hub.subscribe(request(req), response(res), (signal) => {
      captureSignal = signal;
      return new Promise<SsePublication<string>>(() => {});
    });

    req.emit("close");

    await expect(subscribed).resolves.toBeNull();
    expect(captureSignal?.aborted).toBe(true);
    expect(hub.size).toBe(0);
  });

  it("removes a client when its initial snapshot reports backpressure", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();
    res.write.mockReturnValueOnce(false);

    await expect(
      hub.subscribe(request(), response(res), () => publication(1)),
    ).resolves.toBeNull();

    expect(hub.size).toBe(0);
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it("removes a client when keepalive scheduling throws", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 25,
      setInterval: () => {
        throw new Error("scheduler failed");
      },
    });
    const res = new FakeResponse();

    await expect(
      hub.subscribe(request(), response(res), () => publication(1)),
    ).rejects.toThrow("scheduler failed");

    expect(hub.size).toBe(0);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("frames multiline data and rejects invalid event names", async () => {
    const hub = new SseHub<string>({
      serialize: (value) => value,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();
    await hub.subscribe(request(), response(res), () => publication(1));
    res.write.mockClear();

    hub.broadcast({
      revision: 2,
      value: "first\nsecond",
      serialized: "first\nsecond",
      bytes: 12,
    });
    expect(res.write).toHaveBeenCalledWith(
      "event: update\ndata: first\ndata: second\n\n",
    );
    expect(() => hub.broadcast(publication(3), "update\nid: injected")).toThrow(
      "invalid_sse_event_name",
    );
  });

  it("retains only the newest publication during async initial capture", async () => {
    let resolveInitial!: (value: SsePublication<string>) => void;
    const initial = new Promise<SsePublication<string>>((resolve) => {
      resolveInitial = resolve;
    });
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();
    const subscribed = hub.subscribe(request(), response(res), () => initial);

    expect(hub.broadcast(publication(2))).toEqual({
      attempted: 0,
      delivered: 0,
    });
    hub.broadcast(publication(4));
    hub.broadcast(publication(3));
    resolveInitial(publication(1));

    await expect(subscribed).resolves.toEqual(publication(4));
    expect(res.write).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith(
      'event: snapshot\ndata: "value-4"\n\n',
    );
  });

  it("keeps a newer captured initial snapshot over pending publications", async () => {
    let resolveInitial!: (value: SsePublication<string>) => void;
    const initial = new Promise<SsePublication<string>>((resolve) => {
      resolveInitial = resolve;
    });
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const res = new FakeResponse();
    const subscribed = hub.subscribe(request(), response(res), () => initial);
    hub.broadcast(publication(1));
    resolveInitial(publication(2));

    await expect(subscribed).resolves.toEqual(publication(2));
    expect(res.write).toHaveBeenCalledWith(
      'event: snapshot\ndata: "value-2"\n\n',
    );
  });

  it("disposes every client even when one response end throws", async () => {
    const hub = new SseHub<string>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const first = new FakeResponse();
    const second = new FakeResponse();
    await hub.subscribe(request(), response(first), () => publication(1));
    await hub.subscribe(request(), response(second), () => publication(1));
    first.end.mockImplementationOnce(() => {
      throw new Error("end failed");
    });

    hub.dispose();

    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(hub.size).toBe(0);
    expect(hub.broadcast(publication(2))).toEqual({
      attempted: 0,
      delivered: 0,
    });
    const rejected = new FakeResponse();
    await expect(
      hub.subscribe(request(), response(rejected), () => publication(2)),
    ).resolves.toBeNull();
    expect(rejected.destroy).toHaveBeenCalledOnce();
  });
});

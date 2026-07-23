import { describe, expect, it } from "vitest";

import { SseHub, type SsePublication } from "../SseHub.js";
import {
  ControllableSseRequest,
  ControllableSseResponse,
  createDeferred,
} from "./SseFaultPeer.js";

function publication(revision: number): SsePublication<{ revision: number }> {
  const value = { revision };
  const serialized = JSON.stringify(value);
  return {
    revision,
    value,
    serialized,
    bytes: Buffer.byteLength(serialized),
  };
}

describe("SseHub fault injection", () => {
  it("compacts delayed capture, disconnects on backpressure, and recovers on reconnect", async () => {
    const removals: string[] = [];
    const hub = new SseHub<{ revision: number }>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
      onClientRemoved: (reason) => removals.push(reason),
    });
    const delayedCapture =
      createDeferred<SsePublication<{ revision: number }>>();
    const firstRequest = new ControllableSseRequest();
    const firstResponse = new ControllableSseResponse();
    const firstSubscription = hub.subscribe(
      firstRequest.asIncomingMessage(),
      firstResponse.asServerResponse(),
      () => delayedCapture.promise,
    );

    expect(hub.broadcast(publication(2))).toEqual({
      attempted: 0,
      delivered: 0,
    });
    hub.broadcast(publication(4));
    hub.broadcast(publication(3));
    delayedCapture.resolve(publication(1));

    await expect(firstSubscription).resolves.toEqual(publication(4));
    expect(firstResponse.writes).toEqual([
      'event: snapshot\ndata: {"revision":4}\n\n',
    ]);

    firstResponse.enqueueWriteOutcome(false);
    expect(hub.broadcast(publication(5))).toEqual({
      attempted: 1,
      delivered: 0,
    });
    expect(removals).toEqual(["backpressure"]);
    expect(firstResponse.destroyCount).toBe(1);
    expect(hub.size).toBe(0);

    const replacementRequest = new ControllableSseRequest();
    const replacementResponse = new ControllableSseResponse();
    await expect(
      hub.subscribe(
        replacementRequest.asIncomingMessage(),
        replacementResponse.asServerResponse(),
        () => publication(5),
      ),
    ).resolves.toEqual(publication(5));
    expect(replacementResponse.writes).toEqual([
      'event: snapshot\ndata: {"revision":5}\n\n',
    ]);

    expect(hub.broadcast(publication(6))).toEqual({
      attempted: 1,
      delivered: 1,
    });
    expect(replacementResponse.writes.at(-1)).toBe(
      'event: update\ndata: {"revision":6}\n\n',
    );
  });

  it("aborts a stalled initial capture when the client disconnects", async () => {
    const hub = new SseHub<{ revision: number }>({
      serialize: JSON.stringify,
      keepaliveIntervalMs: 0,
    });
    const request = new ControllableSseRequest();
    const response = new ControllableSseResponse();
    let captureSignal: AbortSignal | undefined;
    const subscription = hub.subscribe(
      request.asIncomingMessage(),
      response.asServerResponse(),
      (signal) => {
        captureSignal = signal;
        return new Promise<SsePublication<{ revision: number }>>(() => {});
      },
    );

    request.close();

    await expect(subscription).resolves.toBeNull();
    expect(captureSignal?.aborted).toBe(true);
    expect(response.endCount).toBe(1);
    expect(hub.size).toBe(0);
  });
});

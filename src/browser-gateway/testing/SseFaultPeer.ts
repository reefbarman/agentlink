import type * as http from "node:http";

import { EventEmitter } from "node:events";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error?: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

export class ControllableSseRequest extends EventEmitter {
  readonly socketTimeouts: number[] = [];
  readonly socket = {
    setTimeout: (timeout: number) => {
      this.socketTimeouts.push(timeout);
    },
  };

  close(): void {
    this.emit("close");
  }

  asIncomingMessage(): http.IncomingMessage {
    return this as unknown as http.IncomingMessage;
  }
}

export type ControllableSseWriteOutcome = boolean | Error;

export class ControllableSseResponse extends EventEmitter {
  readonly socketTimeouts: number[] = [];
  readonly socket = {
    setTimeout: (timeout: number) => {
      this.socketTimeouts.push(timeout);
    },
  };
  readonly headers: Array<{
    statusCode: number;
    headers: http.OutgoingHttpHeaders | undefined;
  }> = [];
  readonly writes: string[] = [];
  flushCount = 0;
  endCount = 0;
  destroyCount = 0;
  destroyed = false;
  writableEnded = false;
  private readonly writeOutcomes: ControllableSseWriteOutcome[] = [];

  enqueueWriteOutcome(...outcomes: ControllableSseWriteOutcome[]): void {
    this.writeOutcomes.push(...outcomes);
  }

  writeHead(statusCode: number, headers?: http.OutgoingHttpHeaders): this {
    this.headers.push({ statusCode, headers });
    return this;
  }

  flushHeaders(): void {
    this.flushCount += 1;
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    const outcome = this.writeOutcomes.shift() ?? true;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  end(): this {
    this.endCount += 1;
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyCount += 1;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  fail(error = new Error("controllable_sse_response_failed")): void {
    this.emit("error", error);
  }

  drain(): void {
    this.emit("drain");
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }
}

import * as fs from "fs/promises";

import {
  BrowserGatewayHelperDiscoveryWriter,
  clearBrowserGatewayHelperDiscovery,
  getBrowserGatewayHelperDiscoveryPath,
  readBrowserGatewayHelperDiscovery,
  writeBrowserGatewayHelperDiscovery,
} from "./browserGatewayHelperDiscovery.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserGatewayHelperDiscoveryRecord } from "./protocol.js";
import { createDeferred } from "./testing/SseFaultPeer.js";

function record(generation: string): BrowserGatewayHelperDiscoveryRecord {
  return {
    pid: 123,
    port: 47137,
    url: "http://127.0.0.1:47137",
    protocolVersion: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
    helperVersion: "test",
    helperGenerationId: generation,
    browserBootstrapToken: "browser-token",
    clientSharedSecret: "client-secret",
  };
}

afterEach(async () => {
  await clearBrowserGatewayHelperDiscovery();
});

describe("BrowserGatewayHelperDiscoveryWriter", () => {
  it("serializes writes and coalesces adjacent pending records to the latest", async () => {
    const firstWrite = createDeferred<void>();
    const writes: string[] = [];
    const writer = new BrowserGatewayHelperDiscoveryWriter({
      writeRecord: vi.fn(async (next) => {
        writes.push(next.helperGenerationId!);
        if (writes.length === 1) await firstWrite.promise;
      }),
      clearRecord: vi.fn(async () => undefined),
    });

    const first = writer.write(record("generation-1"));
    const second = writer.write(record("generation-2"));
    const third = writer.write(record("generation-3"));
    await Promise.resolve();

    expect(writes).toEqual(["generation-1"]);

    firstWrite.resolve();
    await Promise.all([first, second, third]);

    expect(writes).toEqual(["generation-1", "generation-3"]);
  });

  it("preserves clear as a barrier between writes", async () => {
    const calls: string[] = [];
    const writer = new BrowserGatewayHelperDiscoveryWriter({
      writeRecord: vi.fn(async (next) => {
        calls.push(`write:${next.helperGenerationId}`);
      }),
      clearRecord: vi.fn(async (expectedGeneration) => {
        calls.push(`clear:${expectedGeneration ?? "any"}`);
      }),
    });

    await Promise.all([
      writer.write(record("generation-1")),
      writer.clear("generation-1"),
      writer.write(record("generation-2")),
    ]);

    expect(calls).toEqual([
      "write:generation-1",
      "clear:generation-1",
      "write:generation-2",
    ]);
  });

  it("rejects coalesced callers on failure and continues with later barriers", async () => {
    const error = new Error("discovery_write_failed");
    const firstWrite = createDeferred<void>();
    let writeCount = 0;
    const calls: string[] = [];
    const writer = new BrowserGatewayHelperDiscoveryWriter({
      writeRecord: vi.fn(async (next) => {
        writeCount += 1;
        calls.push(`write:${next.helperGenerationId}`);
        if (writeCount === 1) await firstWrite.promise;
        else throw error;
      }),
      clearRecord: vi.fn(async () => {
        calls.push("clear");
      }),
    });

    const first = writer.write(record("generation-1"));
    const second = writer.write(record("generation-2"));
    const third = writer.write(record("generation-3"));
    const clear = writer.clear();
    firstWrite.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBe(error);
    await expect(third).rejects.toBe(error);
    await expect(clear).resolves.toBeUndefined();
    expect(calls).toEqual([
      "write:generation-1",
      "write:generation-3",
      "clear",
    ]);
  });

  it("ignores writes from a helper generation after guarded clear", async () => {
    const calls: string[] = [];
    const writer = new BrowserGatewayHelperDiscoveryWriter({
      writeRecord: vi.fn(async (next) => {
        calls.push(`write:${next.helperGenerationId}`);
      }),
      clearRecord: vi.fn(async (expectedGeneration) => {
        calls.push(`clear:${expectedGeneration}`);
      }),
    });

    await writer.write(record("generation-1"));
    await writer.clear("generation-1");
    await writer.write(record("generation-1"));
    await writer.write(record("generation-2"));

    expect(calls).toEqual([
      "write:generation-1",
      "clear:generation-1",
      "write:generation-2",
    ]);
  });

  it("does not coalesce clears for different helper generations", async () => {
    const cleared: Array<string | undefined> = [];
    const writer = new BrowserGatewayHelperDiscoveryWriter({
      writeRecord: vi.fn(async () => undefined),
      clearRecord: vi.fn(async (expectedGeneration) => {
        cleared.push(expectedGeneration);
      }),
    });

    await Promise.all([
      writer.clear("generation-1"),
      writer.clear("generation-2"),
    ]);

    expect(cleared).toEqual(["generation-1", "generation-2"]);
  });

  it("keeps a newer discovery record when an older generation clears", async () => {
    await writeBrowserGatewayHelperDiscovery(record("generation-2"));

    await clearBrowserGatewayHelperDiscovery("generation-1");

    await expect(readBrowserGatewayHelperDiscovery()).resolves.toMatchObject({
      helperGenerationId: "generation-2",
    });
    await expect(
      fs.stat(getBrowserGatewayHelperDiscoveryPath()),
    ).resolves.toBeTruthy();

    await clearBrowserGatewayHelperDiscovery("generation-2");
    await expect(readBrowserGatewayHelperDiscovery()).resolves.toBeNull();
  });
});

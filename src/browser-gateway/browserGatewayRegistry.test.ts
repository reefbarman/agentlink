import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserGatewayRegistryPath,
  listBrowserGatewayInstances,
  listCheckedBrowserGatewayInstances,
  listHealthyBrowserGatewayInstances,
  listRegisteredBrowserGatewayInstances,
  upsertBrowserGatewayInstance,
} from "./browserGatewayRegistry.js";

const registryMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  beforeRead: undefined as ((path: string) => void) | undefined,
  staleLock: false,
}));

vi.mock("fs/promises", () => {
  const readFile = vi.fn(async (path: string) => {
    registryMock.beforeRead?.(path);
    const value = registryMock.files.get(path);
    if (value === undefined) {
      throw new Error("ENOENT");
    }
    return value;
  });
  const mkdir = vi.fn(async (path: string) => {
    if (path.endsWith(".lock") && registryMock.files.has(path)) {
      const error = new Error("EEXIST") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    registryMock.files.set(path, "__dir__");
  });
  const writeFile = vi.fn(async (path: string, content: string) => {
    registryMock.files.set(path, content);
  });
  const rename = vi.fn(async (from: string, to: string) => {
    const value = registryMock.files.get(from);
    if (value === undefined) {
      throw new Error("ENOENT");
    }
    registryMock.files.set(to, value);
    registryMock.files.delete(from);
  });
  const stat = vi.fn(async (path: string) => {
    if (!registryMock.files.has(path)) {
      throw new Error("ENOENT");
    }
    return {
      mtimeMs: registryMock.staleLock ? Date.now() - 11_000 : Date.now(),
    };
  });
  const rm = vi.fn(async (path: string) => {
    registryMock.files.delete(path);
  });

  return {
    default: { readFile, mkdir, writeFile, rename, stat, rm },
    readFile,
    mkdir,
    writeFile,
    rename,
    stat,
    rm,
  };
});

const registryPath = getBrowserGatewayRegistryPath();

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "instance-1",
    workspaceName: "Workspace",
    workspacePath: "/workspace",
    pid: 100,
    port: 4000,
    url: "http://127.0.0.1:4000",
    protocolVersion: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    authToken: "token",
    ...overrides,
  };
}

describe("browserGatewayRegistry", () => {
  const originalKill = process.kill;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    registryMock.files.clear();
    registryMock.beforeRead = undefined;
    registryMock.staleLock = false;
    process.kill = vi.fn(() => true) as unknown as typeof process.kill;
    globalThis.fetch = vi.fn(async () => ({ ok: true }) as Response);
  });

  afterEach(() => {
    process.kill = originalKill;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("preserves concurrently registered instances", async () => {
    const first = makeRecord({
      instanceId: "instance-a",
      workspaceName: "Workspace",
      workspacePath: "/workspace",
      port: 4001,
      url: "http://127.0.0.1:4001",
    });
    const second = makeRecord({
      instanceId: "instance-b",
      workspaceName: "Workspace",
      workspacePath: "/workspace",
      port: 4002,
      url: "http://127.0.0.1:4002",
    });

    await Promise.all([
      upsertBrowserGatewayInstance(first),
      upsertBrowserGatewayInstance(second),
    ]);

    await expect(listBrowserGatewayInstances()).resolves.toEqual([
      first,
      second,
    ]);
  });

  it("recovers a stale registry lock and registers the instance", async () => {
    const record = makeRecord();
    registryMock.staleLock = true;
    registryMock.files.set(`${registryPath}.lock`, "__dir__");

    await upsertBrowserGatewayInstance(record);

    await expect(listBrowserGatewayInstances()).resolves.toEqual([record]);
    expect(registryMock.files.has(`${registryPath}.lock`)).toBe(false);
  });

  it("keeps a live but transiently unreachable instance in the registered list", async () => {
    const transientlyUnreachable = makeRecord();
    registryMock.files.set(
      registryPath,
      JSON.stringify([transientlyUnreachable]),
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error("timeout");
    });

    const checked = await listCheckedBrowserGatewayInstances();
    const healthy = await listHealthyBrowserGatewayInstances();
    const registered = await listRegisteredBrowserGatewayInstances();

    expect(checked).toEqual({
      healthy: [],
      registered: [transientlyUnreachable],
    });
    expect(healthy).toEqual([]);
    expect(registered).toEqual([transientlyUnreachable]);
    await expect(listBrowserGatewayInstances()).resolves.toEqual([
      transientlyUnreachable,
    ]);
  });

  it("does not delete a freshly registered replacement while pruning a stale record", async () => {
    const stale = makeRecord({
      pid: 100,
      port: 4000,
      url: "http://127.0.0.1:4000",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const replacement = makeRecord({
      pid: 101,
      port: 4001,
      url: "http://127.0.0.1:4001",
      startedAt: "2026-01-01T00:00:05.000Z",
    });

    registryMock.files.set(registryPath, JSON.stringify([stale]));

    process.kill = vi.fn((pid: number) => {
      if (pid === 100) {
        const error = new Error("missing process") as Error & { code: string };
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as unknown as typeof process.kill;

    let registryReads = 0;
    registryMock.beforeRead = (path) => {
      if (path !== registryPath) return;
      registryReads += 1;
      if (registryReads === 2) {
        registryMock.files.set(registryPath, JSON.stringify([replacement]));
      }
    };

    const healthy = await listHealthyBrowserGatewayInstances();

    expect(healthy).toEqual([]);
    await expect(listBrowserGatewayInstances()).resolves.toEqual([replacement]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserGatewayRegistryPath,
  listBrowserGatewayInstances,
  listHealthyBrowserGatewayInstances,
} from "./browserGatewayRegistry.js";

const registryMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  beforeRead: undefined as ((path: string) => void) | undefined,
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
  const mkdir = vi.fn(async () => undefined);
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

  return {
    default: { readFile, mkdir, writeFile, rename },
    readFile,
    mkdir,
    writeFile,
    rename,
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
    process.kill = vi.fn(() => true) as unknown as typeof process.kill;
    globalThis.fetch = vi.fn(async () => ({ ok: true }) as Response);
  });

  afterEach(() => {
    process.kill = originalKill;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
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

import type { Stats } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveSandboxNodeRuntime,
  SandboxNodeRuntimeUnavailableError,
  type SandboxNodeRuntimeFileOperations,
} from "./sandboxNodeRuntime.js";

const extensionRoot = "/Applications/AgentLink Extension";
const nodePtyRoot = path.join(
  extensionRoot,
  "dist",
  "sandbox-runtime",
  "node_modules",
  "node-pty",
);

function metadata(overrides: Partial<Stats> = {}): Stats {
  return {
    isFile: () => true,
    mode: 0o100755,
    uid: 501,
    ...overrides,
  } as Stats;
}

function fileOperations(
  overrides: Partial<SandboxNodeRuntimeFileOperations> = {},
): SandboxNodeRuntimeFileOperations {
  return {
    access: vi.fn(async () => {}),
    realpath: vi.fn(async (candidate) => candidate),
    stat: vi.fn(async () => metadata()),
    ...overrides,
  };
}

describe("resolveSandboxNodeRuntime", () => {
  it("uses a compatible configured runtime without scanning PATH", async () => {
    const operations = fileOperations({
      realpath: vi.fn(async () => "/opt/node-v22/bin/node"),
    });
    const probe = vi.fn(async () => ({ ok: true }));

    await expect(
      resolveSandboxNodeRuntime({
        extensionRoot,
        configuredPath: "/Users/example/.local/bin/node",
        environmentPath: "/broken/bin:/also-broken/bin",
        platform: "darwin",
        architecture: "arm64",
        userId: 501,
        fileOperations: operations,
        probe,
      }),
    ).resolves.toEqual({
      executable: "/opt/node-v22/bin/node",
      source: "configured",
    });
    expect(probe).toHaveBeenCalledWith(
      "/opt/node-v22/bin/node",
      nodePtyRoot,
      "arm64",
    );
    expect(operations.realpath).toHaveBeenCalledTimes(1);
  });

  it("falls through incompatible PATH candidates to a standard location", async () => {
    const operations = fileOperations({
      realpath: vi.fn(async (candidate) => candidate),
      stat: vi.fn(async (candidate) => {
        if (candidate === "/missing/bin/node") throw new Error("missing");
        return metadata();
      }),
    });
    const probe = vi.fn(async (candidate: string) =>
      candidate === "/environment/bin/node"
        ? { ok: false, detail: "native ABI mismatch" }
        : { ok: true },
    );

    await expect(
      resolveSandboxNodeRuntime({
        extensionRoot,
        environmentPath: "/missing/bin:/environment/bin",
        platform: "darwin",
        architecture: "arm64",
        userId: 501,
        fileOperations: operations,
        probe,
      }),
    ).resolves.toEqual({
      executable: "/opt/homebrew/bin/node",
      source: "standard",
    });
    expect(probe).toHaveBeenNthCalledWith(
      1,
      "/environment/bin/node",
      nodePtyRoot,
      "arm64",
    );
    expect(probe).toHaveBeenNthCalledWith(
      2,
      "/opt/homebrew/bin/node",
      nodePtyRoot,
      "arm64",
    );
  });

  it.each([
    ["non-file", metadata({ isFile: () => false })],
    ["non-executable", metadata({ mode: 0o100644 })],
    ["writable by group", metadata({ mode: 0o100775 })],
    ["owned by another user", metadata({ uid: 502 })],
  ])("rejects an unsafe configured runtime: %s", async (_name, stats) => {
    const probe = vi.fn(async () => ({ ok: true }));

    const failure = resolveSandboxNodeRuntime({
      extensionRoot,
      configuredPath: "/unsafe/node",
      platform: "darwin",
      architecture: "arm64",
      userId: 501,
      fileOperations: fileOperations({ stat: vi.fn(async () => stats) }),
      probe,
    });

    await expect(failure).rejects.toBeInstanceOf(
      SandboxNodeRuntimeUnavailableError,
    );
    await expect(failure).rejects.toMatchObject({
      attempts: [expect.stringContaining("/unsafe/node")],
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports compatibility failures without silently selecting Electron", async () => {
    const failure = resolveSandboxNodeRuntime({
      extensionRoot,
      configuredPath: "/Applications/Visual Studio Code.app/Electron",
      platform: "darwin",
      architecture: "arm64",
      userId: 501,
      fileOperations: fileOperations(),
      probe: vi.fn(async () => ({
        ok: false,
        detail: "Electron is not a standalone Node runtime",
      })),
    });

    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("configured"),
      attempts: [expect.stringContaining("Electron is not a standalone Node")],
    });
  });

  it.each([
    ["linux", "arm64", "supports local macOS only"],
    ["darwin", "riscv64", "does not support architecture riscv64"],
  ])(
    "rejects unsupported host %s/%s",
    async (platform, architecture, message) => {
      await expect(
        resolveSandboxNodeRuntime({
          extensionRoot,
          platform: platform as NodeJS.Platform,
          architecture,
        }),
      ).rejects.toThrow(message);
    },
  );
});

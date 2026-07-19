import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDeferredNodePtyLoader,
  loadNodePtyForHostShellPlan,
  STAGED_NODE_PTY_RELATIVE_PATH,
  type NodePtyLoaderFileOperations,
  type NodePtyModuleLoader,
} from "./deferredNodePtyLoader.js";
import type { HostShellBootstrapPlan } from "./hostShellBootstrap.js";
import type { NodePtyModule } from "./nodePtyFactory.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";

const extensionRoot = "/Applications/AgentLink Extension";
const packageRoot = path.join(extensionRoot, STAGED_NODE_PTY_RELATIVE_PATH);

function profile(shellPath = "/bin/zsh"): ResolvedHostShellProfile {
  return {
    profileName: path.basename(shellPath),
    provenance: "configured",
    shellPath,
    shellArgs: [],
    environment: {},
    cwd: "/workspace",
  };
}

function integratedPlan(): HostShellBootstrapPlan {
  return {
    mode: "integrated",
    shell: "zsh",
    nonce: "loader_nonce_123456",
    artifactDirectory: "/runtime/session",
    files: [],
    profile: profile(),
  };
}

function rawPlan(): HostShellBootstrapPlan {
  return { mode: "raw", profile: profile("/bin/sh") };
}

function fallbackPlan(
  reason = "native-shell-required",
): HostShellBootstrapPlan {
  return {
    mode: "native-fallback",
    reason,
    message: "native fallback",
    profile: profile("/opt/homebrew/bin/fish"),
  };
}

function fakeFileOperations(overrides?: {
  missing?: readonly string[];
  symlinks?: readonly string[];
  existing?: readonly string[];
  metadata?: unknown;
}): NodePtyLoaderFileOperations {
  const missing = new Set(overrides?.missing ?? []);
  const symlinks = new Set(overrides?.symlinks ?? []);
  const existing = new Set(overrides?.existing ?? []);
  const files = new Set([
    path.join(packageRoot, "package.json"),
    path.join(packageRoot, "lib", "index.js"),
    path.join(packageRoot, "lib", "utils.js"),
    path.join(packageRoot, "lib", "unixTerminal.js"),
    path.join(packageRoot, "prebuilds", "darwin-arm64", "pty.node"),
    path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
  ]);
  const directories = new Set([
    packageRoot,
    path.join(packageRoot, "prebuilds", "darwin-arm64"),
  ]);
  return {
    exists: (entryPath) => existing.has(entryPath),
    lstat: (entryPath) => {
      if (missing.has(entryPath)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return {
        isSymbolicLink: () => symlinks.has(entryPath),
        isFile: () => files.has(entryPath),
        isDirectory: () => directories.has(entryPath),
      } as ReturnType<NodePtyLoaderFileOperations["lstat"]>;
    },
    readFile: () =>
      JSON.stringify(
        overrides?.metadata ?? {
          name: "node-pty",
          version: "1.1.0",
          main: "./lib/index.js",
        },
      ),
  };
}

describe("deferred node-pty loader", () => {
  it("does not touch files or create a require until load", () => {
    const fileOperations = fakeFileOperations();
    const lstat = vi.spyOn(fileOperations, "lstat");
    const createRequire = vi.fn();

    createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations,
      createRequire,
    });

    expect(lstat).not.toHaveBeenCalled();
    expect(createRequire).not.toHaveBeenCalled();
  });

  it("validates and anchors resolution to the staged extension package", () => {
    const nodePty = { spawn: vi.fn() } as unknown as NodePtyModule;
    const requireModule = vi.fn(() => nodePty);
    const createRequire = vi.fn(() => requireModule);
    const loader = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations(),
      createRequire,
    });

    expect(loader.load()).toBe(nodePty);
    expect(createRequire).toHaveBeenCalledWith(
      path.join(packageRoot, "package.json"),
    );
    expect(requireModule).toHaveBeenCalledWith(packageRoot);
    expect(loader.load()).toBe(nodePty);
    expect(requireModule).toHaveBeenCalledTimes(1);
  });

  it("validates extension-root ownership before load", () => {
    const createRequire = vi.fn();
    expect(() =>
      createDeferredNodePtyLoader({ extensionRoot: "relative", createRequire }),
    ).toThrow("extensionRoot must be an absolute path without NUL");
    expect(() =>
      createDeferredNodePtyLoader({
        extensionRoot: "/extension\0escape",
        createRequire,
      }),
    ).toThrow("extensionRoot must be an absolute path without NUL");
    expect(createRequire).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported platform", { platform: "linux" as const }],
    ["unsupported architecture", { architecture: "ia32" }],
  ])("rejects %s before require", (_name, override) => {
    const createRequire = vi.fn();
    const loader = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations(),
      createRequire,
      ...override,
    });

    expect(() => loader.load()).toThrow(/supported only|does not support/);
    expect(createRequire).not.toHaveBeenCalled();
  });

  it("rejects missing, symlinked, and unexpected build entries", () => {
    const ptyBinary = path.join(
      packageRoot,
      "prebuilds",
      "darwin-arm64",
      "pty.node",
    );
    const missing = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations({ missing: [ptyBinary] }),
      createRequire: vi.fn(),
    });
    const symlinked = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations({ symlinks: [ptyBinary] }),
      createRequire: vi.fn(),
    });
    const buildOutput = path.join(packageRoot, "build", "Release");
    const ambiguous = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations({ existing: [buildOutput] }),
      createRequire: vi.fn(),
    });

    expect(() => missing.load()).toThrow("is missing");
    expect(() => symlinked.load()).toThrow("must not be a symlink");
    expect(() => ambiguous.load()).toThrow("unexpected build output");
  });

  it.each([
    { name: "wrong package", version: "1.1.0", main: "./lib/index.js" },
    { name: "node-pty", version: "2.0.0", main: "./lib/index.js" },
    { name: "node-pty", version: "1.1.0", main: "./evil.js" },
  ])("rejects unpinned package metadata: $name $version $main", (metadata) => {
    const loader = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations({ metadata }),
      createRequire: vi.fn(),
    });
    expect(() => loader.load()).toThrow("metadata must be node-pty 1.1.0");
  });

  it("rejects invalid module shapes and retries rather than caching failure", () => {
    const valid = { spawn: vi.fn() } as unknown as NodePtyModule;
    const requireModule = vi
      .fn<() => unknown>()
      .mockReturnValueOnce({ default: valid })
      .mockReturnValueOnce(valid);
    const loader = createDeferredNodePtyLoader({
      extensionRoot,
      platform: "darwin",
      architecture: "arm64",
      fileOperations: fakeFileOperations(),
      createRequire: () => requireModule,
    });

    expect(() => loader.load()).toThrow(
      "does not expose the required spawn function",
    );
    expect(loader.load()).toBe(valid);
    expect(requireModule).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unsupported host", fallbackPlan("host-unsupported")],
    ["fish", fallbackPlan("native-shell-required")],
    ["unknown shell", fallbackPlan("shell-unsupported")],
    ["unsafe configuration", fallbackPlan("terminal-configuration-unsafe")],
    ["unsupported bootstrap argv", fallbackPlan("unsupported-bash-arguments")],
  ])("does not load node-pty for plan fallback: %s", (_name, plan) => {
    const loader: NodePtyModuleLoader = { load: vi.fn() };

    expect(loadNodePtyForHostShellPlan(plan, loader)).toEqual({
      mode: "native-fallback",
      plan,
    });
    expect(loader.load).not.toHaveBeenCalled();
  });

  it.each([
    ["integrated", integratedPlan()],
    ["raw", rawPlan()],
  ])("loads once after a custom bootstrap plan: %s", (_name, plan) => {
    const nodePty = { spawn: vi.fn() } as unknown as NodePtyModule;
    const loader: NodePtyModuleLoader = { load: vi.fn(() => nodePty) };

    expect(loadNodePtyForHostShellPlan(plan, loader)).toEqual({
      mode: "custom",
      plan,
      nodePty,
    });
    expect(loader.load).toHaveBeenCalledTimes(1);
  });
});

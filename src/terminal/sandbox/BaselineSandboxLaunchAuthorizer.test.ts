import {
  SandboxCapabilityAuthority,
  createSandboxLaunchBindingDigest,
} from "./SandboxCapabilityAuthority.js";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { BaselineSandboxLaunchAuthorizer } from "./BaselineSandboxLaunchAuthorizer.js";
import { CURRENT_SANDBOX_POLICY_VERSION } from "../../core/sandboxPolicy.js";
import type { SandboxCapabilityGrantTimingEvent } from "./sandboxCapabilityGrantTiming.js";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function createWorkspaceFixtureRoot(prefix: string): Promise<string> {
  const parent = path.join(process.cwd(), "tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, prefix));
}

async function fixture() {
  const root = await createWorkspaceFixtureRoot("al-authorizer-");
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  await Promise.all([
    mkdir(path.join(workspace, ".git", "hooks"), { recursive: true }),
    mkdir(path.join(workspace, ".git", "refs", "remotes", "origin"), {
      recursive: true,
    }),
    mkdir(path.join(workspace, ".agentlink", "history", "session-1"), {
      recursive: true,
    }),
    mkdir(path.join(workspace, ".agentlink", "transcripts"), {
      recursive: true,
    }),
    mkdir(path.join(workspace, ".agentlink", "debug"), { recursive: true }),
    mkdir(path.join(workspace, ".agentlink", "checkpoints"), {
      recursive: true,
    }),
    mkdir(path.join(workspace, ".agentlink", "tool-usage-report"), {
      recursive: true,
    }),
    mkdir(path.join(workspace, ".agents"), { recursive: true }),
    mkdir(path.join(workspace, ".codex"), { recursive: true }),
    mkdir(privateRoot),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, ".git", "config"), "[core]\n"),
    writeFile(path.join(workspace, ".git", "hooks", "pre-commit"), "exit 0\n"),
    writeFile(
      path.join(workspace, ".git", "refs", "remotes", "origin", "main"),
      "a".repeat(40),
    ),
    writeFile(path.join(workspace, ".agentlink", "policy.json"), "{}"),
    writeFile(path.join(workspace, ".agents", "config.json"), "{}"),
    writeFile(path.join(workspace, ".codex", "config.toml"), ""),
    writeFile(path.join(workspace, "AGENTS.md"), "# Instructions\n"),
    writeFile(
      path.join(
        workspace,
        ".agentlink",
        "history",
        "session-1",
        "messages.json",
      ),
      "[]",
    ),
  ]);
  const authorizer = new BaselineSandboxLaunchAuthorizer({
    workspaceRoots: [workspace],
    privateDirectoryPrefix: path.join(privateRoot, "al-"),
    homeDirectory: path.join(root, "real-home"),
    hostTemporaryDirectory: os.tmpdir(),
  });
  return {
    root,
    workspace,
    privateRoot,
    hostTemporaryDirectory: os.tmpdir(),
    authorizer,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function authorizeAndActivate(
  authorizer: BaselineSandboxLaunchAuthorizer,
  input: Parameters<BaselineSandboxLaunchAuthorizer["authorize"]>[0],
) {
  const prepared = await authorizer.authorize(input);
  const active = prepared.activate();
  return {
    ...active,
    policy: prepared.policy,
    bindingDigest: prepared.bindingDigest,
    finalize: prepared.finalize,
  };
}

function request(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Parameters<BaselineSandboxLaunchAuthorizer["authorize"]>[0] {
  return {
    options: {
      owner: undefined,
      command: "git status --short",
      cwd: workspace,
      sandboxSessionId: "session-1",
      env: {
        CUSTOM_FLAG: "yes",
      },
      ...overrides,
    },
    channelId: "sandbox-1",
    commandId: "command-1",
    generation: 1,
    dimensions: { columns: 100, rows: 40 },
  };
}

describe("BaselineSandboxLaunchAuthorizer", () => {
  it("allows only an explicitly validated canonical runtime directory", async () => {
    const test = await fixture();
    const runtimeRoot = path.join(test.root, "runtime");
    await mkdir(runtimeRoot);
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-runtime-"),
      homeDirectory: path.join(test.root, "real-home"),
      trustedRuntimeRoots: [runtimeRoot],
    });
    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace),
      );
      expect(launch.policy.readableRoots).toEqual(["/"]);
      expect(launch.policy.writableRoots).not.toContain(
        await realpath(runtimeRoot),
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("compiles a loopback workspace-write policy without a grant", async () => {
    const test = await fixture();
    try {
      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace),
      );
      const policy = launch.policy;
      const environment = policy.environment.values;
      const canonicalWorkspace = await realpath(test.workspace);

      expect(policy).toMatchObject({
        version: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: "workspace-write",
        network: { mode: "loopback" },
        deniedRoots: [],
        allowedUnixSockets: [],
      });
      expect(policy.writableRoots).toContain(canonicalWorkspace);
      expect(policy.readableRoots).toEqual(["/"]);
      expect(environment.TMPDIR).toBe(
        await realpath(test.hostTemporaryDirectory),
      );
      expect(policy.writableRoots).toEqual(
        expect.arrayContaining(["/tmp", "/private/tmp"]),
      );
      expect(policy.readableRoots).toEqual(["/"]);
      expect(policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          path.join(canonicalWorkspace, ".git"),
          path.join(canonicalWorkspace, ".agentlink"),
          path.join(canonicalWorkspace, ".agents"),
          path.join(canonicalWorkspace, ".claude"),
          path.join(canonicalWorkspace, ".codex"),
          path.join(canonicalWorkspace, "AGENT.md"),
          path.join(canonicalWorkspace, "AGENTS.md"),
          path.join(canonicalWorkspace, "AGENTS.local.md"),
          path.join(canonicalWorkspace, "CLAUDE.md"),
          "/private/tmp/claude",
          "/tmp/claude",
        ]),
      );
      expect(policy.protectedReadOnlyRoots).toEqual(
        expect.arrayContaining([
          path.join(canonicalWorkspace, ".git", "config"),
          path.join(canonicalWorkspace, ".git", "hooks"),
          path.join(canonicalWorkspace, ".agentlink", "policy.json"),
          path.join(canonicalWorkspace, ".agents", "config.json"),
          path.join(canonicalWorkspace, ".codex", "config.toml"),
          path.join(canonicalWorkspace, "AGENTS.md"),
        ]),
      );
      for (const volatileGitRoot of [
        path.join(canonicalWorkspace, ".git"),
        path.join(canonicalWorkspace, ".git", "refs"),
        path.join(canonicalWorkspace, ".git", "refs", "remotes", "origin"),
      ]) {
        expect(policy.protectedReadOnlyRoots).not.toContain(volatileGitRoot);
      }
      expect(policy.structurallyProtectedRoots).toEqual([
        path.join(canonicalWorkspace, ".git"),
      ]);
      expect(policy.protectedReadOnlyRoots).not.toContain(
        path.join(canonicalWorkspace, ".agentlink"),
      );
      for (const runtimeEntry of [
        "history",
        "transcripts",
        "debug",
        "checkpoints",
        "tool-usage-report",
      ]) {
        expect(policy.protectedReadOnlyRoots).not.toContain(
          path.join(canonicalWorkspace, ".agentlink", runtimeEntry),
        );
      }
      expect(launch.helperRequest.filesystem.denyRead).toEqual([]);
      expect(launch.helperRequest.filesystem.denyWrite).toEqual(
        policy.deniedWriteRoots,
      );
      expect(launch.helperRequest.protectedRoots).toEqual(
        policy.protectedReadOnlyRoots,
      );
      expect(launch.helperRequest.structurallyProtectedRoots).toEqual(
        policy.structurallyProtectedRoots,
      );
      expect(environment.CUSTOM_FLAG).toBe("yes");
      expect(launch.metadata.environmentBudget).toMatchObject({
        limitBytes: 768 * 1024,
        estimatedBytes: expect.any(Number),
        protectedBytes: expect.any(Number),
        dropped: [],
      });
      expect(environment).toMatchObject({
        AGENTLINK: "1",
        GIT_TERMINAL_PROMPT: "0",
        PAGER: process.platform === "win32" ? "" : "cat",
        GIT_PAGER: process.platform === "win32" ? "" : "cat",
        MANPAGER: process.platform === "win32" ? "" : "cat",
      });
      expect(environment.SSH_AUTH_SOCK).toBeUndefined();
      expect(environment.HOME).toBe(path.join(test.root, "real-home"));
      expect(launch.metadata.environmentPolicy).toEqual({
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: [],
        setKeys: [],
        includeOnly: [],
        useProfile: false,
      });
      expect(environment.XDG_CACHE_HOME).toMatch(/\/private\/al-[^/]+\/c$/);
      expect(environment.CLAUDE_CODE_TMPDIR).toMatch(/\/private\/al-[^/]+\/t$/);
      expect(environment.PATH).not.toContain("attacker");
      if (await exists("/var/select/developer_dir")) {
        expect(environment.DEVELOPER_DIR).toBe(
          await realpath("/var/select/developer_dir"),
        );
        expect(policy.readableRoots).toEqual(["/"]);
        expect(environment.xcrun_db).toBe(
          path.join(environment.CLAUDE_CODE_TMPDIR, "xcrun_db"),
        );
      }
      expect(launch.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(launch.metadata.capabilityRequest).toBeUndefined();
      expect(launch.metadata.grant).toBeUndefined();
      expect(launch.helperRequest.network).toEqual({ mode: "loopback" });
      expect(launch.metadata.capabilities).toMatchObject({
        filesystemRead: "host-visible",
        filesystemWrite: "strict",
        network: "loopback",
        privateHome: false,
        privateTmp: false,
        hostIpcBlocked: false,
      });

      const privateCommandRoot = path.dirname(environment.XDG_CACHE_HOME);
      expect(await exists(privateCommandRoot)).toBe(true);
      launch.finalize?.();
      await expect.poll(() => exists(privateCommandRoot)).toBe(false);
    } finally {
      await test.dispose();
    }
  });

  it("drops only oversized host-inherited entries and records token-free metadata", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-budget-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      environmentBudgetBytes: 2_100,
      hostEnvironment: {
        PATH: "/usr/bin:/bin",
        HOST_LARGE_B: "b".repeat(600),
        HOST_LARGE_A: "a".repeat(600),
      },
      environmentPolicy: { set: { POLICY_VALUE: "policy-protected" } },
    });
    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace, {
          env: { COMMAND_VALUE: "command-protected" },
        }),
      );
      expect(launch.policy.environment.values.POLICY_VALUE).toBe(
        "policy-protected",
      );
      expect(launch.policy.environment.values.COMMAND_VALUE).toBe(
        "command-protected",
      );
      expect(launch.policy.environment.values.HOST_LARGE_A).toBeUndefined();
      expect(launch.metadata.environmentBudget?.dropped).toEqual([
        { name: "HOST_LARGE_A", bytes: 614 },
      ]);
      expect(launch.policy.environment.values.HOST_LARGE_B).toBe(
        "b".repeat(600),
      );
      expect(JSON.stringify(launch.metadata)).not.toContain("policy-protected");
      expect(JSON.stringify(launch.metadata)).not.toContain(
        "command-protected",
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("fails closed when protected command environment exceeds the budget", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(
        test.privateRoot,
        "al-protected-budget-",
      ),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      environmentBudgetBytes: 1_500,
      hostEnvironment: { PATH: "/usr/bin:/bin" },
    });
    try {
      await expect(
        authorizer.authorize(
          request(test.workspace, {
            env: { COMMAND_VALUE: "x".repeat(1_000) },
          }),
        ),
      ).rejects.toThrow(
        /protected environment contributors exceed.*COMMAND_VALUE/,
      );
    } finally {
      await test.dispose();
    }
  });

  it("inherits credential-like names by default without exposing values in metadata", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-credentials-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      hostEnvironment: {
        PATH: "/usr/bin:/bin",
        OPENAI_API_KEY: "secret-key-value",
        SERVICE_SECRET: "secret-value",
        SESSION_TOKEN: "token-value",
      },
    });
    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace),
      );
      expect(launch.policy.environment.values).toMatchObject({
        OPENAI_API_KEY: "secret-key-value",
        SERVICE_SECRET: "secret-value",
        SESSION_TOKEN: "token-value",
      });
      expect(launch.metadata.environmentPolicy).toEqual({
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: [],
        setKeys: [],
        includeOnly: [],
        useProfile: false,
      });
      expect(JSON.stringify(launch.metadata)).not.toContain("secret-key-value");
      expect(JSON.stringify(launch.metadata)).not.toContain("secret-value");
      expect(JSON.stringify(launch.metadata)).not.toContain("token-value");
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("applies configured inheritance and filters before command overrides", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-filtered-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      hostEnvironment: {
        HOME: path.join(test.root, "real-home"),
        PATH: "/usr/bin:/bin",
        USER: "test-user",
        OPENAI_API_KEY: "host-secret",
        CUSTOM_FLAG: "host",
      },
      environmentPolicy: {
        inherit: "core",
        exclude: ["user"],
        set: { CUSTOM_FLAG: "configured", CONFIG_TOKEN: "configured-token" },
        includeOnly: ["path", "custom_*", "config_*"],
      },
    });
    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace, {
          env: { CUSTOM_FLAG: "command", COMMAND_VALUE: "yes" },
        }),
      );
      const environment = launch.policy.environment.values;
      expect(environment).toMatchObject({
        PATH: expect.any(String),
        CUSTOM_FLAG: "command",
        CONFIG_TOKEN: "configured-token",
        COMMAND_VALUE: "yes",
        HOME: path.join(test.root, "real-home"),
      });
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.USER).toBeUndefined();
      expect(launch.metadata.environmentPolicy).toEqual({
        inherit: "core",
        ignoreDefaultExcludes: true,
        exclude: ["user"],
        setKeys: ["CONFIG_TOKEN", "CUSTOM_FLAG"],
        includeOnly: ["path", "custom_*", "config_*"],
        useProfile: false,
      });
      expect(JSON.stringify(launch.metadata)).not.toContain("configured-token");
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("fails closed when shell profile inheritance is requested", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-profile-"),
      homeDirectory: path.join(test.root, "real-home"),
      environmentPolicy: { useProfile: true },
    });
    try {
      await expect(
        authorizer.authorize(request(test.workspace)),
      ).rejects.toThrow("useProfile is not supported");
    } finally {
      await test.dispose();
    }
  });

  it("uses a disposable writable HOME and sandbox-owned Go caches", async () => {
    const test = await fixture();
    try {
      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace, { temporaryHome: true }),
      );
      const environment = launch.policy.environment.values;
      const privateRoot = path.dirname(environment.HOME);
      expect(environment.HOME).toBe(path.join(privateRoot, "h"));
      expect(environment.XDG_CACHE_HOME).toBe(path.join(privateRoot, "c"));
      expect(environment.GOCACHE).toBe(path.join(privateRoot, "c", "go-build"));
      expect(environment.GOLANGCI_LINT_CACHE).toBe(
        path.join(privateRoot, "c", "golangci-lint"),
      );
      expect(await readdir(environment.HOME)).toEqual([]);
      expect(launch.policy.readableRoots).toEqual(["/"]);
      expect(launch.policy.writableRoots).toContain(privateRoot);
      expect(launch.metadata.capabilities.privateHome).toBe(true);
      expect(launch.metadata.capabilities.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("fresh writable per-command directory"),
          expect.stringContaining("host home remains readable"),
          expect.stringContaining("Go and GolangCI caches"),
        ]),
      );

      launch.finalize?.();
      expect(await exists(privateRoot)).toBe(false);
    } finally {
      await test.dispose();
    }
  });

  it("keeps the host HOME by default while overriding inherited Go cache paths", async () => {
    const test = await fixture();
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-cache-defaults-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostEnvironment: {
        PATH: process.env.PATH,
        GOCACHE: path.join(test.root, "host-go-cache"),
        GOLANGCI_LINT_CACHE: path.join(test.root, "host-golangci-cache"),
      },
    });
    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace),
      );
      const environment = launch.policy.environment.values;
      const privateRoot = path.dirname(environment.XDG_CACHE_HOME);

      expect(environment.HOME).toBe(path.join(test.root, "real-home"));
      expect(environment.GOCACHE).toBe(path.join(privateRoot, "c", "go-build"));
      expect(environment.GOLANGCI_LINT_CACHE).toBe(
        path.join(privateRoot, "c", "golangci-lint"),
      );
      expect(launch.metadata.capabilities.privateHome).toBe(false);
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("preserves explicit reviewed Go cache overrides", async () => {
    const test = await fixture();
    try {
      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace, {
          env: {
            GOCACHE: path.join(test.workspace, ".cache", "go"),
            GOLANGCI_LINT_CACHE: path.join(
              test.workspace,
              ".cache",
              "golangci-lint",
            ),
          },
        }),
      );
      expect(launch.policy.environment.values).toMatchObject({
        GOCACHE: path.join(test.workspace, ".cache", "go"),
        GOLANGCI_LINT_CACHE: path.join(
          test.workspace,
          ".cache",
          "golangci-lint",
        ),
      });
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("lets explicit command environment override shared agent defaults", async () => {
    const test = await fixture();
    try {
      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace, { env: { GIT_PAGER: "less" } }),
      );
      expect(launch.policy.environment.values.GIT_PAGER).toBe("less");
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("ignores unrelated nested policy aliases while retaining namespace write denial", async () => {
    const test = await fixture();
    const external = path.join(test.root, "external-clickhouse-skill");
    const skills = path.join(test.workspace, ".claude", "skills");
    const alias = path.join(skills, "clickhouse");
    try {
      await mkdir(external);
      await mkdir(skills, { recursive: true });
      await writeFile(path.join(external, "SKILL.md"), "# External\n");
      await writeFile(path.join(skills, "local.md"), "# Local\n");
      await symlink(external, alias);

      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace),
      );
      const policy = launch.policy;
      expect(policy.deniedWriteRoots).toContain(
        path.join(await realpath(test.workspace), ".claude"),
      );
      expect(policy.protectedReadOnlyRoots).toContain(
        await realpath(path.join(skills, "local.md")),
      );
      expect(policy.protectedReadOnlyRoots).not.toContain(
        await realpath(alias),
      );
      expect(policy.protectedReadOnlyRoots).not.toContain(
        await realpath(path.join(external, "SKILL.md")),
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it.each([
    ["namespace root", ".claude"],
    ["selected subtree", path.join(".claude", "skills")],
    ["direct config file", path.join(".claude", "CLAUDE.md")],
  ])(
    "fails closed when a protected policy %s is a symlink",
    async (_label, relative) => {
      const test = await fixture();
      const candidate = path.join(test.workspace, relative);
      const external = path.join(
        test.root,
        `external-${relative.replaceAll(path.sep, "-")}`,
      );
      try {
        await mkdir(path.dirname(candidate), { recursive: true });
        await mkdir(external);
        if (relative.endsWith(".md")) {
          await rm(candidate, { force: true });
          await writeFile(path.join(external, "target.md"), "# External\n");
          await symlink(path.join(external, "target.md"), candidate);
        } else {
          await rm(candidate, { recursive: true, force: true });
          await symlink(external, candidate);
        }

        await expect(
          test.authorizer.authorize(request(test.workspace)),
        ).rejects.toThrow(
          /policy (?:namespace|entry) must not be a symbolic link/,
        );
        await expect.poll(async () => readdir(test.privateRoot)).toEqual([]);
      } finally {
        await test.dispose();
      }
    },
  );

  it.each(["agents", "history"])(
    "fails closed when .agentlink/%s is a symlink",
    async (entry) => {
      const test = await fixture();
      const candidate = path.join(test.workspace, ".agentlink", entry);
      const external = path.join(test.root, `external-agentlink-${entry}`);
      try {
        await mkdir(external);
        await rm(candidate, { recursive: true, force: true });
        await symlink(external, candidate);

        await expect(
          test.authorizer.authorize(request(test.workspace)),
        ).rejects.toThrow("policy entry must not be a symbolic link");
        await expect.poll(async () => readdir(test.privateRoot)).toEqual([]);
      } finally {
        await test.dispose();
      }
    },
  );

  it("protects a valid instruction alias through a symlinked workspace root", async () => {
    const test = await fixture();
    const workspaceAlias = path.join(test.root, "workspace-alias");
    const instruction = path.join(test.workspace, "AGENTS.md");
    const target = path.join(test.workspace, "CLAUDE.md");
    try {
      await writeFile(target, "# Shared instructions\n");
      await rm(instruction);
      await symlink("CLAUDE.md", instruction);
      await symlink(test.workspace, workspaceAlias, "dir");
      const authorizer = new BaselineSandboxLaunchAuthorizer({
        workspaceRoots: [workspaceAlias],
        privateDirectoryPrefix: path.join(test.privateRoot, "alias-"),
        homeDirectory: path.join(test.root, "real-home"),
        hostTemporaryDirectory: os.tmpdir(),
      });

      const launch = await authorizeAndActivate(
        authorizer,
        request(workspaceAlias),
      );
      const canonicalTarget = await realpath(target);
      expect(launch.policy.protectedReadOnlyRoots).toContain(canonicalTarget);
      expect(launch.metadata.capabilities.warnings).not.toContainEqual(
        expect.stringContaining("Ignored invalid workspace instruction file"),
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("allows a root instruction alias to another declared regular instruction file", async () => {
    const test = await fixture();
    const instruction = path.join(test.workspace, "AGENTS.md");
    const target = path.join(test.workspace, "CLAUDE.md");
    try {
      await writeFile(target, "# Shared instructions\n");
      await rm(instruction);
      await symlink("CLAUDE.md", instruction);

      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace),
      );
      const canonicalWorkspace = await realpath(test.workspace);
      expect(launch.policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          path.join(canonicalWorkspace, "AGENTS.md"),
          path.join(canonicalWorkspace, "CLAUDE.md"),
        ]),
      );
      expect(launch.policy.protectedReadOnlyRoots).toContain(
        await realpath(target),
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it.each([
    ["external target", "external"],
    ["undeclared workspace file", "undeclared"],
    ["path-bearing declared target", "path-bearing"],
    ["missing declared target", "missing"],
    ["instruction symlink chain", "chain"],
  ])(
    "ignores and warns about a root instruction alias with %s",
    async (_label, kind) => {
      const test = await fixture();
      const instruction = path.join(test.workspace, "AGENTS.md");
      try {
        await rm(instruction);
        if (kind === "external") {
          const external = path.join(test.root, "external-AGENTS.md");
          await writeFile(external, "# External\n");
          await symlink(external, instruction);
        } else if (kind === "undeclared") {
          const target = path.join(test.workspace, "README.md");
          await writeFile(target, "# Readme\n");
          await symlink("README.md", instruction);
        } else if (kind === "path-bearing") {
          const target = path.join(test.workspace, "CLAUDE.md");
          await writeFile(target, "# Shared instructions\n");
          await symlink("nested/../CLAUDE.md", instruction);
        } else if (kind === "missing") {
          await rm(path.join(test.workspace, "CLAUDE.md"), { force: true });
          await symlink("CLAUDE.md", instruction);
        } else {
          const target = path.join(test.workspace, "CLAUDE.md");
          const finalTarget = path.join(test.workspace, "AGENT.md");
          await rm(target, { force: true });
          await writeFile(finalTarget, "# Final\n");
          await symlink("AGENT.md", target);
          await symlink("CLAUDE.md", instruction);
        }

        const launch = await authorizeAndActivate(
          test.authorizer,
          request(test.workspace),
        );
        const canonicalWorkspace = await realpath(test.workspace);
        expect(launch.policy.deniedWriteRoots).toContain(
          path.join(canonicalWorkspace, "AGENTS.md"),
        );
        expect(launch.policy.protectedReadOnlyRoots).not.toContain(
          path.join(canonicalWorkspace, "AGENTS.md"),
        );
        expect(launch.metadata.capabilities.warnings).toContainEqual(
          expect.stringContaining("Ignored invalid workspace instruction file"),
        );
        launch.finalize?.();
      } finally {
        await test.dispose();
      }
    },
  );

  it("fails closed when the workspace .git path is a symbolic link", async () => {
    const test = await fixture();
    const dotGit = path.join(test.workspace, ".git");
    const externalGit = path.join(test.root, "external.git");
    try {
      await rm(dotGit, { recursive: true });
      await mkdir(externalGit);
      await symlink(externalGit, dotGit);

      await expect(
        test.authorizer.authorize(request(test.workspace)),
      ).rejects.toThrow(".git path must not be a symbolic link");
      await expect.poll(async () => readdir(test.privateRoot)).toEqual([]);
    } finally {
      await test.dispose();
    }
  });

  it("fails closed when a protected Git control entry is a symbolic link", async () => {
    const test = await fixture();
    const hooks = path.join(test.workspace, ".git", "hooks");
    const externalHooks = path.join(test.root, "external-hooks");
    try {
      await rm(hooks, { recursive: true });
      await mkdir(externalHooks);
      await symlink(externalHooks, hooks);

      await expect(
        test.authorizer.authorize(request(test.workspace)),
      ).rejects.toThrow("Git integrity entry must not be a symbolic link");
      await expect.poll(async () => readdir(test.privateRoot)).toEqual([]);
    } finally {
      await test.dispose();
    }
  });

  it("resolves and protects worktree-specific and common Git directories", async () => {
    const root = await createWorkspaceFixtureRoot("al-worktree-policy-");
    const workspace = path.join(root, "workspace");
    const commonGit = path.join(root, "common.git");
    const worktreeGit = path.join(commonGit, "worktrees", "workspace");
    const privateRoot = path.join(root, "private");
    try {
      await Promise.all([
        mkdir(workspace),
        mkdir(worktreeGit, { recursive: true }),
        mkdir(privateRoot),
      ]);
      await Promise.all([
        writeFile(path.join(workspace, ".git"), `gitdir: ${worktreeGit}\n`),
        writeFile(path.join(worktreeGit, "commondir"), "../..\n"),
        writeFile(path.join(commonGit, "config"), "[core]\n"),
      ]);
      const authorizer = new BaselineSandboxLaunchAuthorizer({
        workspaceRoots: [workspace],
        privateDirectoryPrefix: path.join(privateRoot, "al-"),
      });

      const launch = await authorizeAndActivate(authorizer, request(workspace));
      const canonicalCommonGit = await realpath(commonGit);
      expect(launch.policy.readableRoots).toEqual(["/"]);
      expect(launch.policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          canonicalCommonGit,
        ]),
      );
      expect(launch.policy.protectedReadOnlyRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          await realpath(path.join(worktreeGit, "commondir")),
          await realpath(path.join(commonGit, "config")),
        ]),
      );
      expect(launch.policy.protectedReadOnlyRoots).not.toContain(
        canonicalCommonGit,
      );
      expect(launch.policy.structurallyProtectedRoots).toEqual([
        canonicalCommonGit,
      ]);
      launch.finalize?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-hashes inline files covered by a readable development-temp root", async () => {
    const test = await fixture();
    const inlineRoot = await mkdtemp(
      path.join(os.tmpdir(), "al-inline-policy-"),
    );
    const inlinePath = path.join(inlineRoot, "body.md");
    try {
      const content = "hello `code`";
      await writeFile(inlinePath, content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const launch = await authorizeAndActivate(
        test.authorizer,
        request(test.workspace, {
          command: `cat '${inlinePath}'`,
          sandboxInlineFiles: [
            {
              name: "body",
              path: inlinePath,
              bytes: Buffer.byteLength(content),
              sha256,
            },
          ],
        }),
      );

      const canonicalInlineRoot = await realpath(inlineRoot);
      expect(launch.policy.readableRoots).toEqual(["/"]);
      expect(canonicalInlineRoot).toMatch(/^\//);
      const expectedBinding = createSandboxLaunchBindingDigest({
        command: `cat '${inlinePath}'`,
        cwd: await realpath(test.workspace),
        environment: launch.policy.environment.values,
        inlineFiles: [
          { name: "body", bytes: Buffer.byteLength(content), sha256 },
        ],
        sessionId: "session-1",
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: "workspace-write",
        capability: { publicNetwork: false, localBinding: false },
      });
      expect(launch.bindingDigest).toBe(expectedBinding);
      launch.finalize?.();
    } finally {
      await rm(inlineRoot, { recursive: true, force: true });
      await test.dispose();
    }
  });

  it("issues no grant until launch and tolerates preparation beyond the legacy TTL", async () => {
    const test = await fixture();
    let now = 100;
    let nextId = 1;
    const timingEvents: SandboxCapabilityGrantTimingEvent[] = [];
    const capabilityAuthority = new SandboxCapabilityAuthority({
      now: () => now,
      createId: () => `grant-id-${nextId++}`,
    });
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(
        test.privateRoot,
        "al-delayed-network-",
      ),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      capabilityAuthority,
      capabilityGrantTtlMs: 100,
      now: () => now,
      onCapabilityGrantTimingEvent: (event) => timingEvents.push(event),
    });

    try {
      const prepared = await authorizer.authorize(
        request(test.workspace, {
          sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        }),
      );
      expect(prepared.metadata.grant).toBeUndefined();
      expect(capabilityAuthority.getAuditEvents()).toEqual([]);
      expect(timingEvents).toEqual([]);

      now = 1_500;
      const active = prepared.activate();
      expect(active.metadata).toMatchObject({
        grantTiming: "launch",
        grant: {
          grantId: "grant-id-1",
          auditId: "grant-id-2",
        },
      });
      expect(
        capabilityAuthority.getAuditEvents().map(({ type }) => type),
      ).toEqual(["issued", "consumed"]);
      expect(timingEvents).toEqual([
        expect.objectContaining({
          type: "activated",
          timing: "launch",
          capability: "public_network",
          preparationAgeBucket: "1s_to_10s",
          exceededLegacyTtl: true,
        }),
      ]);
      expect(() => prepared.activate()).toThrow(
        "Prepared sandbox launch is no longer available",
      );

      prepared.finalize();
      prepared.finalize();
      expect(
        capabilityAuthority.getAuditEvents().map(({ type }) => type),
      ).toEqual(["issued", "consumed", "revoked"]);
    } finally {
      await test.dispose();
    }
  });

  it("keeps preparation-timed grants as a rollback mode", async () => {
    const test = await fixture();
    let now = 100;
    let nextId = 1;
    const capabilityAuthority = new SandboxCapabilityAuthority({
      now: () => now,
      createId: () => `grant-id-${nextId++}`,
    });
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-legacy-network-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      capabilityAuthority,
      capabilityGrantTtlMs: 100,
      capabilityGrantTiming: "preparation",
      now: () => now,
    });

    try {
      const prepared = await authorizer.authorize(
        request(test.workspace, {
          sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        }),
      );
      expect(prepared.metadata).toMatchObject({
        grantTiming: "preparation",
        grant: { grantId: "grant-id-1", auditId: "grant-id-2" },
      });
      expect(
        capabilityAuthority.getAuditEvents().map(({ type }) => type),
      ).toEqual(["issued", "consumed"]);

      now = 201;
      expect(() => prepared.activate()).toThrow(
        "Sandbox capability grant could not be activated: expired",
      );
      expect(
        capabilityAuthority.getAuditEvents().map(({ type }) => type),
      ).toEqual(["issued", "consumed", "revoked"]);
    } finally {
      await test.dispose();
    }
  });

  it("binds, consumes, exposes, expires, and revokes one exact public-network grant", async () => {
    const test = await fixture();
    let now = 100;
    let nextId = 1;
    const capabilityAuthority = new SandboxCapabilityAuthority({
      now: () => now,
      createId: () => `grant-id-${nextId++}`,
    });
    const authorizer = new BaselineSandboxLaunchAuthorizer({
      workspaceRoots: [test.workspace],
      privateDirectoryPrefix: path.join(test.privateRoot, "al-network-"),
      homeDirectory: path.join(test.root, "real-home"),
      hostTemporaryDirectory: os.tmpdir(),
      capabilityAuthority,
      capabilityGrantTtlMs: 100,
      now: () => now,
    });

    try {
      const launch = await authorizeAndActivate(
        authorizer,
        request(test.workspace, {
          sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        }),
      );
      expect(launch.policy.network).toEqual({
        mode: "public-proxy",
      });
      expect(launch.metadata.capabilityRequest).toEqual({
        unrestrictedPublicNetwork: true,
      });
      expect(launch.helperRequest.network).toEqual({ mode: "public-proxy" });
      expect(launch.metadata).toMatchObject({
        capabilities: { network: "proxy-only" },
        grantTiming: "launch",
        grant: {
          grantId: expect.any(String),
          auditId: expect.any(String),
        },
      });
      const grant = capabilityAuthority.getGrant(
        launch.metadata.grant?.grantId as string,
      );
      expect(grant).toMatchObject({
        consumedAt: now,
        bindingDigest: launch.bindingDigest,
      });
      expect(
        capabilityAuthority.getAuditEvents().map(({ type }) => type),
      ).toEqual(["issued", "consumed"]);
      expect(() => launch.assertLaunchValid?.()).not.toThrow();

      now = 201;
      expect(() => launch.assertLaunchValid?.()).toThrow("expired");
      launch.finalize?.();
      expect(capabilityAuthority.getAuditEvents().at(-1)?.type).toBe("revoked");
    } finally {
      await test.dispose();
    }
  });

  it.each([
    [
      "local binding",
      { allowLocalBinding: true },
      { mode: "loopback", allowLocalBinding: true },
    ],
    [
      "public network and local binding",
      { unrestrictedPublicNetwork: true, allowLocalBinding: true },
      { mode: "public-proxy", allowLocalBinding: true },
    ],
  ] as const)(
    "binds and consumes one exact %s grant",
    async (_label, capabilityRequest, network) => {
      const test = await fixture();
      let nextId = 1;
      const capabilityAuthority = new SandboxCapabilityAuthority({
        now: () => 100,
        createId: () => `grant-id-${nextId++}`,
      });
      const authorizer = new BaselineSandboxLaunchAuthorizer({
        workspaceRoots: [test.workspace],
        privateDirectoryPrefix: path.join(test.privateRoot, "al-capability-"),
        homeDirectory: path.join(test.root, "real-home"),
        hostTemporaryDirectory: os.tmpdir(),
        capabilityAuthority,
        capabilityGrantTtlMs: 100,
        now: () => 100,
      });

      try {
        const launch = await authorizeAndActivate(
          authorizer,
          request(test.workspace, {
            sandboxCapabilityRequest: capabilityRequest,
          }),
        );
        expect(launch.policy.network).toEqual(network);
        expect(launch.metadata.capabilityRequest).toEqual(capabilityRequest);
        expect(launch.metadata.grantTiming).toBe("launch");
        expect(
          capabilityAuthority.getGrant(
            launch.metadata.grant?.grantId as string,
          ),
        ).toMatchObject({
          consumedAt: 100,
          bindingDigest: launch.bindingDigest,
        });
        expect(launch.helperRequest.network).toEqual(network);
        expect(
          capabilityAuthority.getAuditEvents().map(({ type }) => type),
        ).toEqual(["issued", "consumed"]);
        launch.finalize?.();
      } finally {
        await test.dispose();
      }
    },
  );

  it("fails closed for outside cwd and changed inline files", async () => {
    const test = await fixture();
    const inlineRoot = await mkdtemp(
      path.join(os.tmpdir(), "al-inline-change-"),
    );
    const inlinePath = path.join(inlineRoot, "input.txt");
    try {
      await expect(
        test.authorizer.authorize(request(test.workspace, { cwd: test.root })),
      ).rejects.toThrow("inside an active workspace root");
      await expect(
        test.authorizer.authorize(
          request(test.workspace, {
            env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
          }),
        ),
      ).rejects.toThrow("environment override is reserved: SSH_AUTH_SOCK");

      await writeFile(inlinePath, "changed");
      await expect(
        test.authorizer.authorize(
          request(test.workspace, {
            sandboxInlineFiles: [
              {
                name: "input",
                path: inlinePath,
                bytes: 1,
                sha256: "0".repeat(64),
              },
            ],
          }),
        ),
      ).rejects.toThrow("changed after materialization");
      await expect.poll(async () => readdir(test.privateRoot)).toEqual([]);
    } finally {
      await rm(inlineRoot, { recursive: true, force: true });
      await test.dispose();
    }
  });

  it("does not include inline file contents or paths in execution metadata", async () => {
    const test = await fixture();
    const launch = await authorizeAndActivate(
      test.authorizer,
      request(test.workspace),
    );
    try {
      const serialized = JSON.stringify(launch.metadata);
      expect(serialized).not.toContain(test.workspace);
      expect(serialized).not.toContain("bindingDigest");
      expect(serialized).not.toContain("HOME");
      expect(
        await readFile(path.join(test.workspace, ".git", "config"), "utf8"),
      ).toBe("[core]\n");
    } finally {
      launch.finalize?.();
      await test.dispose();
    }
  });
});

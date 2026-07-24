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
      const launch = await authorizer.authorize(request(test.workspace));
      expect(launch.authorization.policy.readableRoots).toEqual(["/"]);
      expect(launch.authorization.policy.writableRoots).not.toContain(
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
      const launch = await test.authorizer.authorize(request(test.workspace));
      const policy = launch.authorization.policy;
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
          path.join(canonicalWorkspace, ".agents"),
          path.join(canonicalWorkspace, ".codex"),
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
      expect(launch.authorization.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(launch.authorization.capabilityRequest).toBeUndefined();
      expect(launch.authorization.grant).toBeUndefined();
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
      const launch = await authorizer.authorize(request(test.workspace));
      expect(launch.authorization.policy.environment.values).toMatchObject({
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
      const launch = await authorizer.authorize(
        request(test.workspace, {
          env: { CUSTOM_FLAG: "command", COMMAND_VALUE: "yes" },
        }),
      );
      const environment = launch.authorization.policy.environment.values;
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

  it("lets explicit command environment override shared agent defaults", async () => {
    const test = await fixture();
    try {
      const launch = await test.authorizer.authorize(
        request(test.workspace, { env: { GIT_PAGER: "less" } }),
      );
      expect(launch.authorization.policy.environment.values.GIT_PAGER).toBe(
        "less",
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

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

      const launch = await authorizer.authorize(request(workspace));
      const canonicalCommonGit = await realpath(commonGit);
      expect(launch.authorization.policy.readableRoots).toEqual(["/"]);
      expect(launch.authorization.policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          canonicalCommonGit,
        ]),
      );
      expect(launch.authorization.policy.protectedReadOnlyRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          await realpath(path.join(worktreeGit, "commondir")),
          await realpath(path.join(commonGit, "config")),
        ]),
      );
      expect(launch.authorization.policy.protectedReadOnlyRoots).not.toContain(
        canonicalCommonGit,
      );
      expect(launch.authorization.policy.structurallyProtectedRoots).toEqual([
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
      const launch = await test.authorizer.authorize(
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
      expect(launch.authorization.policy.readableRoots).toEqual(["/"]);
      expect(canonicalInlineRoot).toMatch(/^\//);
      const expectedBinding = createSandboxLaunchBindingDigest({
        command: `cat '${inlinePath}'`,
        cwd: await realpath(test.workspace),
        environment: launch.authorization.policy.environment.values,
        inlineFiles: [
          { name: "body", bytes: Buffer.byteLength(content), sha256 },
        ],
        sessionId: "session-1",
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: "workspace-write",
        capability: { publicNetwork: false, localBinding: false },
      });
      expect(launch.authorization.bindingDigest).toBe(expectedBinding);
      launch.finalize?.();
    } finally {
      await rm(inlineRoot, { recursive: true, force: true });
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
      const launch = await authorizer.authorize(
        request(test.workspace, {
          sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        }),
      );
      expect(launch.authorization.policy.network).toEqual({
        mode: "public-proxy",
      });
      expect(launch.authorization.capabilityRequest).toEqual({
        unrestrictedPublicNetwork: true,
      });
      expect(launch.authorization.grant).toMatchObject({
        consumedAt: now,
        bindingDigest: launch.authorization.bindingDigest,
      });
      expect(launch.helperRequest.network).toEqual({ mode: "public-proxy" });
      expect(launch.metadata).toMatchObject({
        capabilities: { network: "proxy-only" },
        grant: {
          grantId: launch.authorization.grant?.grantId,
          auditId: launch.authorization.grant?.auditId,
        },
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
        const launch = await authorizer.authorize(
          request(test.workspace, {
            sandboxCapabilityRequest: capabilityRequest,
          }),
        );
        expect(launch.authorization.policy.network).toEqual(network);
        expect(launch.authorization.capabilityRequest).toEqual(
          capabilityRequest,
        );
        expect(launch.authorization.grant).toMatchObject({
          consumedAt: 100,
          bindingDigest: launch.authorization.bindingDigest,
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
    const launch = await test.authorizer.authorize(request(test.workspace));
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

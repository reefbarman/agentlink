import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { BaselineSandboxLaunchAuthorizer } from "./BaselineSandboxLaunchAuthorizer.js";
import { CURRENT_SANDBOX_POLICY_VERSION } from "../../core/sandboxPolicy.js";
import { createHash } from "node:crypto";
import { createSandboxLaunchBindingDigest } from "./SandboxCapabilityAuthority.js";
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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "al-authorizer-"));
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  await Promise.all([
    mkdir(path.join(workspace, ".git"), { recursive: true }),
    mkdir(path.join(workspace, ".agentlink"), { recursive: true }),
    mkdir(privateRoot),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, ".git", "config"), "[core]\n"),
    writeFile(path.join(workspace, ".agentlink", "policy.json"), "{}"),
  ]);
  const authorizer = new BaselineSandboxLaunchAuthorizer({
    workspaceRoots: [workspace],
    privateDirectoryPrefix: path.join(privateRoot, "al-"),
    homeDirectory: path.join(root, "real-home"),
  });
  return {
    root,
    workspace,
    privateRoot,
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
      expect(launch.authorization.policy.readableRoots).toContain(
        await realpath(runtimeRoot),
      );
      expect(launch.authorization.policy.writableRoots).not.toContain(
        await realpath(runtimeRoot),
      );
      launch.finalize?.();
    } finally {
      await test.dispose();
    }
  });

  it("compiles a blocked workspace-write policy with private environment and protected metadata", async () => {
    const test = await fixture();
    try {
      const launch = await test.authorizer.authorize(request(test.workspace));
      const policy = launch.authorization.policy;
      const environment = policy.environment.values;
      const canonicalWorkspace = await realpath(test.workspace);

      expect(policy).toMatchObject({
        version: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: "workspace-write",
        network: { mode: "blocked" },
        deniedRoots: ["/"],
        allowedUnixSockets: [],
      });
      expect(policy.writableRoots).toContain(canonicalWorkspace);
      expect(policy.readableRoots).toContain(canonicalWorkspace);
      expect(policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          path.join(canonicalWorkspace, ".git"),
          path.join(canonicalWorkspace, ".agentlink"),
          path.join(canonicalWorkspace, ".claude"),
          path.join(canonicalWorkspace, "CLAUDE.md"),
          "/private/tmp/claude",
          "/tmp/claude",
        ]),
      );
      expect(policy.protectedReadOnlyRoots).toEqual(
        expect.arrayContaining([
          path.join(canonicalWorkspace, ".git"),
          path.join(canonicalWorkspace, ".agentlink"),
        ]),
      );
      expect(launch.helperRequest.filesystem.denyRead).toEqual(["/"]);
      expect(launch.helperRequest.filesystem.denyWrite).toEqual(
        policy.deniedWriteRoots,
      );
      expect(launch.helperRequest.protectedRoots).toEqual(
        policy.protectedReadOnlyRoots,
      );
      expect(environment.CUSTOM_FLAG).toBe("yes");
      expect(environment.SSH_AUTH_SOCK).toBeUndefined();
      expect(environment.HOME).toMatch(/\/private\/al-[^/]+\/h$/);
      expect(environment.TMPDIR).toMatch(/\/private\/al-[^/]+\/t$/);
      expect(environment.XDG_CACHE_HOME).toMatch(/\/private\/al-[^/]+\/c$/);
      expect(environment.PATH).not.toContain("attacker");
      if (await exists("/var/select/developer_dir")) {
        expect(environment.DEVELOPER_DIR).toBe(
          await realpath("/var/select/developer_dir"),
        );
        expect(policy.readableRoots).toContain(
          path.dirname(environment.DEVELOPER_DIR),
        );
        expect(environment.xcrun_db).toBe(
          path.join(environment.TMPDIR, "xcrun_db"),
        );
      }
      expect(launch.authorization.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(launch.metadata.capabilities).toMatchObject({
        filesystemRead: "isolated",
        filesystemWrite: "strict",
        network: "blocked",
        privateHome: true,
        privateTmp: true,
        hostIpcBlocked: true,
      });

      const privateCommandRoot = path.dirname(environment.HOME);
      expect(await exists(privateCommandRoot)).toBe(true);
      launch.finalize?.();
      await expect.poll(() => exists(privateCommandRoot)).toBe(false);
    } finally {
      await test.dispose();
    }
  });

  it("resolves and protects worktree-specific and common Git directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "al-worktree-policy-"));
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
      expect(launch.authorization.policy.readableRoots).toContain(
        canonicalCommonGit,
      );
      expect(launch.authorization.policy.deniedWriteRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          canonicalCommonGit,
        ]),
      );
      expect(launch.authorization.policy.protectedReadOnlyRoots).toEqual(
        expect.arrayContaining([
          await realpath(path.join(workspace, ".git")),
          canonicalCommonGit,
        ]),
      );
      launch.finalize?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-hashes inline files and grants only their materialized directory read access", async () => {
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

      expect(launch.authorization.policy.readableRoots).toContain(
        await realpath(inlineRoot),
      );
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
        capability: { publicNetwork: false },
      });
      expect(launch.authorization.bindingDigest).toBe(expectedBinding);
      launch.finalize?.();
    } finally {
      await rm(inlineRoot, { recursive: true, force: true });
      await test.dispose();
    }
  });

  it("fails closed for public network, outside cwd, and changed inline files", async () => {
    const test = await fixture();
    const inlineRoot = await mkdtemp(
      path.join(os.tmpdir(), "al-inline-change-"),
    );
    const inlinePath = path.join(inlineRoot, "input.txt");
    try {
      await expect(
        test.authorizer.authorize(
          request(test.workspace, {
            sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
          }),
        ),
      ).rejects.toThrow("Public network approval is not available yet");
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

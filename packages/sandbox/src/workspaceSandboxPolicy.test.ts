import {
  SandboxPreparationError,
  sandboxEnvironmentKeyDiagnostic,
  sandboxPreparationFailure,
} from "./SandboxPreparationError.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES } from "./sandboxEnvironmentPolicy.js";
import { SandboxStructuralProtectionError } from "./SandboxRuntimeProvider.js";
import os from "node:os";
import path from "node:path";
import { prepareWorkspaceSandboxLaunch } from "./workspaceSandboxPolicy.js";

const fixtures: string[] = [];

interface Fixture {
  root: string;
  workspace: string;
  privateRoot: string;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "al-policy-namespace-")),
  );
  fixtures.push(root);
  const workspace = path.join(root, "workspace");
  const privateRoot = path.join(root, "private");
  await Promise.all([mkdir(workspace), mkdir(privateRoot)]);
  return { root, workspace, privateRoot };
}

function prepare(
  test: Fixture,
  workspaceRoots = [test.workspace],
  overrides: Partial<Parameters<typeof prepareWorkspaceSandboxLaunch>[0]> = {},
) {
  return prepareWorkspaceSandboxLaunch({
    workspaceRoots,
    cwd: test.workspace,
    command: "true",
    sessionId: "session-1",
    capability: { publicNetwork: false, localBinding: false },
    hostEnvironment: { PATH: "/usr/bin:/bin" },
    agentEnvironment: {},
    environmentPolicy: { ignoreDefaultExcludes: false },
    environmentBudgetBytes: SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
    homeDirectory: test.root,
    hostTemporaryDirectory: test.root,
    privateDirectoryPrefix: path.join(test.privateRoot, "al-sbx-"),
    trustedRuntimeRoots: [],
    temporaryHome: false,
    shareHostTemporaryDirectories: false,
    ...overrides,
  });
}

async function writeSkill(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, "---\nname: example\n---\n");
  return file;
}

async function expectStructuralRejection(
  test: Fixture,
  expected: { path: string; kind: string },
  workspaceRoots?: string[],
): Promise<void> {
  const error = await prepare(test, workspaceRoots).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SandboxStructuralProtectionError);
  expect((error as SandboxStructuralProtectionError).details).toEqual(expected);
  // A rejected preparation must not leak its private per-command directories.
  expect(await readdir(test.privateRoot)).toEqual([]);
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded sandbox preparation diagnostics", () => {
  it("identifies a missing root in a multi-root workspace without exposing paths", async () => {
    const test = await fixture();
    const missing = path.join(test.root, "private-missing-folder");
    const error = await prepare(test, [test.workspace, missing]).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SandboxPreparationError);
    expect((error as SandboxPreparationError).diagnostic).toEqual({
      phase: "workspace_roots",
      category: "not_found",
    });
    expect((error as Error).message).not.toContain(missing);
    expect(await readdir(test.privateRoot)).toEqual([]);
  });

  it.each([
    ["working_directory", { cwd: "/not-an-active-workspace" }],
    [
      "trusted_runtime_roots",
      { trustedRuntimeRoots: ["relative-private-path"] },
    ],
    [
      "temporary_directory",
      { hostTemporaryDirectory: "/missing-private-temp" },
    ],
  ] as const)(
    "identifies the %s preparation check and cleans private directories",
    async (phase, overrides) => {
      const test = await fixture();
      const error = await prepare(test, undefined, {
        ...overrides,
        ...(phase === "trusted_runtime_roots"
          ? { trustedRuntimeRoots: [...overrides.trustedRuntimeRoots] }
          : {}),
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SandboxPreparationError);
      expect((error as SandboxPreparationError).diagnostic?.phase).toBe(phase);
      expect((error as Error).message).not.toMatch(/private|relative/);
      expect(await readdir(test.privateRoot)).toEqual([]);
    },
  );

  it("reports all blocked environment keys, including LC_ALL, but never their values", async () => {
    const test = await fixture();
    const error = await prepare(test, undefined, {
      explicitEnvironment: {
        LC_ALL: "private-locale-value",
        HOME: "/private/home",
        SAFE: "allowed",
      },
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SandboxPreparationError);
    expect((error as SandboxPreparationError).reason).toBe(
      "reserved_environment_override",
    );
    expect((error as SandboxPreparationError).diagnostic).toEqual({
      phase: "environment",
      environment_keys: ["HOME", "LC_ALL"],
      environment_key_count: 2,
    });
    expect(
      JSON.stringify((error as SandboxPreparationError).diagnostic),
    ).not.toMatch(/private|allowed|SAFE/);
    expect(await readdir(test.privateRoot)).toEqual([]);
  });

  it("identifies budget failures with bounded protected key names and no values", async () => {
    const test = await fixture();
    const error = await prepare(test, undefined, {
      command: "echo private-command-body",
      explicitEnvironment: {
        COMMAND_VALUE: "private-environment-value".repeat(100),
        "/private/key-path": "private-value",
        ...Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`KEY_${i}`, "private-value"]),
        ),
      },
      hostEnvironment: { PATH: "/usr/bin:/bin", HOST_ONLY: "inherited-value" },
      environmentBudgetBytes: 1_500,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SandboxPreparationError);
    expect(error).toMatchObject({
      code: "sandbox_preparation_failed",
      reason: "preparation_failed",
      commandStarted: false,
      diagnostic: {
        phase: "environment",
        category: "environment_budget_failed",
        environment_keys: expect.arrayContaining(["COMMAND_VALUE"]),
      },
    });
    const diagnostic = (error as SandboxPreparationError).diagnostic!;
    expect(diagnostic.environment_keys).toHaveLength(16);
    expect(diagnostic.environment_key_count).toBeGreaterThan(16);
    expect(JSON.stringify(error)).not.toMatch(/private|inherited|HOST_ONLY/);
    expect((error as Error).message).not.toMatch(/private|inherited/);
    expect(await readdir(test.privateRoot)).toEqual([]);
  });

  it("bounds key names and omits arbitrary text and OS error details", () => {
    const keys = [
      ...Array.from({ length: 25 }, (_, i) => `KEY_${i}`),
      "/private/path",
      "line\nbreak",
      "A".repeat(100),
    ];
    const diagnostic = sandboxEnvironmentKeyDiagnostic(keys);
    expect(diagnostic.environment_keys).toHaveLength(16);
    expect(diagnostic.environment_key_count).toBe(28);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|break/);
    const error = sandboxPreparationFailure(
      Object.assign(new Error("secret body at /private/path"), {
        code: "EPERM",
      }),
      "workspace_policy_integrity",
    ) as SandboxPreparationError;
    expect(error.diagnostic).toEqual({
      phase: "workspace_policy_integrity",
      category: "permission_denied",
    });
    expect(error.message).not.toMatch(/secret|private/);
  });
});

describe("workspace policy namespace symlinks", () => {
  it.each([
    [".agents/skills -> ../.claude/skills", ".claude", ".agents"],
    [".claude/skills -> ../.agents/skills", ".agents", ".claude"],
  ])(
    "follows %s and protects the real skill files",
    async (_label, targetNamespace, linkNamespace) => {
      const test = await fixture();
      const skill = await writeSkill(
        path.join(test.workspace, targetNamespace, "skills", "example"),
      );
      await mkdir(path.join(test.workspace, linkNamespace));
      await symlink(
        path.join("..", targetNamespace, "skills"),
        path.join(test.workspace, linkNamespace, "skills"),
      );

      const prepared = await prepare(test);
      try {
        const { policy } = prepared.authorization;
        expect(policy.protectedReadOnlyRoots).toContain(skill);
        expect(policy.deniedWriteRoots).toEqual(
          expect.arrayContaining([
            path.join(test.workspace, ".agents"),
            path.join(test.workspace, ".claude"),
          ]),
        );
      } finally {
        prepared.directories.cleanup();
      }
    },
  );

  it("follows a symlinked policy file into another protected namespace", async () => {
    const test = await fixture();
    await Promise.all([
      mkdir(path.join(test.workspace, ".agents")),
      mkdir(path.join(test.workspace, ".claude")),
    ]);
    const target = path.join(test.workspace, ".agents", "settings.json");
    await writeFile(target, "{}\n");
    await symlink(
      path.join("..", ".agents", "settings.json"),
      path.join(test.workspace, ".claude", "settings.json"),
    );

    const prepared = await prepare(test);
    try {
      expect(prepared.authorization.policy.protectedReadOnlyRoots).toContain(
        target,
      );
    } finally {
      prepared.directories.cleanup();
    }
  });

  it.each([
    [
      "outside the workspace",
      (test: Fixture) => path.join(test.root, "elsewhere"),
    ],
    [
      "elsewhere in the workspace",
      (test: Fixture) => path.join(test.workspace, "src", "skills"),
    ],
  ])(
    "rejects a skills symlink that resolves %s as structural protection",
    async (_label, resolveTarget) => {
      const test = await fixture();
      const target = resolveTarget(test);
      await writeSkill(target);
      await mkdir(path.join(test.workspace, ".agents"));
      const link = path.join(test.workspace, ".agents", "skills");
      await symlink(target, link);

      await expectStructuralRejection(test, {
        kind: "symbolic_link",
        path: link,
      });
    },
  );

  it("rejects a symlink into another workspace root's policy namespace", async () => {
    const test = await fixture();
    const other = path.join(test.root, "other");
    await writeSkill(path.join(other, ".claude", "skills", "example"));
    await mkdir(path.join(test.workspace, ".agents"));
    const link = path.join(test.workspace, ".agents", "skills");
    await symlink(path.join(other, ".claude", "skills"), link);

    await expectStructuralRejection(
      test,
      { kind: "symbolic_link", path: link },
      [test.workspace, other],
    );
  });

  it("rejects a dangling policy symlink as structural protection", async () => {
    const test = await fixture();
    await mkdir(path.join(test.workspace, ".claude"));
    const link = path.join(test.workspace, ".claude", "skills");
    await symlink(path.join("..", ".agents", "skills"), link);

    await expectStructuralRejection(test, {
      kind: "symbolic_link",
      path: link,
    });
  });

  it("rejects a symlinked .agentlink runtime entry even inside a namespace", async () => {
    const test = await fixture();
    await mkdir(path.join(test.workspace, ".agentlink"));
    await mkdir(path.join(test.workspace, ".claude", "history"), {
      recursive: true,
    });
    const link = path.join(test.workspace, ".agentlink", "history");
    await symlink(path.join("..", ".claude", "history"), link);

    await expectStructuralRejection(test, {
      kind: "symbolic_link",
      path: link,
    });
  });

  it("rejects a symlinked policy namespace as structural protection", async () => {
    const test = await fixture();
    await writeSkill(path.join(test.workspace, ".agents", "skills", "example"));
    const link = path.join(test.workspace, ".claude");
    await symlink(".agents", link);

    await expectStructuralRejection(test, {
      kind: "symbolic_link",
      path: link,
    });
  });

  it("rejects a policy namespace that is not a directory", async () => {
    const test = await fixture();
    const namespace = path.join(test.workspace, ".codex");
    await writeFile(namespace, "not a directory\n");

    await expectStructuralRejection(test, {
      kind: "unsupported_node",
      path: namespace,
    });
  });
});

import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeHostShellBootstrap,
  planHostShellBootstrap,
  type HostShellBootstrapFileOperations,
} from "./hostShellBootstrap.js";
import type { HostShellLaunchDecision } from "./hostShellLaunchPolicy.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";

const nonce = "bootstrap_nonce_123456";
const tempRoots: string[] = [];

function profile(
  shellPath: string,
  shellArgs: string[] = [],
  environment: Record<string, string> = {},
): ResolvedHostShellProfile {
  return {
    profileName: path.basename(shellPath),
    provenance: "configured",
    shellPath,
    shellArgs,
    environment,
    cwd: "/workspace",
  };
}

function integrated(
  shell: "bash" | "zsh",
  shellArgs: string[] = [],
  environment: Record<string, string> = {},
): HostShellLaunchDecision {
  return {
    mode: "custom-integrated",
    reason: "shell-integration-supported",
    message: "integrated",
    executable: shell,
    integrationKind: shell,
    profile: profile(`/bin/${shell}`, shellArgs, environment),
  };
}

async function fixture(): Promise<{
  root: string;
  runtimeRoot: string;
  homeDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlink-bootstrap-"));
  tempRoots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const homeDirectory = path.join(root, "home");
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(homeDirectory, { mode: 0o700 });
  return { root, runtimeRoot, homeDirectory };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("host shell bootstrap", () => {
  it("plans bash with a private rc file after normal user bashrc", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const plan = planHostShellBootstrap({
      decision: integrated("bash"),
      runtimeRoot,
      artifactId: "bash-session",
      nonce,
      homeDirectory,
    });

    expect(plan).toMatchObject({
      mode: "integrated",
      shell: "bash",
      artifactDirectory: path.join(runtimeRoot, "bash-session"),
      profile: {
        shellArgs: [
          "--rcfile",
          path.join(runtimeRoot, "bash-session", "bashrc"),
          "-i",
        ],
      },
    });
    if (plan.mode !== "integrated") throw new Error("expected integrated plan");
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.content).toContain(
      `source '${path.join(homeDirectory, ".bashrc")}'`,
    );
    expect(plan.files[0]?.content.indexOf("source")).toBeLessThan(
      plan.files[0]!.content.indexOf("__agentlink_si_nonce"),
    );
  });

  it.each([
    ["login short", ["-l"]],
    ["login long", ["--login"]],
    ["command", ["-c", "echo unsafe"]],
    ["custom rc", ["--rcfile", "/tmp/custom"]],
    ["script", ["script.sh"]],
    ["unknown", ["--unknown"]],
  ])("falls back for unsupported bash argv: %s", async (_name, shellArgs) => {
    const { runtimeRoot, homeDirectory } = await fixture();
    expect(
      planHostShellBootstrap({
        decision: integrated("bash", shellArgs),
        runtimeRoot,
        artifactId: "bash-session",
        nonce,
        homeDirectory,
      }),
    ).toMatchObject({
      mode: "native-fallback",
      reason: "unsupported-bash-arguments",
    });
  });

  it("plans zsh proxy startup files and restores the original ZDOTDIR", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const originalZdotdir = path.join(homeDirectory, "zsh-config");
    const plan = planHostShellBootstrap({
      decision: integrated("zsh", ["-l"]),
      runtimeRoot,
      artifactId: "zsh-session",
      nonce,
      homeDirectory,
      originalZdotdir,
    });

    expect(plan).toMatchObject({
      mode: "integrated",
      shell: "zsh",
      profile: {
        shellArgs: ["-l", "-i"],
        environment: {
          ZDOTDIR: path.join(runtimeRoot, "zsh-session"),
        },
      },
    });
    if (plan.mode !== "integrated") throw new Error("expected integrated plan");
    expect(plan.files.map(({ relativePath }) => relativePath)).toEqual([
      ".zshenv",
      ".zprofile",
      ".zshrc",
      ".zlogin",
    ]);
    expect(plan.files[0]?.content).toContain(
      `typeset -g __agentlink_user_zdotdir='${originalZdotdir}'`,
    );
    const zshrc = plan.files.find(
      ({ relativePath }) => relativePath === ".zshrc",
    );
    expect(zshrc?.content).toContain("__agentlink_si_nonce");
    expect(zshrc?.content).toContain(
      'export ZDOTDIR="$__agentlink_user_zdotdir"',
    );
  });

  it.each([
    ["command", ["-c", "echo unsafe"]],
    ["no rc", ["-f"]],
    ["script", ["script.zsh"]],
    ["combined flags", ["-li"]],
    ["duplicate login", ["-l", "--login"]],
  ])("falls back for unsupported zsh argv: %s", async (_name, shellArgs) => {
    const { runtimeRoot, homeDirectory } = await fixture();
    expect(
      planHostShellBootstrap({
        decision: integrated("zsh", shellArgs),
        runtimeRoot,
        artifactId: "zsh-session",
        nonce,
        homeDirectory,
      }),
    ).toMatchObject({
      mode: "native-fallback",
      reason: "unsupported-zsh-arguments",
    });
  });

  it("passes raw and native-fallback decisions through without artifacts", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const rawDecision: HostShellLaunchDecision = {
      mode: "custom-raw",
      reason: "raw-shell-compatible",
      message: "raw",
      executable: "sh",
      profile: profile("/bin/sh"),
    };
    const fallbackDecision: HostShellLaunchDecision = {
      mode: "native-fallback",
      reason: "native-shell-required",
      message: "native",
      executable: "fish",
      profile: profile("/opt/homebrew/bin/fish"),
    };

    const rawPlan = planHostShellBootstrap({
      decision: rawDecision,
      runtimeRoot,
      artifactId: "raw-session",
      nonce,
      homeDirectory,
    });
    const fallbackPlan = planHostShellBootstrap({
      decision: fallbackDecision,
      runtimeRoot,
      artifactId: "native-session",
      nonce,
      homeDirectory,
    });
    const operations = {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rm: vi.fn(),
    } as unknown as HostShellBootstrapFileOperations;

    expect(
      (await materializeHostShellBootstrap(rawPlan, operations)).mode,
    ).toBe("raw");
    expect(
      (await materializeHostShellBootstrap(fallbackPlan, operations)).mode,
    ).toBe("native-fallback");
    expect(operations.mkdir).not.toHaveBeenCalled();
    expect(operations.writeFile).not.toHaveBeenCalled();
  });

  it("materializes private files and cleans them up idempotently", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const plan = planHostShellBootstrap({
      decision: integrated("zsh"),
      runtimeRoot,
      artifactId: "zsh-session",
      nonce,
      homeDirectory,
    });
    const materialized = await materializeHostShellBootstrap(plan);
    if (materialized.mode !== "integrated") {
      throw new Error("expected integrated bootstrap");
    }

    expect((await stat(materialized.artifactDirectory)).mode & 0o777).toBe(
      0o700,
    );
    for (const file of materialized.files) {
      const filePath = path.join(
        materialized.artifactDirectory,
        file.relativePath,
      );
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(filePath, "utf8")).toBe(file.content);
    }
    expect(await stat(homeDirectory)).toBeDefined();

    await materialized.cleanup();
    await materialized.cleanup();
    await expect(stat(materialized.artifactDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not remove a bootstrap directory it failed to create", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const plan = planHostShellBootstrap({
      decision: integrated("zsh"),
      runtimeRoot,
      artifactId: "zsh-session",
      nonce,
      homeDirectory,
    });
    const cleanup = vi.fn(async () => undefined);
    const operations: HostShellBootstrapFileOperations = {
      mkdir: vi.fn(async () => {
        throw new Error("already exists");
      }),
      writeFile: vi.fn(),
      rm: cleanup,
    };

    await expect(
      materializeHostShellBootstrap(plan, operations),
    ).rejects.toThrow("already exists");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans partial artifacts after a write failure", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    const plan = planHostShellBootstrap({
      decision: integrated("zsh"),
      runtimeRoot,
      artifactId: "zsh-session",
      nonce,
      homeDirectory,
    });
    const cleanup = vi.fn(async () => undefined);
    const operations: HostShellBootstrapFileOperations = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => {
        throw new Error("write failed");
      }),
      rm: cleanup,
    };

    await expect(
      materializeHostShellBootstrap(plan, operations),
    ).rejects.toThrow("write failed");
    expect(cleanup).toHaveBeenCalledWith(
      path.join(runtimeRoot, "zsh-session"),
      {
        recursive: true,
        force: true,
      },
    );
  });

  it("validates artifact ownership inputs before planning", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    expect(() =>
      planHostShellBootstrap({
        decision: integrated("zsh"),
        runtimeRoot: "relative",
        artifactId: "session",
        nonce,
        homeDirectory,
      }),
    ).toThrow("runtimeRoot must be an absolute path");
    expect(() =>
      planHostShellBootstrap({
        decision: integrated("zsh"),
        runtimeRoot,
        artifactId: "../escape",
        nonce,
        homeDirectory,
      }),
    ).toThrow("artifactId must contain only URL-safe identifier characters");
  });
});

const describeDarwin = process.platform === "darwin" ? describe : describe.skip;

describeDarwin("host shell bootstrap Darwin conformance", () => {
  it("loads normal bashrc before hooks and executes an interactive command", async () => {
    const { runtimeRoot, homeDirectory } = await fixture();
    await writeFile(
      path.join(homeDirectory, ".bashrc"),
      "export AGENTLINK_USER_RC=bash-user\n",
      { mode: 0o600 },
    );
    const plan = planHostShellBootstrap({
      decision: integrated("bash", [], { HOME: homeDirectory }),
      runtimeRoot,
      artifactId: "bash-real",
      nonce,
      homeDirectory,
    });
    const materialized = await materializeHostShellBootstrap(plan);
    if (materialized.mode !== "integrated")
      throw new Error("expected integrated");

    const result = spawnSync(
      materialized.profile.shellPath,
      [
        ...materialized.profile.shellArgs,
        "-c",
        'printf "__RESULT__:%s\\n" "$AGENTLINK_USER_RC"',
      ],
      {
        encoding: "utf8",
        env: materialized.profile.environment,
        timeout: 5000,
      },
    );
    await materialized.cleanup();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("__RESULT__:bash-user");
    expect(`${result.stdout}${result.stderr}`).toContain("697;AgentLink");
  });

  it.each([
    ["non-login", []],
    ["login", ["-l"]],
  ])(
    "loads zsh startup order and restores ZDOTDIR for %s",
    async (_name, args) => {
      const { runtimeRoot, homeDirectory } = await fixture();
      const userZdotdir = path.join(homeDirectory, "zsh-config");
      await mkdir(userZdotdir, { mode: 0o700 });
      await writeFile(
        path.join(userZdotdir, ".zshenv"),
        "export AGENTLINK_ZSH_ORDER=env\n",
      );
      await writeFile(
        path.join(userZdotdir, ".zprofile"),
        'export AGENTLINK_ZSH_ORDER="$AGENTLINK_ZSH_ORDER,profile"\n',
      );
      await writeFile(
        path.join(userZdotdir, ".zshrc"),
        'export AGENTLINK_ZSH_ORDER="$AGENTLINK_ZSH_ORDER,rc"\n',
      );
      await writeFile(
        path.join(userZdotdir, ".zlogin"),
        'export AGENTLINK_ZSH_ORDER="$AGENTLINK_ZSH_ORDER,login"\n',
      );
      const plan = planHostShellBootstrap({
        decision: integrated("zsh", args, {
          HOME: homeDirectory,
          ZDOTDIR: userZdotdir,
        }),
        runtimeRoot,
        artifactId: `zsh-real-${args.length}`,
        nonce,
        homeDirectory,
        originalZdotdir: userZdotdir,
      });
      const materialized = await materializeHostShellBootstrap(plan);
      if (materialized.mode !== "integrated")
        throw new Error("expected integrated");

      const result = spawnSync(
        materialized.profile.shellPath,
        [
          ...materialized.profile.shellArgs,
          "-c",
          'printf "__RESULT__:%s:%s:%s:%s\\n" "$AGENTLINK_ZSH_ORDER" "$ZDOTDIR" "${precmd_functions[(Ie)__agentlink_si_precmd]}" "${preexec_functions[(Ie)__agentlink_si_preexec]}"',
        ],
        {
          encoding: "utf8",
          env: materialized.profile.environment,
          timeout: 5000,
        },
      );
      await materialized.cleanup();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        args.length === 0
          ? `__RESULT__:env,rc:${userZdotdir}:1:1`
          : `__RESULT__:env,profile,rc,login:${userZdotdir}:1:1`,
      );
    },
  );
});

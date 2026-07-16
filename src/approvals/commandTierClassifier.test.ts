import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  classifyCommand,
  isCommandEligibleForReadOnlyExecution,
  isTierAtOrBelow,
  type CommandTierContext,
} from "./commandTierClassifier.js";

const root = path.resolve("/workspace/project");
const ctx: CommandTierContext = {
  cwd: root,
  workspaceRoots: [root],
};

function classify(command: string, override: Partial<CommandTierContext> = {}) {
  return classifyCommand(command, { ...ctx, ...override });
}

function tier(command: string, override: Partial<CommandTierContext> = {}) {
  return classify(command, override).tier;
}

describe("command tier classifier", () => {
  it("classifies read-only commands as safe", () => {
    expect(tier("git status --short")).toBe("safe");
    expect(tier("rg needle src")).toBe("safe");
    expect(tier("strings -a fixtures/app.bin")).toBe("safe");
    expect(tier("node --version")).toBe("safe");
    expect(tier("python --version")).toBe("safe");
  });

  it("classifies workspace-local mutations and unknown plain commands as sensitive", () => {
    expect(tier("mkdir src/generated")).toBe("sensitive");
    expect(tier("npm test")).toBe("sensitive");
    expect(tier("custom-tool --flag")).toBe("sensitive");
    expect(tier("./ls")).toBe("sensitive");
    expect(tier("/bin/ls")).toBe("sensitive");
  });

  it("classifies destructive and external commands as dangerous", () => {
    expect(tier("rm -rf dist")).toBe("dangerous");
    expect(tier("sudo git status")).toBe("dangerous");
    expect(tier("git push origin main")).toBe("dangerous");
    expect(tier("curl https://example.com")).toBe("dangerous");
    expect(tier("find src -execdir rm {} ;")).toBe("dangerous");
    expect(tier("find src -fprint generated.txt")).toBe("dangerous");
  });

  it("does not classify networked package metadata queries as safe", () => {
    expect(tier("npm view react version")).toBe("sensitive");
    expect(tier("pnpm audit")).toBe("sensitive");
    expect(tier("yarn outdated")).toBe("sensitive");
    expect(tier("npm ls --depth=0")).toBe("safe");
  });

  it.each([
    ["git grep -O../evil.sh token", "git executable or output option"],
    ["git log --output=/tmp/log", "git executable or output option"],
    ["git --git-dir=/tmp/repo status", "git path or config override"],
    ["git remote update", "git remote operation"],
    ["git branch new-branch", "git branch mutation"],
    ["rg --pre=./evil token src", "ripgrep preprocessor execution"],
    ["arch ./evil", "arch command execution"],
    ["date 010100002030", "date may set system time"],
    ["shasum ~/.ssh/id_rsa", "read targets secret path"],
    ["stat /etc/passwd", "read target outside workspace"],
  ])("rejects readonly execution bypass: %s", (command, reason) => {
    expect(isCommandEligibleForReadOnlyExecution(command, ctx)).toEqual({
      eligible: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("requires hook-disabling flags for git diff-style readonly execution", () => {
    expect(isCommandEligibleForReadOnlyExecution("git diff", ctx)).toEqual({
      eligible: false,
      reason: expect.stringContaining("requires --no-pager"),
    });
    expect(
      isCommandEligibleForReadOnlyExecution(
        "git --no-pager diff --no-ext-diff --no-textconv",
        ctx,
      ),
    ).toEqual({ eligible: true });
    expect(
      isCommandEligibleForReadOnlyExecution(
        "git --no-pager diff --no-ext-diff --no-textconv --no-index a b",
        ctx,
      ),
    ).toEqual({
      eligible: false,
      reason: expect.stringContaining("--no-index"),
    });
  });

  it("requires ripgrep config isolation for readonly execution", () => {
    expect(isCommandEligibleForReadOnlyExecution("rg token src", ctx)).toEqual({
      eligible: false,
      reason: expect.stringContaining("requires --no-config"),
    });
    expect(
      isCommandEligibleForReadOnlyExecution("rg --no-config token src", ctx),
    ).toEqual({ eligible: true });
  });

  it.each([
    ["ls *", "shell path expansion"],
    ["find src/{one,two}", "shell path expansion"],
    ["find -L .", "find option"],
    ["ls -L src", "ls option"],
    ["rg --no-config --follow token src", "rg option"],
    ["rg --no-config --ignore-file config/ignore token src", "rg option"],
    ["grep -f config/patterns src/file", "grep option"],
    ["file --magic-file config/magic src/file", "file option"],
    ["shasum --check checksums.txt", "shasum option"],
  ])("rejects deferred readonly path resolution: %s", (command, reason) => {
    expect(isCommandEligibleForReadOnlyExecution(command, ctx)).toEqual({
      eligible: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("allows quoted glob characters that the shell will not expand", () => {
    expect(
      isCommandEligibleForReadOnlyExecution("rg --no-config '*' src", ctx),
    ).toEqual({ eligible: true });
  });

  it("uses the highest tier across compound commands", () => {
    expect(tier("git status && mkdir tmp")).toBe("sensitive");
    expect(tier("git status && rm -rf tmp")).toBe("dangerous");
  });

  it("escalates opaque shell syntax and inline interpreters", () => {
    expect(tier("echo $(whoami)")).toBe("dangerous");
    expect(tier("PATH=/tmp:$PATH git status")).toBe("dangerous");
    expect(tier("$CMD arg")).toBe("dangerous");
    expect(tier("python -c 'print(1)'")).toBe("dangerous");
    expect(tier("node -e 'console.log(1)'")).toBe("dangerous");
    expect(tier("bash -c 'git status'")).toBe("dangerous");
  });

  it("escalates read and write paths outside the workspace", () => {
    expect(tier("rg token /tmp/outside")).toBe("dangerous");
    expect(tier("rg token ~/.ssh")).toBe("dangerous");
    expect(tier("strings -a /tmp/outside.bin")).toBe("dangerous");
    expect(tier("strings -a ~/.ssh/id_rsa")).toBe("dangerous");
    expect(tier("mkdir generated", { cwd: "/tmp" })).toBe("dangerous");
    expect(tier("echo ok > /tmp/outside.txt")).toBe("dangerous");
    expect(tier("echo ok > generated.txt")).toBe("sensitive");
  });

  it("escalates shell-expanded paths before runtime expansion", () => {
    expect(tier("cat $HOME/.ssh/id_rsa")).toBe("dangerous");
    expect(tier("cat ${HOME}/.ssh/id_rsa")).toBe("dangerous");
    expect(tier("echo ok > $HOME/.bashrc")).toBe("dangerous");
  });

  it("escalates workspace paths that physically escape through symlinks", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-tier-"));
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "linked-outside"), "dir");

    try {
      expect(
        classify("touch linked-outside/generated.txt", {
          cwd: workspace,
          workspaceRoots: [workspace],
        }).perSubCommand[0]?.result,
      ).toEqual(
        expect.objectContaining({
          tier: "dangerous",
          code: "external_path",
        }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects attached redirections", () => {
    expect(tier("echo ok>/tmp/outside.txt")).toBe("dangerous");
    expect(tier("echo ok>>generated.txt")).toBe("sensitive");
    expect(tier("rg --no-config token<input.txt")).toBe("sensitive");
  });

  it("rejects input redirection for readonly execution", () => {
    expect(
      isCommandEligibleForReadOnlyExecution(
        "rg --no-config token < input.txt",
        ctx,
      ),
    ).toEqual({
      eligible: false,
      reason: expect.stringContaining("shell redirection"),
    });
  });

  it.each([
    {
      command: `"git" "status"`,
      tier: "safe",
      reason: "git status",
    },
    {
      command: `git "status --short"`,
      tier: "sensitive",
      reason: "unrecognized git subcommand",
    },
    {
      command: String.raw`git status\ --short`,
      tier: "sensitive",
      reason: "unrecognized git subcommand",
    },
    {
      command: String.raw`git 'status\ --short'`,
      tier: "sensitive",
      reason: "unrecognized git subcommand",
    },
    {
      command: `echo "ok > /tmp/outside.txt"`,
      tier: "safe",
      reason: "read-only command (echo)",
    },
    {
      command: `echo ok 2>> generated.log`,
      tier: "sensitive",
      reason: "shell redirection",
    },
    {
      command: `echo ok &> /tmp/outside.log`,
      tier: "dangerous",
      reason: "redirection target outside workspace",
    },
    {
      command: String.raw`g\it status`,
      tier: "dangerous",
      reason: "opaque command position",
    },
    {
      command: `node "-e" 1`,
      tier: "dangerous",
      reason: "inline interpreter execution (node)",
    },
    {
      command: `node ""`,
      tier: "sensitive",
      reason: "unrecognized command",
    },
  ])("preserves tokenizer-sensitive classification for $command", (entry) => {
    expect(classify(entry.command).perSubCommand).toEqual([
      {
        command: entry.command,
        result: expect.objectContaining({
          tier: entry.tier,
          reason: entry.reason,
        }),
      },
    ]);
  });

  it.each([
    ["FOO='two words' git status", "environment assignment prefix"],
    ["echo ${HOME}/file", "opaque shell syntax"],
    ["echo `whoami`", "opaque shell syntax"],
    ["echo <(cat file)", "opaque shell syntax"],
  ])("preserves opaque-syntax reason for %s", (command, reason) => {
    expect(classify(command).perSubCommand[0]?.result).toEqual(
      expect.objectContaining({
        tier: "dangerous",
        reason,
      }),
    );
  });

  it.each([`echo "unterminated`, "echo trailing\\"])(
    "preserves permissive malformed classification for %s",
    (command) => {
      expect(classify(command).perSubCommand).toEqual([
        {
          command,
          result: expect.objectContaining({
            tier: "safe",
            reason: "read-only command (echo)",
          }),
        },
      ]);
    },
  );

  it.each([
    ["rg needle src", "safe", "read_only", "rg"],
    ["strings -a fixtures/app.bin", "safe", "read_only", "strings"],
    ["node --version", "safe", "version_check", "node"],
    ["mkdir generated", "sensitive", "workspace_mutation", "mkdir"],
    ["npm test", "sensitive", "project_toolchain", "npm"],
    ["npm run custom", "sensitive", "unrecognized_operation", "npm"],
    ["cargo publish", "sensitive", "network_or_external_effect", "cargo"],
    ["git commit -m test", "sensitive", "git_mutation", "git"],
    ["npm run deploy", "sensitive", "network_or_external_effect", "npm"],
    [
      "custom-tool --flag",
      "sensitive",
      "unrecognized_executable",
      "custom-tool",
    ],
    ["git frobnicate", "sensitive", "unrecognized_operation", "git"],
    ["echo ok > generated.txt", "sensitive", "workspace_redirection", "echo"],
    ["rg token ~/.ssh", "dangerous", "secret_path", "rg"],
    ["sudo git status", "dangerous", "privileged", "sudo"],
    ["git push origin main", "dangerous", "network_or_external_effect", "git"],
    ["echo $(whoami)", "dangerous", "opaque_shell", undefined],
    ["python -c 1", "dangerous", "inline_interpreter", "python"],
  ])(
    "assigns stable classification metadata for %s",
    (command, expectedTier, code, executable) => {
      expect(classify(command).perSubCommand[0]?.result).toEqual(
        expect.objectContaining({ tier: expectedTier, code, executable }),
      );
    },
  );

  it("preserves per-subcommand metadata for compound commands", () => {
    expect(
      classify("mkdir generated && custom-tool --flag").perSubCommand.map(
        ({ result }) => result.code,
      ),
    ).toEqual(["workspace_mutation", "unrecognized_executable"]);
  });

  it("honors threshold ordering", () => {
    expect(isTierAtOrBelow("safe", "safe")).toBe(true);
    expect(isTierAtOrBelow("sensitive", "safe")).toBe(false);
    expect(isTierAtOrBelow("sensitive", "sensitive")).toBe(true);
    expect(isTierAtOrBelow("dangerous", "sensitive")).toBe(false);
    expect(isTierAtOrBelow("safe", "off")).toBe(false);
  });
});

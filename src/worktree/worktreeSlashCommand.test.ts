import { describe, expect, it } from "vitest";

import {
  extractWorktreeSetupConfig,
  parseWorktreeSlashCommand,
} from "./worktreeSlashCommand.js";

describe("parseWorktreeSlashCommand", () => {
  it("uses a positional description as the task and prompt", () => {
    expect(parseWorktreeSlashCommand("try the alternate auth design")).toEqual({
      draft: {
        task: "try the alternate auth design",
        prompt: "try the alternate auth design",
      },
      needsConfiguration: false,
    });
  });

  it("parses quoted launch parameters", () => {
    expect(
      parseWorktreeSlashCommand(
        '--task "Auth experiment" --prompt "Prototype passkeys" --branch experiment/passkeys --base main --path ../trees/passkeys --mode code --prefill',
      ),
    ).toEqual({
      draft: {
        task: "Auth experiment",
        prompt: "Prototype passkeys",
        branch: "experiment/passkeys",
        baseRef: "main",
        worktreePath: "../trees/passkeys",
        mode: "code",
        autoSubmit: false,
      },
      needsConfiguration: false,
    });
  });

  it("requests configuration when only placement options are supplied", () => {
    expect(parseWorktreeSlashCommand("--branch experiment/passkeys")).toEqual({
      draft: { branch: "experiment/passkeys" },
      needsConfiguration: true,
    });
  });

  it("rejects unknown options and unterminated quotes", () => {
    expect(() => parseWorktreeSlashCommand("--wat value")).toThrow(
      "Unknown /worktree option",
    );
    expect(() => parseWorktreeSlashCommand('--task "broken')).toThrow(
      "Unterminated quote",
    );
    expect(() => parseWorktreeSlashCommand("--task --branch nope")).toThrow(
      "--task requires a value",
    );
  });

  it("preserves backslashes in quoted paths", () => {
    expect(
      parseWorktreeSlashCommand(
        '--path "C:\\trees\\auth" --prompt "Prototype auth"',
      ).draft.worktreePath,
    ).toBe("C:\\trees\\auth");
  });
});

describe("extractWorktreeSetupConfig", () => {
  it("separates display text from a validated launch envelope", () => {
    expect(
      extractWorktreeSetupConfig(
        'Ready to launch.\n<worktree-config>{"task":"Auth","prompt":"Prototype auth","branch":"experiment/auth","autoSubmit":false}</worktree-config>',
      ),
    ).toEqual({
      displayText: "Ready to launch.",
      draft: {
        task: "Auth",
        prompt: "Prototype auth",
        branch: "experiment/auth",
        autoSubmit: false,
      },
    });
  });

  it("reports incomplete or malformed envelopes", () => {
    expect(
      extractWorktreeSetupConfig(
        '<worktree-config>{"task":"Auth"}</worktree-config>',
      ).error,
    ).toContain("incomplete");
    expect(
      extractWorktreeSetupConfig("<worktree-config>{nope}</worktree-config>")
        .error,
    ).toContain("invalid configuration JSON");
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  tryGetFirstWorkspaceRoot,
  diagnostics,
  diffOpen,
  diffWaitForUserDecision,
  diffSaveChanges,
  diffRevertChanges,
  diffGetEditedContent,
  diffDispose,
  onDidChangeTabs,
  tabs,
} = vi.hoisted(() => ({
  tryGetFirstWorkspaceRoot: vi.fn(),
  diagnostics: vi.fn(() => []),
  diffOpen: vi.fn(),
  diffWaitForUserDecision: vi.fn(),
  diffSaveChanges: vi.fn(),
  diffRevertChanges: vi.fn(),
  diffGetEditedContent: vi.fn(),
  diffDispose: vi.fn(),
  onDidChangeTabs: vi.fn(),
  tabs: [] as unknown[],
}));

vi.mock("vscode", () => ({
  DiagnosticSeverity: { Error: 0 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TabInputTextDiff: class TabInputTextDiff {
    modified: { fsPath: string };
    constructor(filePath: string) {
      this.modified = { fsPath: filePath };
    }
  },
  languages: { getDiagnostics: diagnostics },
  workspace: { getConfiguration: () => ({ get: () => 0 }) },
  window: {
    tabGroups: {
      all: [{ tabs }],
      onDidChangeTabs,
    },
  },
}));

vi.mock("../util/paths.js", () => ({
  tryGetFirstWorkspaceRoot,
}));

vi.mock("../integrations/DiffViewProvider.js", () => ({
  withFileLock: async (_filePath: string, fn: () => Promise<unknown>) => fn(),
  DiffViewProvider: vi.fn().mockImplementation(function (
    _delay?: number,
    requestId?: string,
  ) {
    return {
      requestId: requestId ?? "diff-request-1",
      open: diffOpen,
      waitForUserDecision: diffWaitForUserDecision,
      saveChanges: diffSaveChanges,
      revertChanges: diffRevertChanges,
      getEditedContent: diffGetEditedContent,
      dispose: diffDispose,
    };
  }),
}));

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function approvingPanel(overrides?: {
  decision?: "accept" | "reject";
  rejectionReason?: string;
  followUp?: string;
  memoryTier?: "instructions" | "skill" | "command" | "memory";
  memoryScope?: "global" | "project";
  memoryName?: string;
}) {
  const requests: unknown[] = [];
  return {
    requests,
    panel: {
      enqueueMemoryApproval: vi.fn((request: unknown) => {
        requests.push(request);
        return {
          id: "approval-1",
          promise: Promise.resolve({
            decision: overrides?.decision ?? "accept",
            ...overrides,
          }),
        };
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tabs.length = 0;
  onDidChangeTabs.mockImplementation(() => ({ dispose: vi.fn() }));
  diffWaitForUserDecision.mockResolvedValue("accept");
  diffSaveChanges.mockImplementation(async () => {
    const lastOpenCall = diffOpen.mock.calls.at(-1);
    const filePath = lastOpenCall?.[0] as string;
    const content = lastOpenCall?.[2] as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return {
      status: "accepted",
      path: lastOpenCall?.[1],
      finalContent: content,
      durability: {
        status: "durable",
        outcome: "exact",
        policy: "allow_transform",
        baseline_exists: false,
        final_exists: true,
        disk_changed: true,
        baseline_content_hash: "baseline",
        approved_content_hash: "approved",
        expected_disk_content_hash: "expected",
        editor_content_hash: "editor",
        final_content_hash: "final",
        requires_reread: false,
      },
    };
  });
  diffGetEditedContent.mockImplementation(
    () => diffOpen.mock.calls.at(-1)?.[2],
  );

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-memory-test-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-memory-home-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  tryGetFirstWorkspaceRoot.mockReturnValue(tmpDir);
  diagnostics.mockReturnValue([]);
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("handleProposeMemory", () => {
  it("rejects legacy low-authority memory proposals before review", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "memory",
        scope: "project",
        operation: "add",
        title: "Remember verification command",
        rationale: "The user corrected the verification workflow.",
        content: "- Run `npm test` after production code changes.",
      },
      panel as never,
    );

    expect(text(result)).toMatchObject({
      error:
        "Low-authority memory must use manage_memory, not an approval proposal",
    });
    expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
    expect(diffOpen).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, ".agentlink", "memory.md"))).toBe(
      false,
    );
  });

  it.each(["unchanged", "changed", "missing", "unreadable"] as const)(
    "reports %s disk evidence when memory review cannot open",
    async (diskState) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const target = path.join(tmpDir, "AGENTS.md");
      fs.writeFileSync(target, "- Existing\n");
      const { panel } = approvingPanel();
      diffOpen.mockImplementationOnce(async () => {
        if (diskState === "changed")
          fs.writeFileSync(target, "concurrent content");
        if (diskState === "missing") fs.unlinkSync(target);
        if (diskState === "unreadable") {
          fs.unlinkSync(target);
          fs.mkdirSync(target);
        }
        throw new Error("Unable to apply proposed editor changes");
      });

      const result = await handleProposeMemory(
        {
          tier: "instructions",
          scope: "project",
          operation: "add",
          title: "Add guidance",
          rationale: "User-requested guidance.",
          content: "- New guidance",
        },
        panel as never,
      );

      expect(result.isError).toBe(true);
      expect(text(result)).toMatchObject({
        reason: "review_open_failed",
        failure_stage: "review_open",
        approval_state: "not_requested",
        save_state: "not_attempted",
        disk_state: diskState,
        buffer_state: "unknown",
        retryable: false,
      });
      expect(text(result).next_steps[0]).toContain("do not blindly replay");
      expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
      expect(diffSaveChanges).not.toHaveBeenCalled();
      expect(diffRevertChanges).not.toHaveBeenCalled();
    },
  );

  it("distinguishes a newly created empty review target from an unchanged absent file", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();
    diffOpen.mockImplementationOnce(async (filePath: string) => {
      fs.writeFileSync(filePath, "");
      throw new Error("Unable to apply proposed editor changes");
    });
    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Add guidance",
        rationale: "User-requested guidance.",
        content: "- New guidance",
      },
      panel as never,
    );
    expect(text(result)).toMatchObject({
      disk_state: "changed",
      save_state: "not_attempted",
    });
    expect(fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8")).toBe("");
  });

  it("preserves prior retarget approval when the destination review fails to open", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({ memoryScope: "global" });
    diffOpen
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Review open failed"));
    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Add guidance",
        rationale: "User-requested guidance.",
        content: "- New guidance",
      },
      panel as never,
    );
    expect(text(result)).toMatchObject({
      failure_stage: "review_open",
      approval_state: "retarget_accepted_review_not_requested",
      save_state: "not_attempted",
      disk_state: "missing",
      path: "~/.agentlink/CLAUDE.md",
    });
    expect(panel.enqueueMemoryApproval).toHaveBeenCalledTimes(1);
    expect(diffWaitForUserDecision).not.toHaveBeenCalled();
    expect(diffSaveChanges).not.toHaveBeenCalled();
    expect(diffRevertChanges).toHaveBeenCalledTimes(1);
  });

  it("returns current content when update replacement cannot be found", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "- Existing\n");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "update",
        title: "Update memory",
        rationale: "Stale entry.",
        content: "- Replacement",
        replaces: "- Missing",
      },
      panel as never,
    );

    expect(text(result)).toMatchObject({
      error: "Could not find replaces text in target file",
      currentContent: "- Existing\n",
    });
  });

  it("clears the skill directory when retargeting away from project skills", async () => {
    const { isSameMemoryProposalDestination, retargetMemoryProposal } =
      await import("../shared/memoryProposalEngine.js");
    const selected = {
      tier: "skill" as const,
      scope: "project" as const,
      operation: "add" as const,
      name: "team-skill",
      skill_directory: ".agents/skills" as const,
      title: "Add skill",
      rationale: "Retarget safely.",
      content: "skill",
    };
    const global = retargetMemoryProposal(
      selected,
      { memoryTier: "instructions", memoryScope: "global" },
      "global instructions",
    );
    expect(global.skill_directory).toBeUndefined();
    const defaultProjectSkill = { ...selected, skill_directory: undefined };
    expect(isSameMemoryProposalDestination(selected, defaultProjectSkill)).toBe(
      false,
    );
  });

  it("keeps the default project skill target in AgentLink skills", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();
    await handleProposeMemory(
      {
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "default-skill",
        title: "Add skill",
        rationale: "Keep the existing default.",
        content: "---\nname: default-skill\ndescription: Use in tests.\n---\n",
      },
      panel as never,
    );
    expect(diffOpen).toHaveBeenCalledWith(
      path.join(tmpDir, ".agentlink/skills/default-skill/SKILL.md"),
      ".agentlink/skills/default-skill/SKILL.md",
      expect.stringContaining("name: default-skill"),
    );
  });

  it("writes an explicitly selected team skill target", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "team-skill",
        skill_directory: ".agents/skills",
        title: "Add team skill",
        rationale: "Use the team skill convention.",
        content:
          "---\nname: team-skill\ndescription: Use for team work.\n---\n# Team\n",
      },
      panel as never,
    );

    const selectedPath = path.join(
      tmpDir,
      ".agents",
      "skills",
      "team-skill",
      "SKILL.md",
    );
    expect(diffOpen).toHaveBeenCalledWith(
      selectedPath,
      ".agents/skills/team-skill/SKILL.md",
      expect.stringContaining("name: team-skill"),
    );
    expect(fs.existsSync(selectedPath)).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".agentlink/skills/team-skill/SKILL.md")),
    ).toBe(false);
    expect(text(result)).toMatchObject({
      path: ".agents/skills/team-skill/SKILL.md",
    });
  });

  it("does not write an explicitly selected skill after approval is rejected", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel, requests } = approvingPanel({ decision: "reject" });
    const result = await handleProposeMemory(
      {
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "rejected-skill",
        skill_directory: ".agents/skills",
        title: "Add skill",
        rationale: "Wait for approval.",
        content: "---\nname: rejected-skill\ndescription: Use in tests.\n---\n",
      },
      panel as never,
    );
    expect(requests[0]).toMatchObject({
      targetPath: path.join(tmpDir, ".agents/skills/rejected-skill/SKILL.md"),
    });
    expect(text(result).status).toBe("rejected_by_user");
    expect(
      fs.existsSync(
        path.join(tmpDir, ".agents/skills/rejected-skill/SKILL.md"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".agentlink/skills/rejected-skill/SKILL.md"),
      ),
    ).toBe(false);
  });

  it.each([
    ["accept", "missing"],
    ["reject", "missing"],
    ["accept", "escape"],
    ["reject", "escape"],
  ] as const)(
    "preserves the review without save or rollback after %s when the target becomes %s",
    async (decision, failure) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const targetPath = path.join(
        tmpDir,
        ".agents/skills/retained-skill/SKILL.md",
      );
      const outsidePath = path.join(tmpHome, "outside.md");
      const content = "---\nname: retained-skill\ndescription: Updated.\n---\n";
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content);
      fs.writeFileSync(outsidePath, "outside content must remain unchanged");
      const { panel } = approvingPanel({ decision });
      panel.enqueueMemoryApproval.mockImplementation(() => {
        fs.unlinkSync(targetPath);
        if (failure === "escape") fs.symlinkSync(outsidePath, targetPath);
        return { id: "approval-1", promise: Promise.resolve({ decision }) };
      });
      const result = await handleProposeMemory(
        {
          tier: "skill",
          scope: "project",
          operation: "update",
          name: "retained-skill",
          skill_directory: ".agents/skills",
          title: "Update skill",
          rationale: "Do not write or roll back after target validation fails.",
          content,
        },
        panel as never,
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toMatchObject({
        reason: "proposal_target_validation_failed",
        path: ".agents/skills/retained-skill/SKILL.md",
        save_state: "not_attempted",
        rollback_state: "not_attempted",
        buffer_state: "retained",
      });
      expect(diffSaveChanges).not.toHaveBeenCalled();
      expect(diffRevertChanges).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsidePath, "utf-8")).toBe(
        "outside content must remain unchanged",
      );
      if (failure === "missing") expect(fs.existsSync(targetPath)).toBe(false);
    },
  );

  it("preserves the retargeted review when its update target disappears after approval", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const sourcePath = path.join(
      tmpDir,
      ".agentlink/commands/source-command.md",
    );
    const targetPath = path.join(
      tmpDir,
      ".agentlink/skills/final-skill/SKILL.md",
    );
    const content = "---\nname: final-skill\ndescription: Updated.\n---\n";
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(sourcePath, "existing command");
    fs.writeFileSync(targetPath, content);
    const { panel } = approvingPanel({
      memoryTier: "skill",
      memoryScope: "project",
      memoryName: "final-skill",
    });
    diffWaitForUserDecision.mockImplementation(async () => {
      fs.unlinkSync(targetPath);
      return "accept";
    });
    const result = await handleProposeMemory(
      {
        tier: "command",
        scope: "project",
        operation: "update",
        name: "source-command",
        title: "Retarget to skill",
        rationale: "Preserve the final review on target validation failure.",
        content,
      },
      panel as never,
    );
    expect(text(result)).toMatchObject({
      reason: "proposal_target_validation_failed",
      path: ".agentlink/skills/final-skill/SKILL.md",
      buffer_state: "retained",
    });
    expect(diffRevertChanges).toHaveBeenCalledTimes(1);
    expect(diffSaveChanges).not.toHaveBeenCalled();
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe("existing command");
  });

  it.each(["update", "remove"] as const)(
    "does not retarget a missing %s from the selected project skill directory",
    async (operation) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const alternatePath = path.join(
        tmpDir,
        ".agentlink",
        "skills",
        "specific-skill",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(alternatePath), { recursive: true });
      fs.writeFileSync(
        alternatePath,
        "---\nname: specific-skill\ndescription: Existing.\n---\n",
      );
      const { panel } = approvingPanel();

      const result = await handleProposeMemory(
        {
          tier: "skill",
          scope: "project",
          operation,
          name: "specific-skill",
          skill_directory: ".agents/skills",
          title: "Change skill",
          rationale: "Target only the selected source.",
          content:
            operation === "remove"
              ? ""
              : "---\nname: specific-skill\ndescription: Updated.\n---\n",
        },
        panel as never,
      );

      expect(text(result).error).toContain(
        "Skill target not found: .agents/skills/specific-skill/SKILL.md",
      );
      expect(text(result).error).toContain(
        "same-named skill exists at .agentlink/skills/specific-skill/SKILL.md",
      );
      expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
      expect(diffOpen).not.toHaveBeenCalled();
      expect(fs.existsSync(alternatePath)).toBe(true);
    },
  );

  it.each([
    [
      { tier: "instructions", scope: "project" },
      "skill_directory is only valid",
    ],
    [{ tier: "skill", scope: "global" }, "skill_directory is only valid"],
    [
      { tier: "skill", scope: "project", skill_directory: "other" },
      "skill_directory must be",
    ],
  ] as const)(
    "rejects invalid skill-directory selection before review",
    async (base, error) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const { panel } = approvingPanel();
      const result = await handleProposeMemory(
        {
          skill_directory: ".agents/skills",
          name: "test-skill",
          ...base,
          operation: "add",
          title: "Add skill",
          rationale: "Validate selection.",
          content: "---\nname: test-skill\ndescription: Use in tests.\n---\n",
        } as never,
        panel as never,
      );
      expect(text(result).error).toContain(error);
      expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
      expect(diffOpen).not.toHaveBeenCalled();
    },
  );

  it.each(["update", "remove"] as const)(
    "checks a retargeted missing skill %s destination under its write lock",
    async (operation) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "Old instruction.\n");
      const alternatePath = path.join(
        tmpDir,
        ".agents",
        "skills",
        "retarget-skill",
        "SKILL.md",
      );
      fs.mkdirSync(path.dirname(alternatePath), { recursive: true });
      fs.writeFileSync(
        alternatePath,
        "---\nname: retarget-skill\ndescription: Existing team skill.\n---\n",
      );
      const { panel } = approvingPanel({
        memoryTier: "skill",
        memoryScope: "project",
        memoryName: "retarget-skill",
      });

      const result = await handleProposeMemory(
        {
          tier: "instructions",
          scope: "project",
          operation,
          title: "Retarget skill change",
          rationale: "Validate the final destination too.",
          content:
            operation === "remove"
              ? ""
              : "---\nname: retarget-skill\ndescription: Updated.\n---\n",
          replaces: "Old instruction.",
        },
        panel as never,
      );

      expect(text(result).error).toContain(
        "Skill target not found: .agentlink/skills/retarget-skill/SKILL.md",
      );
      expect(text(result).error).toContain(
        "same-named skill exists at .agents/skills/retarget-skill/SKILL.md",
      );
      expect(diffOpen).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(alternatePath)).toBe(true);
    },
  );

  it("does not offer project skill hints for a missing global skill target", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const alternatePath = path.join(
      tmpDir,
      ".agents",
      "skills",
      "global-miss",
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(alternatePath), { recursive: true });
    fs.writeFileSync(
      alternatePath,
      "---\nname: global-miss\ndescription: Project-only skill.\n---\n",
    );
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "skill",
        scope: "global",
        operation: "update",
        name: "global-miss",
        title: "Update global skill",
        rationale: "Do not suggest a project-local target.",
        content: "---\nname: global-miss\ndescription: Updated.\n---\n",
      },
      panel as never,
    );

    expect(text(result).error).toContain("Skill target not found");
    expect(text(result).error).not.toContain("same-named skill exists");
    expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
  });

  it.each(["ancestor", "target"] as const)(
    "rejects a dangling selected skill %s symlink before review",
    async (linkType) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const outside = path.join(tmpDir, "dangling-destination");
      const skillDirectory = path.join(
        tmpDir,
        ".agents",
        "skills",
        "dangling-skill",
      );
      if (linkType === "ancestor") {
        fs.symlinkSync(outside, path.join(tmpDir, ".agents"), "dir");
      } else {
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.symlinkSync(outside, path.join(skillDirectory, "SKILL.md"));
      }
      const { panel } = approvingPanel();

      const result = await handleProposeMemory(
        {
          tier: "skill",
          scope: "project",
          operation: "add",
          name: "dangling-skill",
          skill_directory: ".agents/skills",
          title: "Add skill",
          rationale: "Reject dangling links before review.",
          content:
            "---\nname: dangling-skill\ndescription: Use in tests.\n---\n",
        },
        panel as never,
      );

      expect(text(result).error).toMatch(
        /ENOENT|outside the approved workspace/,
      );
      expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
      expect(diffOpen).not.toHaveBeenCalled();
    },
  );

  it("rejects a selected project skill directory that symlinks outside the workspace", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-skill-outside-"),
    );
    fs.symlinkSync(outside, path.join(tmpDir, ".agents"), "dir");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "escaped-skill",
        skill_directory: ".agents/skills",
        title: "Add skill",
        rationale: "Stay within workspace.",
        content: "---\nname: escaped-skill\ndescription: Use in tests.\n---\n",
      },
      panel as never,
    );

    expect(text(result).error).toContain("outside the approved workspace");
    expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
    expect(diffOpen).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(outside, "skills/escaped-skill/SKILL.md")),
    ).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("validates skill frontmatter name before requesting approval", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "good-skill",
        title: "Add skill",
        rationale: "Reusable workflow.",
        content:
          "---\nname: wrong-skill\ndescription: Use when testing.\n---\n# Skill\n",
      },
      panel as never,
    );

    expect(panel.enqueueMemoryApproval).not.toHaveBeenCalled();
    expect(text(result)).toMatchObject({
      error:
        'Skill frontmatter name must match the skill directory name ("good-skill")',
    });
  });

  it("validates diff-edited content when approval retargets to a skill", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({
      memoryTier: "skill",
      memoryScope: "project",
      memoryName: "new-skill",
    });
    diffGetEditedContent.mockReturnValue(
      "---\nname: wrong-skill\ndescription: Use when testing.\n---\n# Skill\n",
    );

    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Retarget to skill",
        rationale: "Reusable workflow.",
        content: "Remember this workflow.",
      },
      panel as never,
    );

    expect(text(result)).toMatchObject({
      error:
        'Skill frontmatter name must match the skill directory name ("new-skill")',
    });
    expect(diffRevertChanges).toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(tmpDir, ".agentlink", "skills", "new-skill", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("rejects and reverts when the proposal diff tab is closed", async () => {
    const { TabInputTextDiff } = await import("vscode");
    const { handleProposeMemory } = await import("./proposeMemory.js");
    let closeListener: ((event: { closed: unknown[] }) => void) | undefined;
    onDidChangeTabs.mockImplementation((listener) => {
      closeListener = listener;
      return { dispose: vi.fn() };
    });

    const panel = {
      cancelApproval: vi.fn(),
      enqueueMemoryApproval: vi.fn((request: { id: string }) => {
        const target = path.join(tmpDir, "AGENTS.md");
        const DiffInput = TabInputTextDiff as unknown as {
          new (filePath: string): unknown;
        };
        tabs.push({ input: new DiffInput(target) });
        setTimeout(() => {
          tabs.length = 0;
          closeListener?.({ closed: [{}] });
        }, 0);
        return {
          id: request.id,
          promise: new Promise(() => undefined),
        };
      }),
    };

    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Remember preference",
        rationale: "User preference.",
        content: "- Prefer single approvals.",
      },
      panel as never,
    );

    expect(text(result)).toMatchObject({
      status: "rejected_by_user",
      path: "AGENTS.md",
    });
    expect(panel.cancelApproval).toHaveBeenCalledWith("diff-request-1");
    expect(diffRevertChanges).toHaveBeenCalled();
    expect(diffSaveChanges).not.toHaveBeenCalled();
  });

  it("re-approves retargeted instructions against the new target content", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    fs.mkdirSync(path.join(tmpHome, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "CLAUDE.md"),
      "- Existing global\n",
    );
    const panel = {
      enqueueMemoryApproval: vi.fn((_request: unknown) => ({
        id: "approval-1",
        promise: Promise.resolve({ decision: "accept", memoryScope: "global" }),
      })),
    };

    await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Retarget instructions",
        rationale: "User preference.",
        content: "- New global preference",
      },
      panel as never,
    );

    expect(panel.enqueueMemoryApproval).toHaveBeenCalledTimes(1);
    expect(panel.enqueueMemoryApproval.mock.calls[0][0]).not.toHaveProperty(
      "content",
    );
    expect(diffOpen).toHaveBeenCalledWith(
      path.join(tmpHome, ".agentlink", "CLAUDE.md"),
      "~/.agentlink/CLAUDE.md",
      expect.stringContaining("- Existing global\n\n- New global preference"),
    );
    expect(
      fs.readFileSync(path.join(tmpHome, ".agentlink", "CLAUDE.md"), "utf-8"),
    ).toContain("- Existing global\n\n- New global preference");
  });

  it("removes command target files instead of emptying them", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const commandPath = path.join(
      tmpDir,
      ".agentlink",
      "commands",
      "old-command.md",
    );
    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.writeFileSync(commandPath, "old body\n");
    const { panel } = approvingPanel();

    await handleProposeMemory(
      {
        tier: "command",
        scope: "project",
        operation: "remove",
        name: "old-command",
        title: "Remove old command",
        rationale: "Stale workflow.",
        content: "",
      },
      panel as never,
    );

    expect(fs.existsSync(commandPath)).toBe(false);
    expect(diffOpen).not.toHaveBeenCalled();
  });

  it("updates the loaded same-scope command source instead of creating a blank AgentLink command", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const commandPath = path.join(
      tmpHome,
      ".claude",
      "commands",
      "address-pr-feedback.md",
    );
    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.writeFileSync(commandPath, "Existing command body.\n");
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "command",
        scope: "global",
        operation: "update",
        name: "address-pr-feedback",
        title: "Update command",
        rationale: "Include all review feedback surfaces.",
        content: "Updated command body.",
      },
      panel as never,
    );

    expect(diffOpen).toHaveBeenCalledWith(
      commandPath,
      "~/.claude/commands/address-pr-feedback.md",
      "Updated command body.\n",
    );
    expect(
      fs.existsSync(
        path.join(tmpHome, ".agentlink", "commands", "address-pr-feedback.md"),
      ),
    ).toBe(false);
    expect(text(result)).toMatchObject({
      status: "accepted",
      path: "~/.claude/commands/address-pr-feedback.md",
    });
  });

  it("returns approval rejection notes in the standard chat annotation shape", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({
      decision: "reject",
      rejectionReason: "Keep the current command body.",
      followUp: "Read the loaded command before trying again.",
    });

    const result = await handleProposeMemory(
      {
        tier: "command",
        scope: "global",
        operation: "update",
        name: "address-pr-feedback",
        title: "Update command",
        rationale: "Include all review feedback surfaces.",
        content: "Updated command body.",
      },
      panel as never,
    );

    expect(text(result)).toMatchObject({
      status: "rejected_by_user",
      reason: "Keep the current command body.",
      follow_up: "Read the loaded command before trying again.",
    });
  });

  it("supports approval retargeting to global command", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({
      memoryTier: "command",
      memoryScope: "global",
      memoryName: "verify-all",
    });
    diffSaveChanges.mockImplementation(async () => {
      const filePath = path.join(
        tmpHome,
        ".agentlink",
        "commands",
        "verify-all.md",
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "Run full verification.\n");
      return {
        status: "accepted",
        path: filePath,
        finalContent: "Run full verification.\n",
        durability: {
          status: "durable",
          outcome: "exact",
          policy: "allow_transform",
          baseline_exists: false,
          final_exists: true,
          disk_changed: true,
          baseline_content_hash: "baseline",
          approved_content_hash: "approved",
          expected_disk_content_hash: "expected",
          editor_content_hash: "editor",
          final_content_hash: "final",
          requires_reread: false,
        },
      };
    });

    await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Remember command",
        rationale: "Reusable workflow prompt.",
        content: "Run full verification.",
      },
      panel as never,
    );

    expect(
      fs.readFileSync(
        path.join(tmpHome, ".agentlink", "commands", "verify-all.md"),
        "utf-8",
      ),
    ).toBe("Run full verification.\n");
  });

  it.each([
    ["save_reverted_edit", "reverted"],
    ["editor_disk_diverged", "diverged"],
    ["post_save_file_missing", "unverifiable"],
  ] as const)(
    "returns a canonical error when the reviewed save fails durability (%s)",
    async (reason, outcome) => {
      const { handleProposeMemory } = await import("./proposeMemory.js");
      const { panel } = approvingPanel();
      diffSaveChanges.mockResolvedValue({
        status: "error",
        path: "AGENTS.md",
        error: "Approved memory proposal was not durably saved",
        reason,
        finalContent: "observed disk content",
        durability: {
          status: "failed",
          outcome,
          policy: "allow_transform",
          baseline_exists: true,
          final_exists: outcome === "unverifiable" ? false : true,
          disk_changed: outcome === "unverifiable" ? "unknown" : false,
          baseline_content_hash: "baseline",
          approved_content_hash: "approved",
          expected_disk_content_hash: "expected",
          editor_content_hash: "editor",
          ...(outcome === "unverifiable"
            ? {}
            : { final_content_hash: "final" }),
          requires_reread: true,
        },
        next_steps: ["Re-read the file before retrying."],
      });

      const result = await handleProposeMemory(
        {
          tier: "instructions",
          scope: "project",
          operation: "add",
          title: "Remember durable preference",
          rationale: "User preference.",
          content: "- Preserve this preference.",
        },
        panel as never,
      );

      expect(result.isError).toBe(true);
      expect(text(result)).toMatchObject({
        status: "error",
        reason,
        durability: { status: "failed", outcome },
      });
      expect(text(result)).not.toHaveProperty("finalContent");
      expect(diffRevertChanges).not.toHaveBeenCalled();
      expect(diffDispose).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when an accepted save lacks durability evidence", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel();
    diffSaveChanges.mockResolvedValue({
      status: "accepted",
      path: "AGENTS.md",
      finalContent: "proposed content",
    });

    const result = await handleProposeMemory(
      {
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Remember durable preference",
        rationale: "User preference.",
        content: "- Preserve this preference.",
      },
      panel as never,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ status: "error" });
    expect(text(result)).not.toHaveProperty("finalContent");
    expect(diffRevertChanges).not.toHaveBeenCalled();
    expect(diffDispose).toHaveBeenCalledOnce();
  });
});

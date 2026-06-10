import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tryGetFirstWorkspaceRoot, diagnostics } = vi.hoisted(() => ({
  tryGetFirstWorkspaceRoot: vi.fn(),
  diagnostics: vi.fn(() => []),
}));

vi.mock("vscode", () => ({
  DiagnosticSeverity: { Error: 0 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  languages: { getDiagnostics: diagnostics },
}));

vi.mock("../util/paths.js", () => ({
  tryGetFirstWorkspaceRoot,
}));

let tmpDir: string;
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function approvingPanel(overrides?: {
  editedContent?: string;
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
          promise: Promise.resolve({ decision: "accept", ...overrides }),
        };
      }),
    },
  };
}

beforeEach(() => {
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
  it("appends dated project memory after approval", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel, requests } = approvingPanel();

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

    const target = path.join(tmpDir, ".agentlink", "memory.md");
    expect(fs.readFileSync(target, "utf-8")).toMatch(
      /Run `npm test` after production code changes\.\n<!-- added \d{4}-\d{2}-\d{2} -->\n/,
    );
    expect(requests[0]).toMatchObject({
      tier: "memory",
      scope: "project",
      targetPath: ".agentlink/memory.md",
    });
    expect(text(result)).toMatchObject({
      status: "accepted",
      path: ".agentlink/memory.md",
      tier: "memory",
      scope: "project",
    });
  });

  it("returns current content when update replacement cannot be found", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    fs.mkdirSync(path.join(tmpDir, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agentlink", "memory.md"),
      "- Existing\n",
    );
    const { panel } = approvingPanel();

    const result = await handleProposeMemory(
      {
        tier: "memory",
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

  it("validates edited content when approval retargets to a skill", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({
      memoryTier: "skill",
      memoryScope: "project",
      memoryName: "new-skill",
      editedContent:
        "---\nname: wrong-skill\ndescription: Use when testing.\n---\n# Skill\n",
    });

    const result = await handleProposeMemory(
      {
        tier: "memory",
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
    expect(
      fs.existsSync(
        path.join(tmpDir, ".agentlink", "skills", "new-skill", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("re-approves retargeted memory against the new target content", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    fs.mkdirSync(path.join(tmpHome, ".agentlink"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".agentlink", "memory.md"),
      "- Existing global\n",
    );
    let calls = 0;
    const panel = {
      enqueueMemoryApproval: vi.fn((_request: { proposedContent: string }) => {
        calls += 1;
        return {
          id: `approval-${calls}`,
          promise: Promise.resolve(
            calls === 1
              ? { decision: "accept", memoryScope: "global" }
              : { decision: "accept" },
          ),
        };
      }),
    };

    await handleProposeMemory(
      {
        tier: "memory",
        scope: "project",
        operation: "add",
        title: "Retarget memory",
        rationale: "User preference.",
        content: "- New global preference",
      },
      panel as never,
    );

    expect(panel.enqueueMemoryApproval).toHaveBeenCalledTimes(2);
    expect(
      panel.enqueueMemoryApproval.mock.calls[1][0].proposedContent,
    ).toContain("- Existing global\n\n- New global preference");
    expect(
      fs.readFileSync(path.join(tmpHome, ".agentlink", "memory.md"), "utf-8"),
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
  });

  it("supports approval retargeting to global command", async () => {
    const { handleProposeMemory } = await import("./proposeMemory.js");
    const { panel } = approvingPanel({
      memoryTier: "command",
      memoryScope: "global",
      memoryName: "verify-all",
      editedContent: "Run full verification.\n",
    });

    await handleProposeMemory(
      {
        tier: "memory",
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
});

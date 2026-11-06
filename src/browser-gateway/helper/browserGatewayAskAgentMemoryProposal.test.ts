/** @vitest-environment node */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { BrowserGatewayAskAgentMemoryProposalBridge } from "./browserGatewayAskAgentMemoryProposal.js";

async function makeHome(): Promise<string> {
  return await fs.mkdtemp(
    path.join(os.tmpdir(), ".tmp-ask-agent-memory-home-"),
  );
}

describe("BrowserGatewayAskAgentMemoryProposalBridge", () => {
  const globalSkillContent =
    "---\nname: global-skill\ndescription: Test global skill.\n---\nOriginal\n";
  const globalSkillUpdate = globalSkillContent.replace("Original", "Updated");
  function skillRequest(operation: "add" | "update" | "remove") {
    return {
      tier: "skill" as const,
      scope: "global" as const,
      operation,
      name: "global-skill",
      title: "Maintain global skill",
      rationale: "Verified correction.",
      content: globalSkillUpdate,
    };
  }
  async function writeSkill(home: string, directory: string) {
    const filePath = path.join(home, directory, "skills/global-skill/SKILL.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, globalSkillContent);
    return filePath;
  }

  describe.each([".agentlink", ".agents", ".claude"])(
    "existing global source %s",
    (directory) => {
      it.each(["update", "remove"] as const)(
        "reviews and %s the unique skill source",
        async (operation) => {
          const homeDir = await makeHome();
          try {
            const filePath = await writeSkill(homeDir, directory);
            const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
              homeDir,
            });
            const approval = await bridge.propose(skillRequest(operation));
            expect(approval.memoryTargetPath).toBe(
              `~/${directory}/skills/global-skill/SKILL.md`,
            );
            expect(await fs.readFile(filePath, "utf-8")).toBe(
              globalSkillContent,
            );
            const result = await bridge.submitDecision({
              type: "decision",
              id: approval.id,
              decision: "accept",
            });
            expect(result).toMatchObject({
              status: "accepted",
              path: approval.memoryTargetPath,
            });
            if (operation === "update")
              expect(await fs.readFile(filePath, "utf-8")).toBe(
                globalSkillUpdate,
              );
            else
              await expect(fs.stat(filePath)).rejects.toMatchObject({
                code: "ENOENT",
              });
            if (directory !== ".agentlink")
              await expect(
                fs.stat(
                  path.join(homeDir, ".agentlink/skills/global-skill/SKILL.md"),
                ),
              ).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await fs.rm(homeDir, { recursive: true, force: true });
          }
        },
      );
    },
  );

  describe.each(["symlink", "hardlink", "root-symlink"])(
    "supported %s aliases",
    (aliasKind) => {
      it.each(["update", "remove"] as const)(
        "uses the actual source for %s",
        async (operation) => {
          const homeDir = await makeHome();
          try {
            const source = await writeSkill(homeDir, ".agents");
            const alias = path.join(
              homeDir,
              ".claude/skills/global-skill/SKILL.md",
            );
            if (aliasKind === "root-symlink") {
              await fs.mkdir(path.join(homeDir, ".claude"));
              await fs.symlink(
                path.join(homeDir, ".agents/skills"),
                path.join(homeDir, ".claude/skills"),
                "dir",
              );
            } else {
              await fs.mkdir(path.dirname(alias), { recursive: true });
              if (aliasKind === "hardlink") await fs.link(source, alias);
              else await fs.symlink(source, alias);
            }
            const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
              homeDir,
            });
            const approval = await bridge.propose(skillRequest(operation));
            expect(approval.memoryTargetPath).toBe(
              "~/.agents/skills/global-skill/SKILL.md",
            );
            const result = await bridge.submitDecision({
              type: "decision",
              id: approval.id,
              decision: "accept",
            });
            expect(result.status).toBe("accepted");
            if (operation === "update")
              expect(await fs.readFile(source, "utf-8")).toBe(
                globalSkillUpdate,
              );
            else
              await expect(fs.stat(source)).rejects.toMatchObject({
                code: "ENOENT",
              });
          } finally {
            await fs.rm(homeDir, { recursive: true, force: true });
          }
        },
      );
    },
  );

  it("removes the real source rather than a higher-priority symlink alias", async () => {
    const homeDir = await makeHome();
    try {
      const source = await writeSkill(homeDir, ".agents");
      const alias = path.join(
        homeDir,
        ".agentlink/skills/global-skill/SKILL.md",
      );
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(source, alias);
      const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
        homeDir,
      });
      const approval = await bridge.propose(skillRequest("remove"));
      expect(approval.memoryTargetPath).toBe(
        "~/.agents/skills/global-skill/SKILL.md",
      );
      await bridge.submitDecision({
        type: "decision",
        id: approval.id,
        decision: "accept",
      });
      await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each(["update", "remove"] as const)(
    "rejects a supported alias switch after %s approval",
    async (operation) => {
      const homeDir = await makeHome();
      try {
        const source = await writeSkill(homeDir, ".agents");
        const alias = path.join(
          homeDir,
          ".claude/skills/global-skill/SKILL.md",
        );
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.symlink(source, alias);
        const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
          homeDir,
        });
        const approval = await bridge.propose(skillRequest(operation));
        const other = path.join(homeDir, ".agents/skills/other/SKILL.md");
        await fs.mkdir(path.dirname(other), { recursive: true });
        await fs.writeFile(other, globalSkillContent);
        await fs.unlink(alias);
        await fs.symlink(other, alias);
        await expect(
          bridge.submitDecision({
            type: "decision",
            id: approval.id,
            decision: "accept",
          }),
        ).rejects.toThrow();
        expect(await fs.readFile(source, "utf-8")).toBe(globalSkillContent);
        expect(await fs.readFile(other, "utf-8")).toBe(globalSkillContent);
      } finally {
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps global skill adds under .agentlink", async () => {
    const homeDir = await makeHome();
    try {
      const alternate = await writeSkill(homeDir, ".agents");
      const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
        homeDir,
      });
      const approval = await bridge.propose(skillRequest("add"));
      expect(approval.memoryTargetPath).toBe(
        "~/.agentlink/skills/global-skill/SKILL.md",
      );
      await bridge.submitDecision({
        type: "decision",
        id: approval.id,
        decision: "accept",
      });
      expect(await fs.readFile(alternate, "utf-8")).toBe(globalSkillContent);
      expect(
        await fs.readFile(
          path.join(homeDir, ".agentlink/skills/global-skill/SKILL.md"),
          "utf-8",
        ),
      ).toBe(globalSkillUpdate);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each(["update", "remove"] as const)(
    "rejects ambiguous %s before presenting approval",
    async (operation) => {
      const homeDir = await makeHome();
      try {
        await writeSkill(homeDir, ".agents");
        await writeSkill(homeDir, ".claude");
        const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
          homeDir,
        });
        await expect(bridge.propose(skillRequest(operation))).rejects.toThrow(
          "Ambiguous global skill target",
        );
        expect(bridge.getPendingApproval()).toBeNull();
      } finally {
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects an existing skill linked outside the allowed source", async () => {
    const homeDir = await makeHome();
    try {
      const filePath = await writeSkill(homeDir, ".agents");
      const outside = path.join(homeDir, "outside.md");
      await fs.writeFile(outside, globalSkillContent);
      await fs.unlink(filePath);
      await fs.symlink(outside, filePath);
      const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
        homeDir,
      });
      await expect(bridge.propose(skillRequest("update"))).rejects.toThrow(
        "outside its allowed directory",
      );
      expect(bridge.getPendingApproval()).toBeNull();
      expect(await fs.readFile(outside, "utf-8")).toBe(globalSkillContent);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("requires another proposal when removal selects a different existing skill", async () => {
    const homeDir = await makeHome();
    try {
      const source = await writeSkill(homeDir, ".agents");
      const other = path.join(homeDir, ".claude/skills/other-skill/SKILL.md");
      await fs.mkdir(path.dirname(other), { recursive: true });
      await fs.writeFile(
        other,
        globalSkillContent.replace("global-skill", "other-skill"),
      );
      const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
        homeDir,
      });
      const approval = await bridge.propose(skillRequest("remove"));
      await expect(
        bridge.submitDecision({
          type: "decision",
          id: approval.id,
          decision: "accept",
          memoryName: "other-skill",
        }),
      ).rejects.toThrow("target changed since review");
      expect(await fs.readFile(source, "utf-8")).toBe(globalSkillContent);
      expect(await fs.readFile(other, "utf-8")).toContain("name: other-skill");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  describe.each(["update", "remove"] as const)(
    "existing global skill %s",
    (operation) => {
      it.each(["source", "root", "symlink", "content", "ambiguity"])(
        "rejects %s drift after review without touching replacements",
        async (drift) => {
          const homeDir = await makeHome();
          try {
            const filePath = await writeSkill(homeDir, ".agents");
            const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({
              homeDir,
            });
            const approval = await bridge.propose(skillRequest(operation));
            let replacement = filePath;
            if (drift === "source") {
              await fs.rename(
                path.dirname(filePath),
                path.join(homeDir, "moved-skill"),
              );
              replacement = await writeSkill(homeDir, ".claude");
            } else if (drift === "root") {
              await fs.rename(
                path.join(homeDir, ".agents/skills"),
                path.join(homeDir, "moved-root"),
              );
              await writeSkill(homeDir, ".agents");
            } else if (drift === "symlink") {
              replacement = path.join(homeDir, "outside.md");
              await fs.writeFile(replacement, globalSkillContent);
              await fs.unlink(filePath);
              await fs.symlink(replacement, filePath);
            } else if (drift === "content") {
              await fs.writeFile(filePath, globalSkillContent + "Concurrent\n");
            } else {
              replacement = await writeSkill(homeDir, ".claude");
            }
            await expect(
              bridge.submitDecision({
                type: "decision",
                id: approval.id,
                decision: "accept",
              }),
            ).rejects.toThrow();
            expect(await fs.readFile(replacement, "utf-8")).toBe(
              globalSkillContent + (drift === "content" ? "Concurrent\n" : ""),
            );
          } finally {
            await fs.rm(homeDir, { recursive: true, force: true });
          }
        },
      );
    },
  );
  it("requires approval before writing authoritative instructions", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });

    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Remember preference",
      rationale: "User asked Ask Agent to remember it.",
      content: "User prefers concise answers.",
    });

    const instructionsPath = path.join(homeDir, ".agentlink", "CLAUDE.md");
    await expect(fs.readFile(instructionsPath, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(bridge.getPendingApproval()).toMatchObject({
      id: approval.id,
      kind: "memory",
      memoryScope: "global",
      memoryTier: "instructions",
    });

    const result = await bridge.submitDecision({
      type: "decision",
      id: approval.id,
      decision: "accept",
      editedContent: `${approval.memoryContent ?? ""}\n`,
    });

    expect(result).toMatchObject({
      status: "accepted",
      path: "~/.agentlink/CLAUDE.md",
    });
    await expect(fs.readFile(instructionsPath, "utf-8")).resolves.toContain(
      "User prefers concise answers.",
    );
    expect(bridge.getPendingApproval()).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("does not write rejected proposals", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Remember preference",
      rationale: "User asked Ask Agent to remember it.",
      content: "User prefers terse status notes.",
    });

    const result = await bridge.submitDecision({
      type: "decision",
      id: approval.id,
      decision: "reject",
      rejectionReason: "Not durable",
    });

    expect(result).toMatchObject({
      status: "rejected",
      rejectionReason: "Not durable",
    });
    await expect(
      fs.readFile(path.join(homeDir, ".agentlink", "CLAUDE.md"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("re-applies unedited approvals to current target content", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Remember preference",
      rationale: "User asked Ask Agent to remember it.",
      content: "User prefers final summaries with validation notes.",
    });
    const instructionsPath = path.join(homeDir, ".agentlink", "CLAUDE.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "Existing durable entry.\n", "utf-8");

    await bridge.submitDecision({
      type: "decision",
      id: approval.id,
      decision: "accept",
    });

    const written = await fs.readFile(instructionsPath, "utf-8");
    expect(written).toContain("Existing durable entry.");
    expect(written).toContain(
      "User prefers final summaries with validation notes.",
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("fails stale replace approvals when current target content changed", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const instructionsPath = path.join(homeDir, ".agentlink", "CLAUDE.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "Old preference.\n", "utf-8");
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "update",
      title: "Update preference",
      rationale: "User corrected a durable preference.",
      content: "New preference.",
      replaces: "Old preference.",
    });
    await fs.writeFile(
      instructionsPath,
      "Different current content.\n",
      "utf-8",
    );

    await expect(
      bridge.submitDecision({
        type: "decision",
        id: approval.id,
        decision: "accept",
      }),
    ).rejects.toThrow("Could not find replaces text in target file");
    await expect(fs.readFile(instructionsPath, "utf-8")).resolves.toBe(
      "Different current content.\n",
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("re-applies unedited retargeted approvals to the final global target", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Save reusable command",
      rationale: "User asked Ask Agent to remember it as a command.",
      content: "Draft a concise checklist-based smoke-test note.",
    });
    const instructionsPath = path.join(homeDir, ".agentlink", "CLAUDE.md");
    const commandPath = path.join(
      homeDir,
      ".agentlink",
      "commands",
      "smoke-note.md",
    );
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "Existing command body.\n", "utf-8");

    await bridge.submitDecision({
      type: "decision",
      id: approval.id,
      decision: "accept",
      memoryTier: "command",
      memoryScope: "global",
      memoryName: "smoke-note",
    });

    await expect(fs.readFile(instructionsPath, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(commandPath, "utf-8")).resolves.toBe(
      "Draft a concise checklist-based smoke-test note.\n",
    );

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("rejects low-authority memory proposals in favor of autonomous management", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });

    await expect(
      bridge.propose({
        tier: "memory",
        scope: "global",
        operation: "add",
        title: "Remember preference",
        rationale: "Low-authority memory does not require approval.",
        content: "User prefers concise answers.",
      }),
    ).rejects.toThrow(
      "Low-authority memory must use autonomous memory management",
    );
    expect(bridge.getPendingApproval()).toBeNull();

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("rejects retargeting authoritative approval to low-authority memory", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Add instruction",
      rationale: "Authoritative configuration requires review.",
      content: "Use focused validation.",
    });

    await expect(
      bridge.submitDecision({
        type: "decision",
        id: approval.id,
        decision: "accept",
        memoryTier: "memory",
      }),
    ).rejects.toThrow(
      "Low-authority memory must use autonomous memory management",
    );
    await expect(
      fs.readFile(path.join(homeDir, ".agentlink", "memory.md"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("blocks project-scoped authoritative configuration from projectless Ask Agent", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });

    await expect(
      bridge.propose({
        tier: "instructions",
        scope: "project",
        operation: "add",
        title: "Remember project detail",
        rationale: "Should not be allowed from projectless Ask Agent.",
        content: "Project-specific detail.",
      }),
    ).rejects.toThrow("Project-scoped durable memory is unavailable here");

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("rejects a project skill-directory selector instead of stripping it", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });

    await expect(
      bridge.propose({
        tier: "skill",
        scope: "project",
        operation: "add",
        name: "team-skill",
        skill_directory: ".agents/skills",
        title: "Add team skill",
        rationale:
          "Project skill target cannot be used by projectless Ask Agent.",
        content:
          "---\nname: team-skill\ndescription: Use for team work.\n---\n",
      }),
    ).rejects.toThrow("Project-scoped durable memory is unavailable here");
    expect(bridge.getPendingApproval()).toBeNull();
    await expect(
      fs.readFile(
        path.join(homeDir, ".agents/skills/team-skill/SKILL.md"),
        "utf-8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("rejects retargeting approval to project scope", async () => {
    const homeDir = await makeHome();
    const bridge = new BrowserGatewayAskAgentMemoryProposalBridge({ homeDir });
    const approval = await bridge.propose({
      tier: "instructions",
      scope: "global",
      operation: "add",
      title: "Remember preference",
      rationale: "User asked Ask Agent to remember it.",
      content: "User prefers markdown checklists.",
    });

    await expect(
      bridge.submitDecision({
        type: "decision",
        id: approval.id,
        decision: "accept",
        editedContent: approval.memoryContent,
        memoryScope: "project",
      }),
    ).rejects.toThrow("Project-scoped durable memory is unavailable here");
    await expect(
      fs.readFile(path.join(homeDir, ".agentlink", "CLAUDE.md"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

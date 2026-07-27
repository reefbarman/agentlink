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

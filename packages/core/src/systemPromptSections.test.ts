import { describe, expect, it } from "vitest";

import {
  buildBackgroundAgentSection,
  buildBasePrompt,
  buildModePrompt,
  buildWorkspaceFoldersSection,
  formatModeInstructionBlock,
  FULL_SYSTEM_PROMPT_CAPABILITIES,
  getProviderPrompt,
  type SystemPromptCapabilities,
} from "./systemPromptSections.js";

const NO_CAPABILITIES: SystemPromptCapabilities = {
  fileEdits: false,
  commandRetryGuidance: false,
  memory: false,
  askUser: false,
  modeSwitching: false,
  richOutput: false,
  todos: false,
  finalStatus: false,
  approvalFollowUp: false,
  backgroundAgents: false,
};

const GATED_TOOL_MENTIONS = [
  "write_file",
  "apply_diff",
  "retry_guidance",
  "manage_memory",
  "ask_user",
  "modeSwitch",
  "switch_mode",
  "rich-output",
  "todo_write",
  "set_task_status",
  "follow_up",
  "spawn_background_agent",
  "get_background_result",
];

describe("system prompt sections", () => {
  for (const profile of ["compatibility", "reasoning"] as const) {
    it(`renders every guidance section with full capabilities (${profile})`, () => {
      const prompt = buildBasePrompt(profile, {
        identity: "You are AgentLink, a test agent.",
        cwd: "/repo",
        indexedToolScope: "## Indexed tool scope\n\n- surface-owned",
      });
      expect(prompt.startsWith("You are AgentLink, a test agent.\n\n")).toBe(
        true,
      );
      expect(prompt).toContain("/repo");
      expect(prompt).toContain("## Indexed tool scope\n\n- surface-owned");
      for (const mention of GATED_TOOL_MENTIONS.filter(
        (name) =>
          profile === "compatibility" ||
          // The reasoning Core Contract is deliberately terse.
          ![
            "write_file",
            "apply_diff",
            "manage_memory",
            "modeSwitch",
            "switch_mode",
            "rich-output",
            "todo_write",
            "spawn_background_agent",
            "get_background_result",
          ].includes(name),
      )) {
        expect(prompt, mention).toContain(mention);
      }
      expect(prompt).not.toMatch(/\n{3,}/u);
      expect(prompt).toBe(prompt.trim());
    });

    it(`never advertises an absent capability (${profile})`, () => {
      const prompt = buildBasePrompt(profile, {
        identity: "You are AgentLink, a test agent.",
        cwd: "/repo",
        capabilities: NO_CAPABILITIES,
      });
      for (const mention of GATED_TOOL_MENTIONS) {
        expect(prompt, mention).not.toContain(mention);
      }
      expect(prompt).not.toContain("Indexed tool scope");
      expect(prompt).not.toMatch(/\n{3,}/u);
      expect(prompt).toBe(prompt.trim());
    });
  }

  it("keeps ask_user guidance but drops modeSwitch without mode switching", () => {
    const prompt = buildBasePrompt("compatibility", {
      identity: "You are AgentLink, a test agent.",
      cwd: "/repo",
      capabilities: {
        ...FULL_SYSTEM_PROMPT_CAPABILITIES,
        modeSwitching: false,
      },
    });
    expect(prompt).toContain("## Questions & Clarification");
    expect(prompt).toContain("Use the most appropriate question type");
    expect(prompt).not.toContain("modeSwitch");
  });

  it("selects provider tuning by profile and maps openai to codex", () => {
    expect(getProviderPrompt("compatibility", "openai")).toBe(
      getProviderPrompt("compatibility", "codex"),
    );
    expect(getProviderPrompt("compatibility", "anthropic")).toContain(
      "### Visible progress and rationale",
    );
    expect(getProviderPrompt("reasoning", "anthropic")).toBe("");
    expect(getProviderPrompt("reasoning", "codex")).toContain(
      "## Provider-Specific Behavior",
    );
    expect(getProviderPrompt("compatibility", "unknown")).toBe("");
    expect(getProviderPrompt("compatibility", undefined)).toBe("");
  });

  it("falls back to code mode and renders custom modes", () => {
    expect(buildModePrompt("missing")).toBe(buildModePrompt("code"));
    const custom = buildModePrompt("docs", {
      slug: "docs",
      name: "Docs",
      icon: "book",
      toolGroups: ["read"],
      roleDefinition: "Write documentation.",
      customInstructions: "Use British spelling.",
    });
    expect(custom).toContain("## Docs Mode");
    expect(custom).toContain("Write documentation.");
    expect(custom).toContain("### Project Mode Instructions");
  });

  it("formats the conversation mode block with host-supplied rules", () => {
    const block = formatModeInstructionBlock("architect", {
      promptProfile: "reasoning",
      modeRules: "Rule one.",
      plansFolderExists: true,
    });
    expect(block.startsWith('<current_mode mode="architect">\n')).toBe(true);
    expect(block).toContain("## Architect Mode");
    expect(block).toContain("### Mode Rules\n\nRule one.");
    expect(block).toContain("Plans folder (`./plans`): exists");
    expect(block.endsWith("\n</current_mode>")).toBe(true);
    expect(formatModeInstructionBlock("code")).not.toContain("Plans folder");
  });

  it("lists workspace folders only for multi-root workspaces", () => {
    expect(buildWorkspaceFoldersSection([{ name: "a", path: "/a" }])).toBe("");
    expect(
      buildWorkspaceFoldersSection([
        { name: "a", path: "/a" },
        { name: "b", path: "/b" },
      ]),
    ).toContain("  - b: /b");
  });

  it("adds the bounded review loop only for review-mode children", () => {
    expect(buildBackgroundAgentSection("review")).toContain(
      "### Bounded Review Loop",
    );
    expect(buildBackgroundAgentSection("code")).not.toContain(
      "### Bounded Review Loop",
    );
  });
});

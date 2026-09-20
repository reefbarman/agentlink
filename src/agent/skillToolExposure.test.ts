import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./AgentSession.js";
import { BUILT_IN_MODES } from "./modes.js";
import type { SkillEntry } from "./skillLoader.js";
import { buildPromptArtifacts } from "./systemPrompt.js";
import {
  createAgentToolRuntime,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import {
  createNativeToolDisclosureSnapshot,
  discoverNativeTools,
} from "../core/tools/nativeToolDisclosure.js";
import type { AgentToolExecutionContext } from "../core/tools/types.js";
import { handleExecuteCommand } from "../tools/executeCommand.js";

vi.mock("./systemPrompt.js", () => ({
  buildPromptArtifacts: vi.fn(),
  buildModeInstructionBlock: vi.fn().mockResolvedValue(""),
}));
vi.mock("../tools/executeCommand.js", () => ({
  handleExecuteCommand: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "command reached executor" }],
  }),
}));

const skill: SkillEntry = {
  id: "project:agentlink:.agentlink/skills/bash-only",
  name: "bash-only",
  description: "Shell-only workflow",
  revision: "a".repeat(64),
  sourceChars: 100,
  skillPath: "/test/.agentlink/skills/bash-only/SKILL.md",
  provenance: {
    scope: "project",
    namespace: "agentlink",
    sourceRoot: "/test/.agentlink/skills",
    skillDirectory: "/test/.agentlink/skills/bash-only",
    realSkillPath: "/test/.agentlink/skills/bash-only/SKILL.md",
    priority: 1,
  },
  allowedTools: ["Bash"],
  restrictions: { allowedTools: ["Bash"] },
  permissions: { requestedTools: [] },
  dependencies: [],
  recommendations: [],
  resolvedDependencies: [],
  enabled: true,
};

beforeEach(() => {
  vi.mocked(buildPromptArtifacts).mockResolvedValue({
    systemPrompt: "test prompt",
    skills: [skill],
    advertisedRules: [],
    promptProfile: {
      profile: "compatibility",
      source: "compatibility-default",
      policyRevision: "prompt-profile-policy-v1",
      providerId: "test",
      modelId: "test",
    },
    promptBreakdown: { sections: [], totalChars: 0, estimatedTokens: 0 },
  });
});
afterEach(() => vi.clearAllMocks());

async function activatedRuntime(modeSlug = "code", toolProfile?: string) {
  const session = await AgentSession.createForLegacyCwd({
    cwd: "/test",
    mode: modeSlug,
    config: {
      model: "test",
      maxTokens: 1024,
      thinkingBudget: 0,
      showThinking: false,
      autoCondense: false,
      autoCondenseThreshold: 0.9,
    },
  });
  expect(session.trackLoadedSkill(skill)).toBe(true);
  const getCommandApprovalPolicy = vi.fn();
  const dispatchContext = {
    approvalManager: {},
    approvalPanel: {},
    sessionId: session.id,
    extensionUri: {},
    onApprovalRequest: vi.fn(),
    terminalProvider: {},
    getCommandApprovalPolicy,
  } as unknown as ToolDispatchContext;
  const runtime = createAgentToolRuntime(dispatchContext);
  const mode =
    modeSlug === "no-shell"
      ? { slug: modeSlug, name: "No shell", icon: "book", toolGroups: ["read"] }
      : BUILT_IN_MODES.find((entry) => entry.slug === modeSlug)!;
  const skillAllowedTools = session.getActiveSkillAllowedTools();
  const definitions = runtime.listTools({
    mode,
    toolProfile,
    isBackground: Boolean(toolProfile),
    skillAllowedTools,
  });
  const nativeToolDisclosure = createNativeToolDisclosureSnapshot(definitions);
  const context: AgentToolExecutionContext = {
    sessionId: session.id,
    mode: modeSlug,
    toolProfile,
    skillAllowedTools,
    nativeToolDisclosure,
    availableToolNames: new Set(
      nativeToolDisclosure.inlineTools.map((tool) => tool.name),
    ),
    modeAllowedToolNames: new Set(definitions.map((tool) => tool.name)),
  };
  return {
    session,
    runtime,
    context,
    definitions,
    nativeToolDisclosure,
    dispatchContext,
    getCommandApprovalPolicy,
  };
}

describe("Bash skill production tool exposure", () => {
  it("exposes and dispatches only the native shell executor through session policy and runtime composition", async () => {
    const {
      runtime,
      context,
      definitions,
      nativeToolDisclosure,
      dispatchContext,
      getCommandApprovalPolicy,
    } = await activatedRuntime();
    const names = definitions.map((tool) => tool.name);
    expect(names).toContain("execute_command");
    for (const excluded of [
      "Bash",
      "read_file",
      "write_file",
      "find_mcp_tools",
      "call_mcp_tool",
    ])
      expect(names).not.toContain(excluded);
    expect(nativeToolDisclosure.inlineTools.map((tool) => tool.name)).toContain(
      "execute_command",
    );
    expect(
      discoverNativeTools(nativeToolDisclosure, {
        query: "read_file write_file generate_image",
      }).tools,
    ).toEqual([]);
    const input = { command: "git status --short", timeout: 10 };
    const result = await runtime.executeTool({
      name: "execute_command",
      input,
      context,
    });
    expect(result.isError).not.toBe(true);
    expect(handleExecuteCommand).toHaveBeenCalledWith(
      input,
      dispatchContext.approvalManager,
      dispatchContext.approvalPanel,
      context.sessionId,
      undefined,
      expect.objectContaining({
        terminalProvider: dispatchContext.terminalProvider,
        getCommandApprovalPolicy,
      }),
    );
    const denied = await runtime.executeTool({
      name: "call_native_tool",
      input: { name: "generate_image", input: {} },
      context,
    });
    expect(denied.isError).toBe(true);
    expect(handleExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it("does not override a mode that excludes shell execution", async () => {
    const { runtime, context, definitions } =
      await activatedRuntime("no-shell");
    expect(definitions.map((tool) => tool.name)).not.toContain(
      "execute_command",
    );
    expect(
      (
        await runtime.executeTool({
          name: "execute_command",
          input: { command: "git status" },
          context,
        })
      ).isError,
    ).toBe(true);
    expect(handleExecuteCommand).not.toHaveBeenCalled();
  });

  it("does not override a restrictive background profile", async () => {
    const { runtime, context, definitions } = await activatedRuntime(
      "code",
      "btw",
    );
    expect(definitions.map((tool) => tool.name)).not.toContain(
      "execute_command",
    );
    expect(
      (
        await runtime.executeTool({
          name: "execute_command",
          input: { command: "git status" },
          context,
        })
      ).isError,
    ).toBe(true);
    expect(handleExecuteCommand).not.toHaveBeenCalled();
  });

  it("preserves read-only command policy at the executor boundary", async () => {
    const { runtime, context } = await activatedRuntime(
      "ask",
      "readonly-research",
    );
    const result = await runtime.executeTool({
      name: "execute_command",
      input: { command: "git status" },
      context: { ...context, commandExecutionPolicy: "read-only" },
    });
    expect(result.isError).not.toBe(true);
    expect(vi.mocked(handleExecuteCommand).mock.calls[0]?.[5]).toMatchObject({
      commandExecutionPolicy: "read-only",
    });
  });
});

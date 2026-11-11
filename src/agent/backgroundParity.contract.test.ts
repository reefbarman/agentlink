import { describe, expect, it } from "vitest";

import { BUILT_IN_MODES } from "./modes.js";
import { REASONING_EFFORT_PROPERTY } from "@agentlink/core/background-agent-tools";
import { getAgentTools } from "./toolAdapter.js";

const FOREGROUND_ONLY_TOOLS = new Set([
  "compose",
  "respond_to_background_question",
  // Cross-session history is bound only to foreground sessions.
  "search_workspace_sessions",
  "read_workspace_session_excerpt",
]);

const mcpTools = [
  {
    name: "example__lookup",
    description: "Lookup",
    input_schema: { type: "object" as const, properties: {} },
  },
];

describe("foreground/background capability parity contract", () => {
  for (const mode of BUILT_IN_MODES) {
    it(`${mode.slug} exposes the same native and MCP tools by placement`, () => {
      const foreground = getAgentTools(mode, mcpTools, false)
        .map((tool) => tool.name)
        .filter((name) => !FOREGROUND_ONLY_TOOLS.has(name));
      const background = getAgentTools(mode, mcpTools, true).map(
        (tool) => tool.name,
      );
      expect(background).toEqual(foreground);
      expect(
        getAgentTools(mode, mcpTools, true).map((tool) => tool.name),
      ).not.toContain("compose");
      const backgroundNames = getAgentTools(mode, mcpTools, true).map(
        (tool) => tool.name,
      );
      for (const name of FOREGROUND_ONLY_TOOLS) {
        expect(backgroundNames).not.toContain(name);
      }
    });
  }

  it("advertises the shared reasoning-effort contract on background spawns", () => {
    const spawn = getAgentTools(
      BUILT_IN_MODES.find((mode) => mode.slug === "code"),
      [],
      false,
    ).find((tool) => tool.name === "spawn_background_agent");
    expect(spawn).toBeDefined();
    expect(
      (spawn!.input_schema as { properties: Record<string, unknown> })
        .properties.reasoningEffort,
    ).toEqual(REASONING_EFFORT_PROPERTY);
  });

  it("preserves full code-mode MCP and session controls", () => {
    const code = getAgentTools(
      BUILT_IN_MODES.find((mode) => mode.slug === "code"),
      mcpTools,
      true,
    ).map((tool) => tool.name);
    expect(code).toEqual(
      expect.arrayContaining([
        "example__lookup",
        "switch_mode",
        "set_task_status",
        "spawn_background_agent",
      ]),
    );
  });

  it("applies the read-only review profile explicitly rather than by placement", () => {
    const reviewMode = BUILT_IN_MODES.find((mode) => mode.slug === "review");
    const unrestricted = getAgentTools(reviewMode, mcpTools, true).map(
      (tool) => tool.name,
    );
    const reviewTools = getAgentTools(reviewMode, mcpTools, true, "review");
    const reviewOnly = reviewTools.map((tool) => tool.name);
    expect(unrestricted).toContain("write_file");
    expect(reviewOnly).not.toContain("write_file");
    expect(reviewOnly).not.toContain("example__lookup");
    const readFile = reviewTools.find((tool) => tool.name === "read_file");
    expect(readFile).toBeDefined();
    expect(
      (
        readFile!.input_schema as {
          properties?: { view?: { enum?: string[] } };
        }
      ).properties?.view?.enum,
    ).toContain("context");
  });
});

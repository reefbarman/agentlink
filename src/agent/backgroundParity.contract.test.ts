import { describe, expect, it } from "vitest";
import { BUILT_IN_MODES } from "./modes.js";
import { getAgentTools } from "./toolAdapter.js";

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
      const foreground = getAgentTools(mode, mcpTools, false).map(
        (tool) => tool.name,
      );
      const background = getAgentTools(mode, mcpTools, true).map(
        (tool) => tool.name,
      );
      expect(background).toEqual(foreground);
    });
  }

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

  it("applies review-only restrictions explicitly rather than by placement", () => {
    const unrestricted = getAgentTools(
      BUILT_IN_MODES.find((mode) => mode.slug === "code"),
      mcpTools,
      true,
    ).map((tool) => tool.name);
    const reviewOnly = getAgentTools(
      BUILT_IN_MODES.find((mode) => mode.slug === "code"),
      mcpTools,
      true,
      "review",
    ).map((tool) => tool.name);
    expect(unrestricted).toContain("write_file");
    expect(reviewOnly).not.toContain("write_file");
    expect(reviewOnly).toContain("example__lookup");
  });
});

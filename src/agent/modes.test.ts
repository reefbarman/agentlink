import { BUILT_IN_MODES, buildUnionAgentMode } from "./modes.js";
import { describe, expect, it } from "vitest";

import { getToolsForMode } from "./toolPermissions.js";

describe("built-in modes", () => {
  it("gives review mode terminal access without the general edit group", () => {
    const review = BUILT_IN_MODES.find((mode) => mode.slug === "review");
    expect(review?.toolGroups).toContain("command");
    expect(review?.toolGroups).not.toContain("edit");
    expect(getToolsForMode(review!)).toContain("write_file");
  });

  it("allows image generation in architect without general edit access", () => {
    const architect = BUILT_IN_MODES.find((mode) => mode.slug === "architect");
    const tools = getToolsForMode(architect!);

    expect(architect?.toolGroups).toContain("media");
    expect(architect?.toolGroups).not.toContain("edit");
    expect(tools).toContain("generate_image");
    expect(tools).not.toContain("find_and_replace");
    expect(tools).not.toContain("rename_symbol");

    const toolsByMode = new Map(
      BUILT_IN_MODES.map((mode) => [mode.slug, getToolsForMode(mode)]),
    );
    expect(toolsByMode.get("code")).toContain("generate_image");
    for (const mode of ["ask", "debug", "review"]) {
      expect(toolsByMode.get(mode), mode).not.toContain("generate_image");
    }
  });

  it("keeps orchestrate focused on coordination rather than direct mutation", () => {
    const orchestrate = BUILT_IN_MODES.find(
      (mode) => mode.slug === "orchestrate",
    );
    const tools = getToolsForMode(orchestrate!);

    expect(orchestrate?.toolGroups).toEqual(
      expect.arrayContaining(["read", "language", "search", "memory", "mcp"]),
    );
    expect(orchestrate?.toolGroups).not.toContain("edit");
    expect(orchestrate?.toolGroups).not.toContain("command");
    expect(tools).toContain("get_repo_map");
    expect(tools).toContain("get_references");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("execute_command");
  });

  it("preserves image generation for custom modes using the edit group", () => {
    expect(
      getToolsForMode({
        slug: "custom",
        name: "Custom",
        icon: "tools",
        toolGroups: ["edit"],
      }),
    ).toContain("generate_image");
  });

  it("does not expose review's constrained write through a reusable tool group", () => {
    expect(
      getToolsForMode({
        slug: "custom",
        name: "Custom",
        icon: "tools",
        toolGroups: ["read", "temporary-write"],
      }),
    ).not.toContain("write_file");
  });
});

describe("buildUnionAgentMode", () => {
  it("merges tool groups across all built-in modes", () => {
    const union = buildUnionAgentMode(BUILT_IN_MODES);
    expect(union.toolGroups).toEqual(
      expect.arrayContaining([
        "read",
        "edit",
        "media",
        "command",
        "language",
        "search",
        "mcp",
        "plan",
      ]),
    );
  });

  it("drops read-only-command when full command access is present", () => {
    const union = buildUnionAgentMode(BUILT_IN_MODES);
    expect(union.toolGroups).toContain("command");
    expect(union.toolGroups).not.toContain("read-only-command");
  });

  it("keeps read-only-command when no mode grants full command access", () => {
    const union = buildUnionAgentMode([
      { slug: "a", name: "A", icon: "x", toolGroups: ["read"] },
      {
        slug: "b",
        name: "B",
        icon: "x",
        toolGroups: ["read", "read-only-command"],
      },
    ]);
    expect(union.toolGroups).toContain("read-only-command");
  });

  it("is deterministic regardless of input mode order", () => {
    const forward = buildUnionAgentMode(BUILT_IN_MODES);
    const reversed = buildUnionAgentMode([...BUILT_IN_MODES].reverse());
    expect(forward.toolGroups).toEqual(reversed.toolGroups);
  });
});

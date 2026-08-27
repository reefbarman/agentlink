import { BUILT_IN_MODES, buildUnionAgentMode } from "./modes.js";
import { describe, expect, it } from "vitest";

describe("built-in modes", () => {
  it("gives review mode terminal access without edit tools", () => {
    const review = BUILT_IN_MODES.find((mode) => mode.slug === "review");
    expect(review?.toolGroups).toContain("command");
    expect(review?.toolGroups).not.toContain("edit");
  });
});

describe("buildUnionAgentMode", () => {
  it("merges tool groups across all built-in modes", () => {
    const union = buildUnionAgentMode(BUILT_IN_MODES);
    expect(union.toolGroups).toEqual(
      expect.arrayContaining([
        "read",
        "edit",
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

import { describe, expect, it } from "vitest";

import { APPLY_DIFF_INPUT_GRAMMAR } from "./applyDiffFormat.js";
import { TOOL_REGISTRY } from "./toolRegistry.js";
import { applyDiffSchema } from "./toolSchemas.js";

describe("TOOL_REGISTRY", () => {
  it("tells agents that execute_command already disables interactive pagers", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "AgentLink already disables interactive pagers consistently",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "do not add `GIT_PAGER=cat`",
    );
  });

  it("uses one apply_diff grammar across the tool and input schema", () => {
    expect(TOOL_REGISTRY.apply_diff.description).toContain(
      APPLY_DIFF_INPUT_GRAMMAR,
    );
    expect(applyDiffSchema.diff.description).toBe(APPLY_DIFF_INPUT_GRAMMAR);
    expect(APPLY_DIFF_INPUT_GRAMMAR).toContain(
      "bare ======= line is literal payload",
    );
    expect(APPLY_DIFF_INPUT_GRAMMAR).toContain(
      "unified-diff input with an @@ hunk",
    );
  });

  it("advertises structural-protection recovery guidance", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "unsafe filesystem nodes in protected trees",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "structured `retry_guidance`",
    );
  });
});

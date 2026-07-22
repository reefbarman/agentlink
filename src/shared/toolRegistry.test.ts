import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "./toolRegistry.js";

describe("TOOL_REGISTRY", () => {
  it("tells agents that execute_command already disables interactive pagers", () => {
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "AgentLink already disables interactive pagers consistently",
    );
    expect(TOOL_REGISTRY.execute_command.description).toContain(
      "do not add `GIT_PAGER=cat`",
    );
  });
});

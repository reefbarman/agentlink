import type {
  McpConfigBatchMutation,
  McpConfigMutationTarget,
  McpConfigSnapshot,
  McpManagerScope,
} from "./mcpManagerTypes.js";
import { describe, expectTypeOf, it } from "vitest";

describe("MCP manager protocol compatibility shim", () => {
  it("preserves the legacy snapshot and mutation contracts", () => {
    expectTypeOf<McpManagerScope>().toEqualTypeOf<
      "global" | "project" | "ask-agent-global"
    >();
    expectTypeOf<McpConfigMutationTarget>().toHaveProperty("kind");
    expectTypeOf<McpConfigBatchMutation>().toHaveProperty("operations");
    expectTypeOf<McpConfigSnapshot>().toHaveProperty("capabilities");
  });
});

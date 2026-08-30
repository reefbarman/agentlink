import type {
  McpConfigBatchMutation,
  McpConfigMutationTarget,
  McpConfigSnapshot,
  McpManagerServerDraft,
} from "./mcpManager.js";
import { describe, expectTypeOf, it } from "vitest";

describe("MCP manager protocol", () => {
  it("keeps snapshots, mutation authority, and drafts serializable", () => {
    expectTypeOf<McpConfigMutationTarget>().toHaveProperty("kind");
    expectTypeOf<McpManagerServerDraft>().toHaveProperty("name");
    expectTypeOf<McpConfigBatchMutation>().toMatchTypeOf<{
      operationId: string;
      expectedRevision: string;
    }>();
    expectTypeOf<McpConfigSnapshot>().toMatchTypeOf<{
      version: number;
      entries: unknown[];
      statusInfos: unknown[];
    }>();
  });
});

import type {
  AgentPluginManagerAction,
  AgentPluginManagerSnapshot,
} from "./agentPluginManagerTypes.js";
import { describe, expectTypeOf, it } from "vitest";

describe("agent plugin manager protocol compatibility shim", () => {
  it("preserves the legacy snapshot and action contracts", () => {
    expectTypeOf<AgentPluginManagerSnapshot>().toHaveProperty("schemaVersion");
    expectTypeOf<AgentPluginManagerSnapshot>().toHaveProperty("rows");
    expectTypeOf<AgentPluginManagerAction>().toEqualTypeOf<
      | "enable"
      | "disable"
      | "reinstall"
      | "rollback"
      | "uninstall"
      | "remove-data"
      | "install-declared"
    >();
  });
});

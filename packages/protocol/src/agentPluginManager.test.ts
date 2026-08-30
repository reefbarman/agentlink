import type {
  AgentPluginManagerAction,
  AgentPluginManagerRow,
  AgentPluginManagerSnapshot,
} from "./agentPluginManager.js";
import { describe, expectTypeOf, it } from "vitest";

describe("agent plugin manager protocol", () => {
  it("keeps manager snapshots and actions serializable", () => {
    expectTypeOf<AgentPluginManagerSnapshot>().toMatchTypeOf<{
      schemaVersion: 1;
      registryRevision: number;
      catalogRevision: number;
      rows: readonly AgentPluginManagerRow[];
    }>();
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

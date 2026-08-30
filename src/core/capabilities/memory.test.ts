import type {
  AutomaticMemoryContext,
  ManageMemoryToolInput,
  MemoryInspectionQueryRequest,
  MemoryPanelSnapshot,
  RecallMemoryToolRequest,
} from "./memory.js";
import { expectTypeOf, it } from "vitest";

it("preserves package-owned memory transport through the capability facade", () => {
  expectTypeOf<ManageMemoryToolInput>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").ManageMemoryToolInput
  >();
  expectTypeOf<RecallMemoryToolRequest>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").RecallMemoryToolRequest
  >();
  expectTypeOf<AutomaticMemoryContext>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").AutomaticMemoryContext
  >();
  expectTypeOf<MemoryInspectionQueryRequest>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryInspectionQueryRequest
  >();
  expectTypeOf<MemoryPanelSnapshot>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryPanelSnapshot
  >();
});

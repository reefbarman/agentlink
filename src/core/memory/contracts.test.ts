import type {
  MemoryArchiveV1,
  MemoryHealthSnapshot,
  MemoryRecord,
  MemoryRecordDetail,
} from "./contracts.js";
import { expectTypeOf, it } from "vitest";

it("preserves package-owned memory DTOs through the core contracts facade", () => {
  expectTypeOf<MemoryRecord>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryRecord
  >();
  expectTypeOf<MemoryRecordDetail>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryRecordDetail
  >();
  expectTypeOf<MemoryArchiveV1>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryArchiveV1
  >();
  expectTypeOf<MemoryHealthSnapshot>().toEqualTypeOf<
    import("@agentlink/protocol/autonomous-memory").MemoryHealthSnapshot
  >();
});

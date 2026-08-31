import type {
  RetrievalDeleteScopeOutcome,
  RetrievalDeleteScopeRequest,
  RetrievalDeleteSourceOutcome,
  RetrievalDeleteSourceRequest,
} from "./retrievalDeletion.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins retrieval deletion contracts", () => {
  expectTypeOf<RetrievalDeleteSourceRequest>().toEqualTypeOf<{
    sourceId: string;
    expectedRevisionId?: string;
  }>();
  expectTypeOf<RetrievalDeleteSourceOutcome>().toEqualTypeOf<{
    sourceId: string;
    status: "deleted" | "stale_source" | "not_found";
    recordsRemoved: number;
  }>();
  expectTypeOf<RetrievalDeleteScopeRequest>().toEqualTypeOf<{
    namespaces?: import("./retrievalRecords.js").RetrievalNamespace[];
    metadata?: Record<string, string | number | boolean | null>;
    sourceIdPrefix?: string;
  }>();
  expectTypeOf<RetrievalDeleteScopeOutcome>().toEqualTypeOf<{
    sourcesDeleted: number;
    recordsRemoved: number;
  }>();
});

it("keeps retrieval deletion requests and outcomes serializable across surfaces", () => {
  const value: {
    sourceRequest: RetrievalDeleteSourceRequest;
    sourceOutcome: RetrievalDeleteSourceOutcome;
    scopeRequest: RetrievalDeleteScopeRequest;
    scopeOutcome: RetrievalDeleteScopeOutcome;
  } = {
    sourceRequest: {
      sourceId: "source-1",
      expectedRevisionId: "revision-1",
    },
    sourceOutcome: {
      sourceId: "source-1",
      status: "deleted",
      recordsRemoved: 3,
    },
    scopeRequest: {
      namespaces: ["code", "session"],
      metadata: { workspace: "agentlink", active: true },
      sourceIdPrefix: "source:",
    },
    scopeOutcome: {
      sourcesDeleted: 2,
      recordsRemoved: 5,
    },
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  classifySemanticReadiness,
  getSemanticReadinessMessage,
  type SemanticReadinessReason,
  type SemanticReadinessSnapshot,
} from "./semanticReadiness.js";

const ready: SemanticReadinessSnapshot = {
  semanticEnabled: true,
  hasWorkspace: true,
  retrievalStoreAvailable: true,
  hasIndex: true,
};

describe("semantic readiness protocol compatibility shim", () => {
  it("preserves the legacy type, classification, and presentation contracts", () => {
    expectTypeOf<SemanticReadinessReason>().toEqualTypeOf<
      | "missing_embeddings_auth"
      | "missing_index"
      | "store_unavailable"
      | "no_workspace"
      | "disabled"
      | "generic_error"
    >();
    expect(classifySemanticReadiness(ready)).toBe("ready");
    expect(
      classifySemanticReadiness({ ...ready, retrievalStoreAvailable: false }),
    ).toBe("store_unavailable");
    expect(getSemanticReadinessMessage("store_unavailable")).toBe(
      "The retrieval store is unavailable.",
    );
    expect(getSemanticReadinessMessage("missing_embeddings_auth")).toContain(
      "Lexical indexing and search remain available",
    );
  });
});

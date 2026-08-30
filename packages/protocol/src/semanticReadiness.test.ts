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

describe("semantic readiness protocol", () => {
  it("keeps the serialized reason union stable", () => {
    expectTypeOf<SemanticReadinessReason>().toEqualTypeOf<
      | "missing_embeddings_auth"
      | "missing_index"
      | "store_unavailable"
      | "no_workspace"
      | "disabled"
      | "generic_error"
    >();
  });

  it.each([
    [{ ...ready, semanticEnabled: false }, "disabled"],
    [{ ...ready, hasWorkspace: false }, "no_workspace"],
    [{ ...ready, retrievalStoreAvailable: false }, "store_unavailable"],
    [{ ...ready, hasIndex: false }, "missing_index"],
    [ready, "ready"],
  ] as const)("classifies readiness precedence", (snapshot, expected) => {
    expect(classifySemanticReadiness(snapshot)).toBe(expected);
  });

  it.each([
    ["disabled", "Semantic search is not enabled."],
    ["missing_embeddings_auth", "Lexical indexing and search remain available"],
    ["no_workspace", "No workspace folder open."],
    ["store_unavailable", "The retrieval store is unavailable."],
    ["missing_index", "No codebase index found for this workspace."],
    ["generic_error", "Semantic search is not ready."],
  ] as const)("provides bounded copy for %s", (reason, expected) => {
    expect(getSemanticReadinessMessage(reason)).toContain(expected);
  });
});

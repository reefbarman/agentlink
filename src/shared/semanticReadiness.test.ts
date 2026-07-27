import {
  classifySemanticReadiness,
  getSemanticReadinessMessage,
  type SemanticReadinessSnapshot,
} from "./semanticReadiness.js";
import { describe, expect, it } from "vitest";

const ready: SemanticReadinessSnapshot = {
  semanticEnabled: true,
  hasWorkspace: true,
  retrievalStoreAvailable: true,
  hasIndex: true,
};

describe("semantic readiness", () => {
  it.each([
    [{ ...ready, semanticEnabled: false }, "disabled"],
    [{ ...ready, hasWorkspace: false }, "no_workspace"],
    [{ ...ready, retrievalStoreAvailable: false }, "store_unavailable"],
    [{ ...ready, hasIndex: false }, "missing_index"],
    [ready, "ready"],
  ] as const)("classifies readiness precedence", (snapshot, expected) => {
    expect(classifySemanticReadiness(snapshot)).toBe(expected);
  });

  it("keeps shared store-unavailable messaging provider-neutral", () => {
    expect(getSemanticReadinessMessage("store_unavailable")).toBe(
      "The retrieval store is unavailable.",
    );
  });

  it("describes missing embedding auth as optional vector degradation", () => {
    expect(getSemanticReadinessMessage("missing_embeddings_auth")).toContain(
      "Lexical indexing and search remain available",
    );
  });
});

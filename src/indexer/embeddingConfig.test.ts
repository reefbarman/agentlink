import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  createEmbeddingRequest,
} from "./embeddingConfig.js";
import { describe, expect, it } from "vitest";

describe("embedding configuration", () => {
  it("pins the model and vector dimension used by existing indexes", () => {
    expect({ model: EMBEDDING_MODEL, dimension: EMBEDDING_DIM }).toEqual({
      model: "text-embedding-3-small",
      dimension: 1536,
    });
  });

  it.each([
    ["query", "query"],
    ["index batch", ["first", "second"]],
  ])("preserves the %s request body", (_label, input) => {
    expect(createEmbeddingRequest(input)).toEqual({
      model: "text-embedding-3-small",
      input,
    });
  });
});

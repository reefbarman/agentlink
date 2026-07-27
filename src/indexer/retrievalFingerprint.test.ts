import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./embeddingConfig.js";
import {
  MAX_CODE_INDEX_EMBEDDING_CHARS,
  createCodeIndexFingerprint,
} from "./retrievalFingerprint.js";
import { describe, expect, it } from "vitest";

import { canonicalizeRetrievalFingerprint } from "../core/retrieval/fingerprint.js";

describe("code index retrieval fingerprint", () => {
  it("captures the complete current embedding and schema identity", () => {
    expect(createCodeIndexFingerprint("standard")).toMatchObject({
      schemaVersion: 1,
      recordSchemaVersion: 1,
      relationSchemaVersion: 2,
      chunker: {
        id: "agentlink-code-index-chunker",
        version: 2,
        configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      embedding: {
        provider: "openai",
        model: EMBEDDING_MODEL,
        endpointContract: "openai-embeddings-v1",
        dimensions: EMBEDDING_DIM,
      },
    });
  });

  it("is deterministic and changes when effective chunk configuration changes", () => {
    const first = createCodeIndexFingerprint("standard");
    const second = createCodeIndexFingerprint("standard");
    const fine = createCodeIndexFingerprint("fine");

    expect(canonicalizeRetrievalFingerprint(first)).toBe(
      canonicalizeRetrievalFingerprint(second),
    );
    expect(first.chunker.configurationHash).not.toBe(
      fine.chunker.configurationHash,
    );
    expect(MAX_CODE_INDEX_EMBEDDING_CHARS).toBe(20_000);
  });

  it("does not include credential availability in persisted identity", () => {
    expect(
      canonicalizeRetrievalFingerprint(createCodeIndexFingerprint("standard")),
    ).not.toMatch(/credential|token|auth|available/i);
  });
});

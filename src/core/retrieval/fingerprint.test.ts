import {
  canonicalizeRetrievalFingerprint,
  classifyRetrievalFingerprint,
  parseRetrievalFingerprint,
} from "./fingerprint.js";
import { describe, expect, it } from "vitest";

import type { RetrievalFingerprint } from "@agentlink/protocol/retrieval-fingerprint";

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "agentlink-code-index-chunker",
    version: 2,
    configurationHash: "chunk-config-v2",
  },
  embedding: {
    provider: "openai-compatible",
    model: "text-embedding-3-small",
    endpointContract: "openai-embeddings-v1",
    dimensions: 1536,
  },
};

describe("retrieval fingerprint", () => {
  it("canonicalizes and parses every rebuild-affecting field", () => {
    expect(
      parseRetrievalFingerprint(
        JSON.parse(canonicalizeRetrievalFingerprint(fingerprint)),
      ),
    ).toEqual(fingerprint);
  });

  it("distinguishes initialization from a compatible fingerprint", () => {
    expect(classifyRetrievalFingerprint(null, fingerprint)).toBe("initialize");
    expect(
      classifyRetrievalFingerprint(
        structuredClone(fingerprint),
        structuredClone(fingerprint),
      ),
    ).toBe("compatible");
  });

  it.each<[string, RetrievalFingerprint]>([
    ["schema version", { ...fingerprint, schemaVersion: 2 }],
    ["record schema version", { ...fingerprint, recordSchemaVersion: 2 }],
    ["relation schema version", { ...fingerprint, relationSchemaVersion: 2 }],
    [
      "chunker ID",
      { ...fingerprint, chunker: { ...fingerprint.chunker, id: "other" } },
    ],
    [
      "chunker version",
      { ...fingerprint, chunker: { ...fingerprint.chunker, version: 3 } },
    ],
    [
      "chunker configuration",
      {
        ...fingerprint,
        chunker: { ...fingerprint.chunker, configurationHash: "other" },
      },
    ],
    [
      "embedding provider",
      {
        ...fingerprint,
        embedding: { ...fingerprint.embedding!, provider: "other" },
      },
    ],
    [
      "embedding model",
      {
        ...fingerprint,
        embedding: { ...fingerprint.embedding!, model: "other" },
      },
    ],
    [
      "embedding endpoint contract",
      {
        ...fingerprint,
        embedding: {
          ...fingerprint.embedding!,
          endpointContract: "other",
        },
      },
    ],
    [
      "embedding dimensions",
      {
        ...fingerprint,
        embedding: { ...fingerprint.embedding!, dimensions: 384 },
      },
    ],
    ["embedding configuration", { ...fingerprint, embedding: null }],
  ])("requires rebuild when %s changes", (_, changed) => {
    expect(classifyRetrievalFingerprint(fingerprint, changed)).toBe(
      "rebuild_required",
    );
    expect(classifyRetrievalFingerprint(changed, fingerprint)).toBe(
      "rebuild_required",
    );
  });
});

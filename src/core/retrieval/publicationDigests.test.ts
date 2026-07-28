import {
  createRetrievalRecordContentDigest,
  createRetrievalRecordIdDigest,
  createRetrievalSourcePayloadDigest,
} from "./publicationDigests.js";
import { describe, expect, it } from "vitest";

describe("retrieval publication digests", () => {
  it("is deterministic regardless of record ID order", () => {
    expect(createRetrievalRecordIdDigest(["chunk:b", "chunk:a"])).toBe(
      createRetrievalRecordIdDigest(["chunk:a", "chunk:b"]),
    );
  });

  it("rejects duplicate or empty record IDs", () => {
    expect(() => createRetrievalRecordIdDigest(["chunk:a", "chunk:a"])).toThrow(
      "unique non-empty IDs",
    );
    expect(() => createRetrievalRecordIdDigest([""])).toThrow(
      "unique non-empty IDs",
    );
  });

  it("authenticates record content independently of record order", () => {
    const records = [
      { id: "chunk:b", content: "second", metadata: { z: 1, a: true } },
      { id: "chunk:a", content: "first", metadata: {} },
    ];

    expect(createRetrievalRecordContentDigest(records)).toBe(
      createRetrievalRecordContentDigest([...records].reverse()),
    );
    expect(
      createRetrievalRecordContentDigest([
        records[0],
        { ...records[1], content: "changed" },
      ]),
    ).not.toBe(createRetrievalRecordContentDigest(records));
  });

  it("canonicalizes source metadata keys without hiding content changes", () => {
    const source = {
      id: "source:1",
      namespace: "code" as const,
      kind: "file" as const,
      revision: {
        id: "revision:1",
        contentHash: "hash:1",
        observedAt: "2026-07-28T00:00:00.000Z",
      },
      path: "src/index.ts",
      content: "export const value = 1;",
      metadata: { language: "typescript", exported: true },
    };
    const reordered = {
      ...source,
      metadata: { exported: true, language: "typescript" },
    };

    expect(createRetrievalSourcePayloadDigest(source)).toBe(
      createRetrievalSourcePayloadDigest(reordered),
    );
    expect(
      createRetrievalSourcePayloadDigest({
        ...source,
        content: "export const value = 2;",
      }),
    ).not.toBe(createRetrievalSourcePayloadDigest(source));
  });
});

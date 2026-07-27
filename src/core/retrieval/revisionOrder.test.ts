import {
  compareRetrievalSourceRevisions,
  validateRetrievalSourceRevision,
} from "./revisionOrder.js";
import { describe, expect, it } from "vitest";

import type { RetrievalSourceRevision } from "./contracts.js";

function revision(
  id: string,
  observedAt: string,
  contentHash = `hash:${id}`,
): RetrievalSourceRevision {
  return { id, contentHash, observedAt };
}

describe("retrieval revision order", () => {
  it("orders timestamp instants before stable identity tie-breaks", () => {
    expect(
      compareRetrievalSourceRevisions(
        revision("z", "2026-07-25T00:30:00.000Z"),
        revision("a", "2026-07-25T01:00:00.000Z"),
      ),
    ).toBeLessThan(0);
    expect(
      compareRetrievalSourceRevisions(
        revision("a", "2026-07-25T01:00:00.000Z"),
        revision("b", "2026-07-25T02:00:00.000+01:00"),
      ),
    ).toBeLessThan(0);
    expect(
      compareRetrievalSourceRevisions(
        revision("same", "2026-07-25T01:00:00.000Z", "hash:a"),
        revision("same", "2026-07-25T01:00:00.000Z", "hash:b"),
      ),
    ).toBeLessThan(0);
  });

  it("is antisymmetric and treats identical revisions as equal", () => {
    const left = revision("a", "2026-07-25T01:00:00.000Z");
    const right = revision("b", "2026-07-25T01:00:00.000Z");
    expect(compareRetrievalSourceRevisions(left, right)).toBe(
      -compareRetrievalSourceRevisions(right, left),
    );
    expect(compareRetrievalSourceRevisions(left, { ...left })).toBe(0);
  });

  it("rejects invalid timestamps and incomplete identities", () => {
    expect(() =>
      validateRetrievalSourceRevision(revision("revision", "not-a-date")),
    ).toThrow("Invalid source revision observedAt");
    expect(() =>
      validateRetrievalSourceRevision({
        id: "",
        contentHash: "hash",
        observedAt: "2026-07-25T00:00:00.000Z",
      }),
    ).toThrow("identity and content hash are required");
  });
});

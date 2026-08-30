import type { DiffSnapshot, DiffSnapshotPreview } from "./diffSnapshot.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("diff snapshot protocol", () => {
  it("pins the complete snapshot and preview DTO family", () => {
    expectTypeOf<DiffSnapshot>().toEqualTypeOf<{
      requestId: string;
      filePath: string;
      operation: "create" | "modify";
      originalContent: string;
      proposedContent: string;
      outsideWorkspace: boolean;
      createdAt: number;
    }>();
    expectTypeOf<DiffSnapshotPreview>().toEqualTypeOf<{
      requestId: string;
      filePath: string;
      operation: "create" | "modify";
      originalPreview: string;
      proposedPreview: string;
      outsideWorkspace: boolean;
      createdAt: number;
    }>();
  });

  it("keeps both DTOs serializable across host and browser surfaces", () => {
    const snapshot: DiffSnapshot = {
      requestId: "request-1",
      filePath: "src/example.ts",
      operation: "modify",
      originalContent: "before",
      proposedContent: "after",
      outsideWorkspace: false,
      createdAt: 1,
    };
    const preview: DiffSnapshotPreview = {
      requestId: snapshot.requestId,
      filePath: snapshot.filePath,
      operation: snapshot.operation,
      originalPreview: snapshot.originalContent,
      proposedPreview: snapshot.proposedContent,
      outsideWorkspace: snapshot.outsideWorkspace,
      createdAt: snapshot.createdAt,
    };

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
  });
});

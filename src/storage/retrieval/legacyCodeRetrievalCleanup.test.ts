import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  LEGACY_CODE_RETRIEVAL_CLEANUP_MARKER,
  cleanupLegacyCodeRetrievalStore,
} from "./legacyCodeRetrievalCleanup.js";
import { afterEach, describe, expect, it } from "vitest";

import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import type { RetrievalPublicationRequest } from "../../core/retrieval/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("legacy code retrieval cleanup", () => {
  it("removes only legacy code rows and records an idempotent marker", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-legacy-code-cleanup-"),
    );
    roots.push(root);
    const repository = new LanceDbRetrievalRepository({
      root,
      embeddingDimensions: 3,
    });
    await repository.migrate({
      schemaVersion: 1,
      recordSchemaVersion: 1,
      relationSchemaVersion: 1,
      chunker: { id: "cleanup", version: 1, configurationHash: "cleanup-v1" },
      embedding: null,
    });
    await publish(
      repository,
      publication("code:workspace:test:src/index.ts", "code"),
    );
    await publish(repository, publication("skill:catalog:test", "custom"));
    await repository.close();

    await expect(cleanupLegacyCodeRetrievalStore(root)).resolves.toMatchObject({
      status: "cleaned",
      rowsRemoved: 3,
    });
    await expect(
      fs.readFile(
        path.join(root, LEGACY_CODE_RETRIEVAL_CLEANUP_MARKER),
        "utf8",
      ),
    ).resolves.toBe("1\n");

    const reopened = new LanceDbRetrievalRepository({
      root,
      embeddingDimensions: 3,
    });
    try {
      expect(
        await reopened.inspectSource("code:workspace:test:src/index.ts"),
      ).toBeNull();
      expect(await reopened.inspectSource("skill:catalog:test")).toMatchObject({
        source: { namespace: "custom" },
      });
    } finally {
      await reopened.close();
    }

    await expect(cleanupLegacyCodeRetrievalStore(root)).resolves.toEqual({
      status: "already_clean",
      rowsRemoved: 0,
    });
  });

  it("does not create a missing legacy store", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-legacy-code-missing-"),
    );
    roots.push(parent);
    const root = path.join(parent, "missing");

    await expect(cleanupLegacyCodeRetrievalStore(root)).resolves.toEqual({
      status: "missing",
      rowsRemoved: 0,
    });
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function publish(
  repository: LanceDbRetrievalRepository,
  request: RetrievalPublicationRequest,
): Promise<void> {
  await repository.preparePublication(request);
  await expect(
    repository.commitPublication(request.publicationId),
  ).resolves.toMatchObject({
    status: "published",
  });
}

function publication(
  sourceId: string,
  namespace: "code" | "custom",
): RetrievalPublicationRequest {
  const revisionId = `revision:${sourceId}`;
  const generation = `generation:${sourceId}`;
  const chunkId = `chunk:${sourceId}`;
  const relationId = `relation:${sourceId}`;
  return {
    publicationId: `publication:${sourceId}`,
    generation,
    source: {
      id: sourceId,
      namespace,
      kind: namespace === "code" ? "file" : "custom",
      revision: {
        id: revisionId,
        contentHash: revisionId,
        observedAt: "2026-07-27T00:00:00.000Z",
      },
      content: `${namespace} retrieval record`,
      metadata: {},
    },
    chunks: [
      {
        id: chunkId,
        sourceId,
        revisionId,
        generation,
        content: `${namespace} retrieval record`,
        embedding: null,
        metadata: {},
      },
    ],
    relations: [
      {
        id: relationId,
        sourceId,
        revisionId,
        generation,
        fromId: chunkId,
        toId: sourceId,
        kind: "contains",
        metadata: {},
      },
    ],
    expectedChunkIds: [chunkId],
    expectedRelationIds: [relationId],
  };
}

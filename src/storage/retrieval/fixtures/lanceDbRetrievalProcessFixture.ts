import * as fs from "node:fs/promises";

import type {
  RetrievalFingerprint,
  RetrievalPublicationRequest,
} from "../../../core/retrieval/contracts.js";

import { LanceDbRetrievalRepository } from "../LanceDbRetrievalRepository.js";

const root = requireEnvironment("RETRIEVAL_FIXTURE_ROOT");
const role = requireEnvironment("RETRIEVAL_FIXTURE_ROLE");
const repository = new LanceDbRetrievalRepository({
  root,
  embeddingDimensions: 3,
});

const fingerprint: RetrievalFingerprint = {
  schemaVersion: 1,
  recordSchemaVersion: 1,
  relationSchemaVersion: 1,
  chunker: {
    id: "lancedb-process-fixture",
    version: 1,
    configurationHash: "lancedb-process-fixture-v1",
  },
  embedding: {
    provider: "fixture",
    model: "fixture-embedding",
    endpointContract: "fixture-v1",
    dimensions: 3,
  },
};

void run().catch((error) => {
  send({
    type: "error",
    message:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});

async function run(): Promise<void> {
  if (role === "reader") {
    await repository.health();
    send({ type: "ready", role });
    process.on("message", (message) => {
      void handleReaderMessage(message).catch((error) => {
        send({
          type: "error",
          message:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
      });
    });
    return;
  }

  await repository.migrate(fingerprint);
  if (role === "writer") {
    const request = publication("writer", "revision-writer");
    await repository.preparePublication(request);
    const outcome = await repository.commitPublication(request.publicationId);
    send({ type: "committed", outcome });
    await repository.close();
    return;
  }

  if (role === "crash-owner") {
    const request = publication("abandoned", "revision-abandoned");
    await repository.preparePublication(request);
    await fs.mkdir(`${root}.lock`);
    send({ type: "prepared_locked", publicationId: request.publicationId });
    setInterval(() => undefined, 1_000);
    return;
  }

  throw new Error(`Unknown retrieval fixture role: ${role}`);
}

async function handleReaderMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "query") {
    const result = await repository.query({
      text: "cross process committed retrieval",
      mode: "lexical",
      limit: 10,
    });
    send({
      type: "query_result",
      chunkIds: result.candidates.map((candidate) => candidate.chunk.id),
    });
    return;
  }
  if (message.type === "repair") {
    const outcome = await repository.repair();
    const health = await repository.health();
    const query = await repository.query({
      text: "abandoned",
      mode: "lexical",
      limit: 10,
    });
    send({
      type: "repair_result",
      outcome,
      health,
      abandonedChunkIds: query.candidates.map(
        (candidate) => candidate.chunk.id,
      ),
    });
    return;
  }
  if (message.type === "close") {
    await repository.close();
    send({ type: "closed" });
    process.exit(0);
  }
}

function publication(
  publicationId: string,
  revisionId: string,
): RetrievalPublicationRequest {
  const sourceId = `source:${publicationId}`;
  const generation = `generation:${publicationId}`;
  const content =
    publicationId === "writer"
      ? "cross process committed retrieval"
      : "abandoned retrieval";
  const chunkId = `chunk:${publicationId}`;
  return {
    publicationId,
    generation,
    source: {
      id: sourceId,
      namespace: "code",
      kind: "file",
      revision: {
        id: revisionId,
        contentHash: `hash:${revisionId}`,
        observedAt: "2026-07-25T00:00:00.000Z",
      },
      path: `src/${publicationId}.ts`,
      content,
      metadata: {},
    },
    chunks: [
      {
        id: chunkId,
        sourceId,
        revisionId,
        generation,
        content,
        embedding: [1, 0, 0],
        location: { path: `src/${publicationId}.ts`, startLine: 1, endLine: 1 },
        metadata: {},
      },
    ],
    relations: [],
    expectedChunkIds: [chunkId],
    expectedRelationIds: [],
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function send(message: object): void {
  process.send?.(message);
}

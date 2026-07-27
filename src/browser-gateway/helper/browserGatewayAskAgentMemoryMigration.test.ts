import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
  BrowserGatewayAskAgentMemoryMigrationError,
  migrateBrowserGatewayAskAgentMemory,
} from "./browserGatewayAskAgentMemoryMigration.js";
import { afterEach, describe, expect, it } from "vitest";

import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { InMemoryRetrievalRepository } from "../../core/retrieval/InMemoryRetrievalRepository.js";
import { createHash } from "node:crypto";

const tempDirectories: string[] = [];

function legacySnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    updatedAt: 2_000,
    sessions: [
      {
        sessionId: "browser-session-one",
        title: "Legacy Browser session",
        createdAt: 1_000,
        lastActiveAt: 2_000,
        messageCount: 4,
        sourceRevision: "browser-revision-one",
        summary: "The legacy Browser session discussed shared retrieval.",
        topics: ["retrieval"],
        decisions: ["Use one typed session service."],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 2_000,
      },
    ],
    chunks: [
      {
        id: "browser-session-one:2-3",
        sessionId: "browser-session-one",
        sourceMessageIds: ["message-user", "message-assistant"],
        startMessageIndex: 2,
        endMessageIndex: 3,
        sourceRevision: "browser-revision-one",
        summary: "The selected turn defined transcript range preservation.",
        keywords: ["transcript", "range"],
        entities: ["DerivedSessionRetrievalService"],
        createdAt: 1_500,
        updatedAt: 2_000,
      },
    ],
    ...overrides,
  };
}

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-browser-memory-import-"),
  );
  tempDirectories.push(directory);
  const filePath = path.join(directory, "browser-memory.json");
  const repository = new InMemoryRetrievalRepository({
    embeddingConfigured: false,
  });
  let publication = 0;
  const service = new DerivedSessionRetrievalService(repository, {
    createPublicationId: () => `migration-publication-${++publication}`,
  });
  return { directory, filePath, repository, service };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Browser Ask Agent memory migration", () => {
  it("imports valid JSON atomically while preserving source bytes and provenance", async () => {
    const { filePath, service } = await fixture();
    const source = Buffer.from(
      JSON.stringify(legacySnapshot(), null, 2) + "\n",
    );
    await fs.writeFile(filePath, source);

    const result = await migrateBrowserGatewayAskAgentMemory({
      service,
      filePath,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "imported",
      sessionCount: 1,
      chunkCount: 1,
      checkpoint: {
        sourceKey: BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
        sourceRevision: createHash("sha256").update(source).digest("hex"),
        status: "complete",
        importedSessionIds: ["browser-session-one"],
        snapshot: { sourceCount: 0, chunkCount: 0 },
      },
    });
    expect(await fs.readFile(filePath)).toEqual(source);
    await expect(
      service.recall({
        query: "transcript range preservation",
        scopes: [{ kind: "global", id: "agentlink-user" }],
        surfaces: ["browser-ask-agent"],
        minimumScore: 0,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "chunk",
          sessionId: "browser-session-one",
          chunkId: "browser-session-one:2-3",
          sourceRevision: "browser-revision-one",
          sourceMessageIds: ["message-user", "message-assistant"],
          startMessageIndex: 2,
          endMessageIndex: 3,
        }),
      ]),
    );
  });

  it("records missing distinctly and imports when the source later appears", async () => {
    const { filePath, service } = await fixture();

    const missing = await migrateBrowserGatewayAskAgentMemory({
      service,
      filePath,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });
    expect(missing).toMatchObject({
      status: "missing",
      checkpoint: {
        sourceRevision: "missing",
        status: "missing",
      },
    });
    await expect(service.inspect()).resolves.toMatchObject({ sessionCount: 0 });

    await fs.writeFile(filePath, JSON.stringify(legacySnapshot()) + "\n");
    const imported = await migrateBrowserGatewayAskAgentMemory({
      service,
      filePath,
      now: () => new Date("2026-07-26T00:01:00.000Z"),
    });
    expect(imported.status).toBe("imported");
    await expect(service.inspect()).resolves.toMatchObject({ sessionCount: 1 });
  });

  it("keeps a completed rollback source inert even if it later changes", async () => {
    const { filePath, service } = await fixture();
    const original = Buffer.from(JSON.stringify(legacySnapshot()) + "\n");
    await fs.writeFile(filePath, original);
    const imported = await migrateBrowserGatewayAskAgentMemory({
      service,
      filePath,
    });
    expect(imported.status).toBe("imported");

    const changed = Buffer.from("{now-corrupt\n");
    await fs.writeFile(filePath, changed);
    const second = await migrateBrowserGatewayAskAgentMemory({
      service,
      filePath,
    });

    expect(second).toMatchObject({
      status: "already-complete",
      sessionCount: 1,
    });
    expect(await fs.readFile(filePath)).toEqual(changed);
    await expect(service.inspect()).resolves.toMatchObject({
      sessionCount: 1,
      sessions: [
        expect.objectContaining({
          summary: "The legacy Browser session discussed shared retrieval.",
        }),
      ],
    });
  });

  it.each([
    {
      name: "corrupt JSON",
      content: "{not-json\n",
      code: "corrupt-json",
    },
    {
      name: "unknown schema",
      content: JSON.stringify(legacySnapshot({ schemaVersion: 99 })),
      code: "unknown-schema",
    },
    {
      name: "orphan chunk",
      content: JSON.stringify(
        legacySnapshot({
          chunks: [
            {
              ...legacySnapshot().chunks[0],
              sessionId: "missing-session",
            },
          ],
        }),
      ),
      code: "invalid-shape",
    },
  ])(
    "fails closed for $name without publishing sessions",
    async ({ content, code }) => {
      const { filePath, service } = await fixture();
      await fs.writeFile(filePath, content);

      await expect(
        migrateBrowserGatewayAskAgentMemory({
          service,
          filePath,
          now: () => new Date("2026-07-26T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({
        code,
      } satisfies Partial<BrowserGatewayAskAgentMemoryMigrationError>);
      await expect(service.inspect()).resolves.toMatchObject({
        sessionCount: 0,
      });
      await expect(
        service.getImportCheckpoint(
          BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
        ),
      ).resolves.toMatchObject({
        status: "failed",
        error: { code },
      });
    },
  );

  it("preserves historical chunk revisions that predate the rolling session summary", async () => {
    const { filePath, service } = await fixture();
    await fs.writeFile(
      filePath,
      JSON.stringify(
        legacySnapshot({
          chunks: [
            {
              ...legacySnapshot().chunks[0],
              sourceRevision: "older-turn-revision",
            },
          ],
        }),
      ),
    );

    await expect(
      migrateBrowserGatewayAskAgentMemory({ service, filePath }),
    ).resolves.toMatchObject({ status: "imported" });
    await expect(
      service.recall({
        query: "transcript range preservation",
        scopes: [{ kind: "global", id: "agentlink-user" }],
        minimumScore: 0,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "chunk",
          chunkId: "browser-session-one:2-3",
          sourceRevision: "older-turn-revision",
        }),
      ]),
    );
  });

  it("persists typed import failure when a structurally valid source contains sensitive summaries", async () => {
    const { filePath, service } = await fixture();
    await fs.writeFile(
      filePath,
      JSON.stringify(
        legacySnapshot({
          sessions: [
            {
              ...legacySnapshot().sessions[0],
              summary: "Use token ghp_abcdefghijklmnopqrstuvwxyz1234567890.",
            },
          ],
        }),
      ),
    );

    await expect(
      migrateBrowserGatewayAskAgentMemory({ service, filePath }),
    ).rejects.toThrow("contains sensitive content");
    await expect(service.inspect()).resolves.toMatchObject({ sessionCount: 0 });
    await expect(
      service.getImportCheckpoint(
        BROWSER_GATEWAY_ASK_AGENT_MEMORY_IMPORT_SOURCE_KEY,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "import-failed" },
    });
  });
});

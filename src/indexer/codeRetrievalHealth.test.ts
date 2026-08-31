import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RETRIEVAL_STORE_MARKER } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import type { RetrievalHealthSnapshot } from "@agentlink/protocol/retrieval-health";
import { createCodeRetrievalHealthProvider } from "./codeRetrievalHealth.js";
import { getCodeRetrievalStoreRoot } from "./codeRetrievalIdentity.js";

const { repositoryClose, repositoryHealth, repositoryRoots } = vi.hoisted(
  () => ({
    repositoryClose: vi.fn(),
    repositoryHealth: new Map<string, RetrievalHealthSnapshot | Error>(),
    repositoryRoots: [] as string[],
  }),
);

vi.mock("../storage/retrieval/LanceDbRetrievalRepository.js", () => ({
  RETRIEVAL_STORE_MARKER: ".agentlink-retrieval-store",
  LanceDbRetrievalRepository: class {
    readonly root: string;

    constructor(options: { root: string }) {
      this.root = options.root;
      repositoryRoots.push(options.root);
    }

    async health(): Promise<RetrievalHealthSnapshot> {
      const result = repositoryHealth.get(this.root);
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`Missing health fixture for ${this.root}`);
      return result;
    }

    async close(): Promise<void> {
      repositoryClose(this.root);
    }
  },
}));

describe("createCodeRetrievalHealthProvider", () => {
  let tempRoot: string;
  let globalStoragePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-health-"));
    globalStoragePath = path.join(tempRoot, "global-storage");
    repositoryClose.mockReset();
    repositoryHealth.clear();
    repositoryRoots.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("aggregates health across reusable per-project stores", async () => {
    const apiRoot = path.join(tempRoot, "api");
    const webRoot = path.join(tempRoot, "web");
    fs.mkdirSync(apiRoot);
    fs.mkdirSync(webRoot);
    const apiStore = getCodeRetrievalStoreRoot(globalStoragePath, apiRoot);
    const webStore = getCodeRetrievalStoreRoot(globalStoragePath, webRoot);
    initializeStore(apiStore);
    initializeStore(webStore);
    repositoryHealth.set(
      apiStore,
      health({ sourceCount: 2, chunkCount: 5, relationCount: 1 }),
    );
    repositoryHealth.set(
      webStore,
      health({
        status: "degraded",
        vector: "unavailable",
        embeddingCredentials: "missing",
        reason: "missing_embeddings_auth",
        reasons: ["missing_embeddings_auth"],
        sourceCount: 3,
        chunkCount: 7,
        relationCount: 4,
        staleSourceCount: 1,
      }),
    );

    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: true,
      getWorkspaceRoots: () => [apiRoot, webRoot],
    }).health();

    expect(snapshot).toMatchObject({
      status: "degraded",
      lexical: "ready",
      scalar: "ready",
      vector: "unavailable",
      structural: "ready",
      embeddingCredentials: "missing",
      reason: "missing_embeddings_auth",
      reasons: ["missing_embeddings_auth"],
      fingerprintDisposition: "compatible",
      sourceCount: 5,
      chunkCount: 12,
      relationCount: 5,
      staleSourceCount: 1,
    });
    expect(new Set(repositoryRoots)).toEqual(new Set([apiStore, webStore]));
    expect(repositoryClose).toHaveBeenCalledTimes(2);
  });

  it("reports a missing project store as degraded without claiming global capability readiness", async () => {
    const indexedRoot = path.join(tempRoot, "indexed");
    const missingRoot = path.join(tempRoot, "missing");
    fs.mkdirSync(indexedRoot);
    fs.mkdirSync(missingRoot);
    const indexedStore = getCodeRetrievalStoreRoot(
      globalStoragePath,
      indexedRoot,
    );
    initializeStore(indexedStore);
    repositoryHealth.set(
      indexedStore,
      health({ sourceCount: 2, chunkCount: 4 }),
    );

    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: true,
      getWorkspaceRoots: () => [indexedRoot, missingRoot],
    }).health();

    expect(snapshot).toMatchObject({
      status: "degraded",
      lexical: "unavailable",
      scalar: "unavailable",
      structural: "unavailable",
      reason: "missing_index",
      reasons: ["missing_index"],
      fingerprintDisposition: "initialize",
      sourceCount: 2,
      chunkCount: 4,
    });
    expect(repositoryRoots).toEqual([indexedStore]);
    expect(repositoryClose).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when every project store is missing", async () => {
    const firstRoot = path.join(tempRoot, "first");
    const secondRoot = path.join(tempRoot, "second");
    fs.mkdirSync(firstRoot);
    fs.mkdirSync(secondRoot);

    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: true,
      getWorkspaceRoots: () => [firstRoot, secondRoot],
    }).health();

    expect(snapshot).toMatchObject({
      status: "unavailable",
      lexical: "unavailable",
      scalar: "unavailable",
      vector: "not_configured",
      structural: "unavailable",
      reason: "missing_index",
      sourceCount: 0,
      chunkCount: 0,
    });
    expect(repositoryRoots).toEqual([]);
  });

  it("reports no workspace without opening a repository", async () => {
    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: true,
      getWorkspaceRoots: () => [],
    }).health();

    expect(snapshot).toMatchObject({
      status: "unavailable",
      lexical: "unavailable",
      scalar: "unavailable",
      vector: "not_configured",
      structural: "unavailable",
      reason: "no_workspace",
      reasons: ["no_workspace"],
      sourceCount: 0,
      chunkCount: 0,
      relationCount: 0,
    });
    expect(repositoryRoots).toEqual([]);
  });

  it("reports disabled without opening a repository", async () => {
    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: false,
      getWorkspaceRoots: () => [tempRoot],
    }).health();

    expect(snapshot).toMatchObject({
      status: "disabled",
      reason: "disabled",
      reasons: ["disabled"],
    });
    expect(repositoryRoots).toEqual([]);
  });

  it("does not open or initialize an unmarked store directory", async () => {
    const workspaceRoot = path.join(tempRoot, "incomplete");
    fs.mkdirSync(workspaceRoot);
    const storeRoot = getCodeRetrievalStoreRoot(
      globalStoragePath,
      workspaceRoot,
    );
    fs.mkdirSync(storeRoot, { recursive: true });

    const snapshot = await createCodeRetrievalHealthProvider({
      globalStoragePath,
      enabled: true,
      getWorkspaceRoots: () => [workspaceRoot],
    }).health();

    expect(snapshot).toMatchObject({
      status: "unavailable",
      reason: "missing_index",
    });
    expect(repositoryRoots).toEqual([]);
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });
});

function initializeStore(storeRoot: string): void {
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, RETRIEVAL_STORE_MARKER), "1\n");
}

function health(
  overrides: Partial<RetrievalHealthSnapshot> = {},
): RetrievalHealthSnapshot {
  return {
    status: "ready",
    lexical: "ready",
    scalar: "ready",
    vector: "ready",
    structural: "ready",
    embeddingCredentials: "available",
    reasons: [],
    fingerprintDisposition: "compatible",
    pendingPublications: 0,
    sourceCount: 0,
    chunkCount: 0,
    relationCount: 0,
    staleSourceCount: 0,
    ...overrides,
  };
}

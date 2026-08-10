import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rerankResults,
  rrfMerge,
  semanticFileList,
  semanticFileQuery,
  semanticSearch,
} from "./semanticSearch.js";

import { createHash } from "crypto";

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "semanticSearchEnabled") return true;
        return fallback;
      }),
    })),
    workspaceFolders: [{ name: "workspace", uri: { fsPath: "/workspace" } }],
    getWorkspaceFolder: vi.fn((uri: { fsPath: string }) => {
      const folders = (vscode.workspace.workspaceFolders ??
        []) as unknown as Array<{
        name?: string;
        uri: { fsPath: string };
      }>;
      return folders.find((folder) => uri.fsPath === folder.uri.fsPath);
    }),
  },
}));

const {
  resolveEmbeddingAuth,
  fetchMock,
  execRipgrepSearch,
  getRipgrepBinPath,
  readFileMock,
  statMock,
  retrievalQuery,
  retrievalRepositoryRoots,
  closeRetrievalRepository,
} = vi.hoisted(() => ({
  resolveEmbeddingAuth: vi.fn(),
  fetchMock: vi.fn(),
  execRipgrepSearch: vi.fn(),
  getRipgrepBinPath: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  retrievalQuery: vi.fn(),
  retrievalRepositoryRoots: [] as string[],
  closeRetrievalRepository: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: readFileMock,
  stat: statMock,
}));

vi.mock("../agent/providers/index.js", () => ({
  openAiCodexAuthManager: {
    resolveEmbeddingAuth,
  },
}));

vi.mock("../storage/retrieval/LanceDbRetrievalRepository.js", () => ({
  LanceDbRetrievalRepository: class {
    constructor(options: { root: string }) {
      retrievalRepositoryRoots.push(options.root);
    }

    query = retrievalQuery;
    close = closeRetrievalRepository;
  },
}));

vi.mock("../util/ripgrep.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util/ripgrep.js")>(
      "../util/ripgrep.js",
    );
  return {
    ...actual,
    execRipgrepSearch,
    getRipgrepBinPath,
  };
});

global.fetch = fetchMock as typeof fetch;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// --- rrfMerge ---

describe("rrfMerge", () => {
  const makeResult = (
    id: string,
    score: number,
    filePath = "test.ts",
  ): {
    id: string;
    score: number;
    payload: {
      filePath: string;
      codeChunk: string;
      startLine: number;
      endLine: number;
    };
  } => ({
    id,
    score,
    payload: { filePath, codeChunk: `code ${id}`, startLine: 1, endLine: 10 },
  });

  it("ranks items appearing in both lists higher", () => {
    const vectorResults = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const keywordResults = [makeResult("b", 0.7), makeResult("c", 0.6)];

    const merged = rrfMerge(vectorResults, keywordResults, 10);

    expect(merged[0].id).toBe("b");
  });

  it("includes items from both lists", () => {
    const vectorResults = [makeResult("a", 0.9)];
    const keywordResults = [makeResult("b", 0.7)];

    const merged = rrfMerge(vectorResults, keywordResults, 10);

    expect(merged).toHaveLength(2);
    const ids = merged.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("respects the limit parameter", () => {
    const vectorResults = [
      makeResult("a", 0.9),
      makeResult("b", 0.8),
      makeResult("c", 0.7),
    ];
    const keywordResults = [makeResult("d", 0.6), makeResult("e", 0.5)];

    const merged = rrfMerge(vectorResults, keywordResults, 3);
    expect(merged).toHaveLength(3);
  });

  it("handles empty keyword results", () => {
    const vectorResults = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const merged = rrfMerge(vectorResults, [], 10);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("a");
  });

  it("handles empty vector results", () => {
    const keywordResults = [makeResult("a", 0.7)];
    const merged = rrfMerge([], keywordResults, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("a");
  });
});

// --- rerankResults ---

describe("rerankResults", () => {
  const makeResult = (
    id: string,
    score: number,
    filePath: string,
    codeChunk: string,
  ): {
    id: string;
    score: number;
    payload: {
      filePath: string;
      codeChunk: string;
      startLine: number;
      endLine: number;
    };
  } => ({
    id,
    score,
    payload: { filePath, codeChunk, startLine: 1, endLine: 10 },
  });

  it("boosts results containing query keywords in code", () => {
    const results = [
      makeResult("a", 0.8, "other.ts", "unrelated code here"),
      makeResult("b", 0.7, "manager.ts", "class TerminalManager { }"),
    ];

    const reranked = rerankResults(results, ["TerminalManager"]);

    expect(reranked[0].id).toBe("b");
  });

  it("boosts results with file path matches", () => {
    const results = [
      makeResult("a", 0.8, "other.ts", "some code"),
      makeResult("b", 0.75, "src/TerminalManager.ts", "some code"),
    ];

    const reranked = rerankResults(results, ["Terminal"]);

    expect(reranked[0].id).toBe("b");
  });

  it("returns results unchanged when no keywords", () => {
    const results = [
      makeResult("a", 0.9, "a.ts", "code a"),
      makeResult("b", 0.8, "b.ts", "code b"),
    ];

    const reranked = rerankResults(results, []);

    expect(reranked[0].id).toBe("a");
    expect(reranked[1].id).toBe("b");
  });

  it("filters .agentlink runtime artifact paths from semantic results", () => {
    const results = [
      makeResult(
        "artifact",
        0.99,
        ".agentlink/history/session/messages.json",
        "TerminalManager debug transcript",
      ),
      makeResult(
        "lineage-artifact",
        0.98,
        ".agentlink/workspaces/ws-identity/l-imported/session/messages.json",
        "TerminalManager migrated transcript",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(results, ["TerminalManager"]);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("filters caller-specified exclude globs from semantic results", () => {
    const results = [
      makeResult(
        "dist-artifact",
        0.97,
        "dist/generated/TerminalManager.js",
        "compiled output",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(
      results,
      ["TerminalManager"],
      ["**/dist/**"],
    );

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("normalizes leading dot-slash before applying exclude globs", () => {
    const results = [
      makeResult(
        "generated",
        0.95,
        "./src/generated/types.ts",
        "generated types",
      ),
      makeResult(
        "source",
        0.6,
        "src/integrations/TerminalManager.ts",
        "class TerminalManager {}",
      ),
    ];

    const reranked = rerankResults(
      results,
      ["TerminalManager"],
      ["src/generated/**"],
    );

    expect(reranked).toHaveLength(1);
    expect(reranked[0].id).toBe("source");
  });

  it("combines all three signals", () => {
    const results = [
      makeResult("a", 0.9, "foo.ts", "unrelated stuff"),
      makeResult(
        "b",
        0.5,
        "DiffViewProvider.ts",
        "class DiffViewProvider implements open diff",
      ),
    ];

    const reranked = rerankResults(results, [
      "DiffViewProvider",
      "diff",
      "open",
    ]);

    expect(reranked[0].id).toBe("b");
  });
});

describe("semantic retrieval service", () => {
  let retrievalStoreRoot: string;

  beforeEach(() => {
    vi.useRealTimers();
    retrievalStoreRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-retrieval-store-"),
    );
    resolveEmbeddingAuth.mockReset();
    resolveEmbeddingAuth.mockResolvedValue(null);
    fetchMock.mockReset();
    execRipgrepSearch.mockReset();
    getRipgrepBinPath.mockReset();
    readFileMock.mockReset();
    statMock.mockReset();
    retrievalQuery.mockReset();
    retrievalRepositoryRoots.length = 0;
    closeRetrievalRepository.mockReset();
    closeRetrievalRepository.mockResolvedValue(undefined);
    statMock.mockResolvedValue({
      isFile: () => true,
      dev: 1,
      ino: 1,
      size: 100,
      mtimeMs: 1,
      ctimeMs: 1,
    });
  });

  afterEach(() => {
    fs.rmSync(retrievalStoreRoot, { recursive: true, force: true });
  });

  function candidate(options: {
    workspacePath?: string;
    file: string;
    indexedContent: string;
    liveContent?: string;
    startLine?: number;
    endLine?: number;
    score?: number;
  }) {
    const workspacePath = options.workspacePath ?? "/workspace";
    const revision = sha256(options.indexedContent);
    const scopeId = `scope:${workspacePath}`;
    const sourceId = `source:${workspacePath}:${options.file}`;
    return {
      source: {
        id: sourceId,
        namespace: "code" as const,
        kind: "file" as const,
        revision: {
          id: revision,
          contentHash: revision,
          observedAt: "2026-07-25T00:00:00.000Z",
        },
        path: options.file,
        content: options.indexedContent,
        metadata: { scopeId },
      },
      chunk: {
        id: `chunk:${sourceId}:${options.startLine ?? 1}`,
        sourceId,
        revisionId: revision,
        generation: "generation:test",
        content: options.indexedContent,
        embedding: null,
        location: {
          path: options.file,
          startLine: options.startLine ?? 1,
          endLine: options.endLine ?? 1,
        },
        metadata: { scopeId },
      },
      scores: {
        exact: 0,
        lexical: options.score ?? 0.8,
        vector: 0,
        path: 0,
        source: 0,
        recency: 0,
        final: options.score ?? 0.8,
      },
      liveContent: options.liveContent ?? options.indexedContent,
    };
  }

  function queryResult(
    candidates: ReturnType<typeof candidate>[],
    mode = "lexical",
  ) {
    return {
      query: { text: "test", mode, limit: 10 },
      candidates: candidates.map(
        ({ liveContent: _liveContent, ...entry }) => entry,
      ),
      mode,
    };
  }

  function payload(result: Awaited<ReturnType<typeof semanticSearch>>) {
    const block = result.content[0];
    if (!block || block.type !== "text")
      throw new Error("Expected text result");
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  it("returns structured readiness fields when semantic search is disabled", async () => {
    const getConfigurationMock = vscode.workspace
      .getConfiguration as ReturnType<typeof vi.fn>;
    const originalImpl = getConfigurationMock.getMockImplementation();
    getConfigurationMock.mockImplementation(() => ({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "semanticSearchEnabled" ? false : fallback,
      ),
    }));

    try {
      const result = await semanticSearch(
        "/workspace",
        "disabled",
        5,
        undefined,
        {
          retrievalStoreRoot,
        },
      );
      expect(payload(result).reason).toBe("disabled");
      expect(retrievalQuery).not.toHaveBeenCalled();
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
  });

  it("queries LanceDB lexically without embedding credentials", async () => {
    const hit = candidate({
      file: "src/current.ts",
      indexedContent: "export function lexicalSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit]));

    const result = await semanticSearch(
      "/workspace",
      "lexical search",
      5,
      undefined,
      { retrievalStoreRoot },
    );

    expect(payload(result)).toMatchObject({
      semantic: true,
      total_results: 1,
    });
    expect(String(payload(result).results)).toContain("src/current.ts");
    expect(retrievalQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "lexical search",
        mode: "lexical",
        filters: expect.objectContaining({
          namespaces: ["code"],
          sourceKinds: ["file"],
          metadata: expect.objectContaining({ scopeId: expect.any(String) }),
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(closeRetrievalRepository).toHaveBeenCalledTimes(1);
  });

  it("keeps semantic search local when embeddings are disabled despite available credentials", async () => {
    resolveEmbeddingAuth.mockResolvedValue({
      method: "oauth",
      bearerToken: "oauth-token",
      canRefresh: true,
    });
    const hit = candidate({
      file: "src/local.ts",
      indexedContent: "export function localSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit]));

    await semanticSearch("/workspace", "local search", 5, undefined, {
      retrievalStoreRoot,
    });

    expect(resolveEmbeddingAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(retrievalQuery).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "lexical" }),
    );
  });

  it("uses hybrid retrieval when embeddings are explicitly enabled", async () => {
    const getConfigurationMock = vscode.workspace
      .getConfiguration as ReturnType<typeof vi.fn>;
    const originalImpl = getConfigurationMock.getMockImplementation();
    getConfigurationMock.mockImplementation(() => ({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "semanticEmbeddingsEnabled" ? true : fallback,
      ),
    }));
    resolveEmbeddingAuth.mockResolvedValue({
      method: "oauth",
      bearerToken: "oauth-token",
      canRefresh: true,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    const hit = candidate({
      file: "src/hybrid.ts",
      indexedContent: "export function hybridSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit], "hybrid"));

    try {
      await semanticSearch("/workspace", "hybrid search", 5, undefined, {
        retrievalStoreRoot,
      });

      expect(retrievalQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          embedding: [0.1, 0.2],
          mode: "hybrid",
        }),
      );
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
        Authorization: "Bearer oauth-token",
      });
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
  });

  it("uses a stable source id for exact-file semantic lookup", async () => {
    const content = "line one\nline two";
    const hit = candidate({
      file: "src/current.ts",
      indexedContent: content,
      startLine: 2,
      endLine: 2,
    });
    retrievalQuery.mockResolvedValue(queryResult([hit]));

    await expect(
      semanticFileQuery(
        "src/current.ts",
        "line two",
        "/workspace",
        sha256(content),
        { retrievalStoreRoot },
      ),
    ).resolves.toEqual({ status: "current", startLine: 2, endLine: 2 });

    const request = retrievalQuery.mock.calls[0][0];
    expect(request.filters.sourceIds).toEqual([
      expect.stringContaining("src/current.ts"),
    ]);
    expect(request.filters.pathPrefix).toBeUndefined();
  });

  it("suppresses stale and deleted sources while hydrating current snippets", async () => {
    const current = candidate({
      file: "src/current.ts",
      indexedContent: "current live line",
    });
    const changed = candidate({
      file: "src/changed.ts",
      indexedContent: "old changed content",
      liveContent: "new changed content",
      score: 0.9,
    });
    const deleted = candidate({
      file: "src/deleted.ts",
      indexedContent: "deleted content",
      score: 0.7,
    });
    retrievalQuery.mockResolvedValue(queryResult([changed, current, deleted]));
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === "/workspace/src/current.ts") return current.liveContent;
      if (filePath === "/workspace/src/changed.ts") return changed.liveContent;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const result = await semanticSearch(
      "/workspace",
      "current changed deleted",
      10,
      undefined,
      { retrievalStoreRoot },
    );
    const resultPayload = payload(result);

    expect(resultPayload.total_results).toBe(1);
    expect(String(resultPayload.results)).toContain("current live line");
    expect(String(resultPayload.results)).not.toContain("old changed content");
    expect(resultPayload.freshness).toEqual({
      stale_sources: ["src/changed.ts"],
      deleted_sources: ["src/deleted.ts"],
      unverified_sources: [],
    });
  });

  it("deduplicates ranked file results and preserves freshness", async () => {
    const first = candidate({
      file: "src/current.ts",
      indexedContent: "current source",
      score: 0.9,
    });
    const second = candidate({
      file: "src/current.ts",
      indexedContent: "current source",
      startLine: 2,
      score: 0.8,
    });
    readFileMock.mockResolvedValue("current source");
    retrievalQuery.mockResolvedValue(queryResult([first, second]));

    const result = await semanticFileList("/workspace", "current", 10, {
      retrievalStoreRoot,
    });
    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.path).toBe("src/current.ts");
    expect(result?.files[0]?.score).toBeCloseTo(0.94);
  });

  it("fans out across workspace roots without mixing scope filters", async () => {
    const workspace = vscode.workspace as unknown as {
      workspaceFolders: Array<{ name: string; uri: { fsPath: string } }>;
    };
    const originalFolders = workspace.workspaceFolders;
    workspace.workspaceFolders = [
      { name: "api", uri: { fsPath: "/workspace/api" } },
      { name: "web", uri: { fsPath: "/workspace/web" } },
    ];
    const api = candidate({
      workspacePath: "/workspace/api",
      file: "src/server.ts",
      indexedContent: "api current content",
    });
    const web = candidate({
      workspacePath: "/workspace/web",
      file: "src/App.tsx",
      indexedContent: "web current content",
      score: 0.9,
    });
    readFileMock.mockImplementation(async (filePath: string) =>
      filePath.includes("/api/") ? api.liveContent : web.liveContent,
    );
    retrievalQuery
      .mockResolvedValueOnce(queryResult([api]))
      .mockResolvedValueOnce(queryResult([web]));
    const apiStoreRoot = path.join(retrievalStoreRoot, "api");
    const webStoreRoot = path.join(retrievalStoreRoot, "web");
    fs.mkdirSync(apiStoreRoot);
    fs.mkdirSync(webStoreRoot);
    const retrievalStoreRootForWorkspace = vi.fn((workspacePath: string) =>
      workspacePath === "/workspace/api" ? apiStoreRoot : webStoreRoot,
    );

    try {
      const result = await semanticSearch(
        "/workspace/api",
        "workspace search",
        5,
        undefined,
        { includeAllWorkspaceRoots: true, retrievalStoreRootForWorkspace },
      );
      const resultPayload = payload(result);
      expect(String(resultPayload.results)).toContain("api/src/server.ts");
      expect(String(resultPayload.results)).toContain("web/src/App.tsx");
      const scopeIds = retrievalQuery.mock.calls.map(
        ([request]) => request.filters.metadata.scopeId,
      );
      expect(new Set(scopeIds).size).toBe(2);
      expect(
        retrievalStoreRootForWorkspace.mock.calls.map(([root]) => root),
      ).toEqual(["/workspace/api", "/workspace/web"]);
      expect(retrievalRepositoryRoots).toEqual([apiStoreRoot, webStoreRoot]);
    } finally {
      workspace.workspaceFolders = originalFolders;
    }
  });

  it("prefers an explicit store root over the per-workspace resolver", async () => {
    retrievalQuery.mockResolvedValue(queryResult([]));
    const retrievalStoreRootForWorkspace = vi.fn(() =>
      path.join(retrievalStoreRoot, "derived"),
    );

    await semanticFileList("/workspace", "explicit root", 5, {
      retrievalStoreRoot,
      retrievalStoreRootForWorkspace,
    });

    expect(retrievalStoreRootForWorkspace).not.toHaveBeenCalled();
    expect(retrievalRepositoryRoots).toEqual([retrievalStoreRoot]);
  });

  it("falls back to bounded ripgrep when the local retrieval store is missing", async () => {
    const missingRoot = path.join(retrievalStoreRoot, "missing");
    getRipgrepBinPath.mockResolvedValue("rg");
    execRipgrepSearch.mockResolvedValue(
      [
        JSON.stringify({
          type: "begin",
          data: { path: { text: "/workspace/src/searchFiles.ts" } },
        }),
        JSON.stringify({
          type: "match",
          data: {
            path: { text: "/workspace/src/searchFiles.ts" },
            lines: { text: "function searchFiles() {" },
            line_number: 12,
            absolute_offset: 0,
          },
        }),
        JSON.stringify({
          type: "end",
          data: { path: { text: "/workspace/src/searchFiles.ts" } },
        }),
      ].join("\n"),
    );

    const result = await semanticSearch(
      "/workspace",
      "search files",
      5,
      undefined,
      { retrievalStoreRoot: missingRoot },
    );
    const resultPayload = payload(result);

    expect(resultPayload.semantic).toBe(false);
    expect(String(resultPayload.warning)).toContain("temporarily unavailable");
    expect(String(resultPayload.results)).toContain("src/searchFiles.ts");
    expect(execRipgrepSearch).toHaveBeenCalledTimes(1);
  });
});

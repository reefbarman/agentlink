import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
  MAX_SEARCH_EXCERPT_CHARS,
  rerankResults,
  rrfMerge,
  semanticSearch,
} from "./semanticSearch.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "../indexer/codeRetrievalIdentity.js";

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

  it("boosts joined identifiers in indexed ranking without excluding matching fixtures", () => {
    const results = [
      makeResult(
        "scattered",
        0.5,
        "src/other.ts",
        "provider data with usage elsewhere",
      ),
      makeResult(
        "fixture",
        0.5,
        "src/__fixtures__/ProviderUsageService.ts",
        "class ProviderUsageService {}",
      ),
      makeResult(
        "source",
        0.5,
        "src/ProviderUsageService.ts",
        "class ProviderUsageService {}",
      ),
    ];
    const reranked = rerankResults(
      results,
      ["provider", "usage"],
      undefined,
      "provider usage",
    );
    expect(reranked.map((result) => result.id)).toEqual([
      "source",
      "fixture",
      "scattered",
    ]);
  });

  it("prefers adjacent terms to equally weighted scattered terms", () => {
    const results = [
      makeResult(
        "scattered",
        0.5,
        "src/a.ts",
        "rate of requests, then limit the result",
      ),
      makeResult("phrase", 0.5, "src/b.ts", "apply a rate limit"),
    ];
    const reranked = rerankResults(
      results,
      ["rate", "limit"],
      undefined,
      "rate limit",
    );
    expect(reranked[0].id).toBe("phrase");
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
    degradedReason?: string,
  ) {
    return {
      query: { text: "test", mode, limit: 10 },
      candidates: candidates.map(
        ({ liveContent: _liveContent, ...entry }) => entry,
      ),
      mode,
      ...(degradedReason ? { degradedReason } : {}),
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
      expect(result.isError).toBe(true);
      expect(payload(result)).not.toHaveProperty("ranking");
      expect(payload(result).reason).toBe("disabled");
      expect(retrievalQuery).not.toHaveBeenCalled();
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
  });

  it("retains exact-file hits and rejects sibling hits using a stable source filter", async () => {
    const hit = candidate({
      file: "src/target.ts",
      indexedContent: "export const target = 1;",
    });
    const sibling = candidate({
      file: "src/sibling.ts",
      indexedContent: "export const sibling = 2;",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit, sibling]));
    const result = await semanticSearch(
      "/workspace/src/target.ts",
      "target",
      5,
      undefined,
      { retrievalStoreRoot, exactFile: true },
    );
    expect(payload(result)).toMatchObject({
      total_results: 1,
      ranking: "lexical",
    });
    expect(String(payload(result).results)).toContain("src/target.ts");
    expect(String(payload(result).results)).not.toContain("src/sibling.ts");
    const filters = retrievalQuery.mock.calls[0][0].filters;
    expect(filters.sourceIds).toEqual([
      getCodeSourceId(getCodeWorkspaceScopeId("/workspace"), "src/target.ts"),
    ]);
    expect(filters).not.toHaveProperty("pathPrefix");
    expect(readFileMock).toHaveBeenCalledWith(
      "/workspace/src/target.ts",
      "utf8",
    );
    expect(readFileMock).not.toHaveBeenCalledWith(
      "/workspace/src/sibling.ts",
      "utf8",
    );
  });

  it("preserves known store-side embedding auth degradation", async () => {
    retrievalQuery.mockResolvedValue(
      queryResult([], "lexical", "missing_embeddings_auth"),
    );
    const result = await semanticSearch("/workspace", "target", 5, undefined, {
      retrievalStoreRoot,
    });
    expect(payload(result)).toMatchObject({
      ranking: "lexical",
      ranking_reason: "embedding_auth_missing",
    });
  });

  it.each(["/workspace", "/second-workspace"])(
    "retains file-scoped fallback filenames within %s",
    async (root) => {
      const originalFolders = vscode.workspace.workspaceFolders;
      Object.assign(vscode.workspace, {
        workspaceFolders: [
          { name: "workspace", uri: { fsPath: "/workspace" } },
          { name: "second", uri: { fsPath: "/second-workspace" } },
        ],
      });
      const file = `${root}/src/target.ts`;
      getRipgrepBinPath.mockResolvedValue("rg");
      execRipgrepSearch.mockResolvedValue(
        [
          JSON.stringify({ type: "begin", data: { path: { text: file } } }),
          JSON.stringify({
            type: "match",
            data: {
              path: { text: file },
              lines: { text: "target function" },
              line_number: 1,
              absolute_offset: 0,
            },
          }),
          JSON.stringify({ type: "end", data: { path: { text: file } } }),
        ].join("\n"),
      );
      try {
        const result = await semanticSearch(
          file,
          "target function",
          5,
          undefined,
          {
            retrievalStoreRoot: path.join(retrievalStoreRoot, "missing"),
            exactFile: true,
          },
        );
        expect(payload(result)).toMatchObject({
          ranking: "keyword_fallback",
          ranking_reason: "missing_index",
          total_results: 1,
        });
        expect(String(payload(result).results)).toContain("## src/target.ts");
        expect(execRipgrepSearch).toHaveBeenCalledWith(
          "rg",
          expect.arrayContaining([file]),
        );
      } finally {
        Object.assign(vscode.workspace, { workspaceFolders: originalFolders });
      }
    },
  );

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
      ranking: "lexical",
      ranking_reason: "embeddings_disabled",
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

  it("keeps lexical ranking local when embeddings are disabled despite available credentials", async () => {
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

    const result = await semanticSearch(
      "/workspace",
      "local search",
      5,
      undefined,
      {
        retrievalStoreRoot,
      },
    );

    expect(resolveEmbeddingAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({
      ranking: "lexical",
      ranking_reason: "embeddings_disabled",
    });
    expect(retrievalQuery).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "lexical" }),
    );
  });

  it("reports missing embedding auth while using lexical ranking", async () => {
    const getConfigurationMock = vscode.workspace
      .getConfiguration as ReturnType<typeof vi.fn>;
    const originalImpl = getConfigurationMock.getMockImplementation();
    getConfigurationMock.mockImplementation(() => ({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "semanticEmbeddingsEnabled" ? true : fallback,
      ),
    }));
    const hit = candidate({
      file: "src/lexical.ts",
      indexedContent: "export function lexicalSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit]));

    try {
      const result = await semanticSearch(
        "/workspace",
        "lexical search",
        5,
        undefined,
        {
          retrievalStoreRoot,
        },
      );
      expect(payload(result)).toMatchObject({
        ranking: "lexical",
        ranking_reason: "embedding_auth_missing",
        guidance: expect.stringContaining("Configure embedding credentials"),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
  });

  it("reports embedding request failures while using lexical ranking", async () => {
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
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const hit = candidate({
      file: "src/lexical.ts",
      indexedContent: "export function lexicalSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(queryResult([hit]));

    try {
      const result = await semanticSearch(
        "/workspace",
        "lexical search",
        5,
        undefined,
        {
          retrievalStoreRoot,
        },
      );
      expect(payload(result)).toMatchObject({
        ranking: "lexical",
        ranking_reason: "embedding_network",
        guidance: expect.stringContaining(
          "Check embedding service availability",
        ),
      });
      expect(retrievalQuery).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "lexical" }),
      );
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
  });

  it("reports store-side vector downgrade after successful embedding", async () => {
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
      file: "src/downgraded.ts",
      indexedContent: "export function lexicalSearch() {}",
    });
    readFileMock.mockResolvedValue(hit.liveContent);
    retrievalQuery.mockResolvedValue(
      queryResult([hit], "lexical", "vector_index_unavailable"),
    );

    try {
      const result = await semanticSearch(
        "/workspace",
        "lexical search",
        5,
        undefined,
        {
          retrievalStoreRoot,
        },
      );
      expect(payload(result)).toMatchObject({
        ranking: "lexical",
        ranking_reason: "vector_index_unavailable",
        guidance: expect.stringContaining("Rebuild the codebase index"),
      });
    } finally {
      if (originalImpl) getConfigurationMock.mockImplementation(originalImpl);
    }
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
      const result = await semanticSearch(
        "/workspace",
        "hybrid search",
        5,
        undefined,
        {
          retrievalStoreRoot,
        },
      );

      expect(payload(result)).toMatchObject({ ranking: "hybrid" });
      expect(payload(result)).not.toHaveProperty("ranking_reason");
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

  it.each([
    {
      file: "settings.jsonc",
      content:
        '{\n"passwords": [\n"synthetic-semantic-secret"\n],\n"theme": "dark"\n}',
      startLine: 3,
      endLine: 5,
    },
    {
      file: "mise.toml",
      content:
        'api_key = """synthetic-semantic-secret\nsecond-secret-line"""\ntheme = "dark"',
      startLine: 1,
      endLine: 3,
    },
    {
      file: "settings.json",
      content: '{"apiKey":"synthetic-semantic-secret"',
      startLine: 1,
      endLine: 1,
    },
  ])(
    "redacts full $file before hydrating a partial excerpt",
    async (testCase) => {
      const hit = candidate({
        file: testCase.file,
        indexedContent: testCase.content,
        startLine: testCase.startLine,
        endLine: testCase.endLine,
      });
      readFileMock.mockResolvedValue(hit.liveContent);
      retrievalQuery.mockResolvedValue(queryResult([hit]));
      const result = await semanticSearch("/workspace", "theme", 5, undefined, {
        retrievalStoreRoot,
      });
      expect(payload(result)).toMatchObject({ total_results: 1 });
      expect(JSON.stringify(result)).not.toContain("synthetic-semantic-secret");
      expect(JSON.stringify(result)).not.toContain("second-secret-line");
      if (testCase.file === "settings.json") {
        expect(JSON.stringify(result)).toContain("CONTENT WITHHELD");
      } else {
        expect(JSON.stringify(result)).toContain("theme");
      }
    },
  );

  it.each(["valid", "malformed", "unreadable"])(
    "protects %s structured settings in keyword fallback",
    async (state) => {
      retrievalQuery.mockRejectedValue(new Error("fetch failed"));
      getRipgrepBinPath.mockResolvedValue("rg");
      const content = '{"theme":"dark","apiKey":"synthetic-fallback-secret"}';
      if (state === "unreadable")
        readFileMock.mockRejectedValue(new Error("missing"));
      else
        readFileMock.mockResolvedValue(
          state === "malformed" ? content.slice(0, -1) : content,
        );
      execRipgrepSearch.mockResolvedValue(
        [
          {
            type: "begin",
            data: { path: { text: "/workspace/settings.json" } },
          },
          {
            type: "match",
            data: {
              path: { text: "/workspace/settings.json" },
              lines: { text: content + "\n" },
              line_number: 1,
            },
          },
          { type: "end", data: { path: { text: "/workspace/settings.json" } } },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
      const result = await semanticSearch("/workspace", "theme", 5, undefined, {
        retrievalStoreRoot,
      });
      expect(payload(result)).toMatchObject({
        ranking: "keyword_fallback",
        ranking_reason: "embedding_network",
        guidance: expect.stringContaining(
          "Check embedding service availability",
        ),
        total_results: 1,
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-fallback-secret");
      expect(JSON.stringify(result)).toContain(
        state === "valid" ? "[REDACTED]" : "CONTENT WITHHELD",
      );
    },
  );

  it.each(["lexical", "hybrid"])(
    "bounds hydrated minified excerpts for %s retrieval",
    async (mode) => {
      const content = '{"sprites":"' + "x".repeat(411_499) + '"}';
      const hit = candidate({
        file: "Tools/openapi.json",
        indexedContent: content,
      });
      const small = candidate({
        file: "src/sprites.ts",
        indexedContent: "export const sprites = [];",
      });
      retrievalQuery.mockResolvedValue(queryResult([hit, small], mode));
      readFileMock.mockImplementation(async (filePath: string) =>
        filePath.endsWith("openapi.json") ? content : small.liveContent,
      );
      const result = payload(
        await semanticSearch("/workspace", "sprites", 6, undefined, {
          retrievalStoreRoot,
        }),
      );
      expect(result).toMatchObject({
        total_results: 2,
        truncated_results: 1,
        excerpt_limit: MAX_SEARCH_EXCERPT_CHARS,
      });
      expect(String(result.results)).toContain("[truncated...]");
      expect(String(result.results)).toContain("export const sprites = [];");
      expect(String(result.results).length).toBeLessThan(
        MAX_SEARCH_EXCERPT_CHARS + 300,
      );
      expect(JSON.stringify(result).length).toBeLessThan(5000);
    },
  );

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

    await semanticSearch("/workspace", "explicit root", 5, undefined, {
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

    expect(resultPayload.ranking).toBe("keyword_fallback");
    expect(resultPayload.ranking_reason).toBe("missing_index");
    expect(resultPayload).not.toHaveProperty("semantic");
    expect(String(resultPayload.warning)).toContain("temporarily unavailable");
    expect(String(resultPayload.results)).toContain("src/searchFiles.ts");
    expect(execRipgrepSearch).toHaveBeenCalledTimes(1);
  });

  it("ranks adjacent phrases and identifiers above scattered fixture matches", async () => {
    const files = [
      {
        file: "/workspace/src/ProviderUsageService.ts",
        text: "export class ProviderUsageService {}",
      },
      {
        file: "/workspace/src/unrelated.ts",
        text: "OpenAI compatible connection configuration and provider data are displayed with usage elsewhere.",
      },
      {
        file: "/workspace/src/__snapshots__/provider-usage.snap",
        text: "OpenAI compatible connection configuration provider usage quota rate limits display",
      },
    ];
    retrievalQuery.mockRejectedValue(new Error("fetch failed"));
    getRipgrepBinPath.mockResolvedValue("rg");
    execRipgrepSearch.mockResolvedValue(
      files
        .flatMap(({ file, text }) => [
          { type: "begin", data: { path: { text: file } } },
          {
            type: "match",
            data: {
              path: { text: file },
              lines: { text },
              line_number: 1,
            },
          },
          { type: "end", data: { path: { text: file } } },
        ])
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );

    const result = payload(
      await semanticSearch(
        "/workspace",
        "OpenAI compatible connection configuration provider usage quota rate limits display",
        5,
        undefined,
        { retrievalStoreRoot },
      ),
    );

    expect(result.ranking_reason).toBe("embedding_network");
    expect(
      String(result.results).indexOf("src/ProviderUsageService.ts"),
    ).toBeLessThan(String(result.results).indexOf("src/unrelated.ts"));
    expect(String(result.results).indexOf("src/unrelated.ts")).toBeLessThan(
      String(result.results).indexOf("src/__snapshots__/provider-usage.snap"),
    );
  });

  it("does not report ranking when keyword fallback also fails", async () => {
    const missingRoot = path.join(retrievalStoreRoot, "missing");
    getRipgrepBinPath.mockRejectedValue(new Error("ripgrep unavailable"));

    const output = await semanticSearch(
      "/workspace",
      "search files",
      5,
      undefined,
      {
        retrievalStoreRoot: missingRoot,
      },
    );
    expect(output.isError).toBe(true);
    const result = payload(output);

    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("fallback_error");
    expect(result).not.toHaveProperty("ranking");
    expect(result).not.toHaveProperty("ranking_reason");
  });
});

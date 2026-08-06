import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVscodeAdvertisedArtifactProvider,
  createVscodeContextDocumentProvider,
  createVscodeContextEnrichmentProvider,
  createVscodeContextWorkingSetProvider,
  createVscodePathAccessProvider,
  createVscodeReadFileEnrichmentProvider,
  createVscodeSemanticSearchProvider,
  createVscodeStructuralGraphProvider,
} from "./readSearchCapabilities.js";
import {
  getCodeRetrievalStoreRoot,
  getCodeWorkspaceScopeId,
} from "../../indexer/codeRetrievalIdentity.js";

import { LanceDbRetrievalRepository } from "../../storage/retrieval/LanceDbRetrievalRepository.js";
import { createCodeIndexFingerprint } from "../../indexer/retrievalFingerprint.js";
import { prepareCodeFilePublication } from "../../indexer/retrievalPublicationTranslation.js";

vi.mock("../../util/agentlinkTmpArtifacts.js", () => ({
  isAgentlinkTmpArtifact: (filePath: string) =>
    filePath.includes("agentlink-output"),
}));

const approveOutsideWorkspaceAccess = vi.hoisted(() => vi.fn());
vi.mock("../../tools/pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess,
}));

const semanticSearch = vi.hoisted(() => vi.fn());
vi.mock("../../services/semanticSearch.js", () => ({ semanticSearch }));

const getWorkspaceRoots = vi.hoisted(() => vi.fn(() => ["/workspace"]));
const resolveAndValidatePath = vi.hoisted(() => vi.fn());
const tryGetFirstWorkspaceRoot = vi.hoisted(() => vi.fn());
const resolveAndOpenDocument = vi.hoisted(() => vi.fn());
vi.mock("../../util/paths.js", () => ({
  getWorkspaceRoots,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
}));
vi.mock("../../tools/languageFeatures.js", () => ({
  resolveAndOpenDocument,
}));

describe("createVscodeAdvertisedArtifactProvider", () => {
  it("exposes advertised artifact filesystem hooks", () => {
    const provider = createVscodeAdvertisedArtifactProvider();

    expect(provider.resolvePath).toBeTypeOf("function");
    expect(provider.normalizeExistingPath).toBeTypeOf("function");
    expect(provider.readTextFile).toBeTypeOf("function");
  });
});

describe("createVscodeReadFileEnrichmentProvider", () => {
  it("exposes VS Code-backed read_file enrichment hooks", () => {
    const provider = createVscodeReadFileEnrichmentProvider();

    expect(provider.getGitStatus).toBeTypeOf("function");
    expect(provider.detectLanguage).toBeTypeOf("function");
    expect(provider.getSymbolOutline).toBeTypeOf("function");
    expect(provider.getDiagnosticsSummary).toBeTypeOf("function");
  });
});

describe("createVscodeSemanticSearchProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
    tryGetFirstWorkspaceRoot.mockReturnValue("/workspace");
    semanticSearch.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({ query: "auth flow", total_results: 1 }),
        },
      ],
    });
  });

  it("resolves scoped paths and delegates to semanticSearch", async () => {
    const provider = createVscodeSemanticSearchProvider();

    const result = await provider.search({
      query: "auth flow",
      path: "src/agent",
      limit: 4,
      exclude_globs: ["**/dist/**"],
    });

    expect(resolveAndValidatePath).toHaveBeenCalledWith("src/agent");
    expect(semanticSearch).toHaveBeenCalledWith(
      "/workspace/src/agent",
      "auth flow",
      4,
      ["**/dist/**"],
      { includeAllWorkspaceRoots: false },
    );
    expect(result).toEqual({
      payload: { query: "auth flow", total_results: 1 },
    });
  });

  it("uses only the pinned project root when no path is provided", async () => {
    const provider = createVscodeSemanticSearchProvider("/workspace/project-b");

    await provider.search({ query: "auth flow" });

    expect(resolveAndValidatePath).not.toHaveBeenCalled();
    expect(tryGetFirstWorkspaceRoot).not.toHaveBeenCalled();
    expect(semanticSearch).toHaveBeenCalledWith(
      "/workspace/project-b",
      "auth flow",
      undefined,
      undefined,
      { includeAllWorkspaceRoots: false },
    );
  });
});

describe("createVscodeContext providers", () => {
  it("exposes VS Code-backed context hooks", () => {
    const documentProvider = createVscodeContextDocumentProvider(
      {} as never,
      {} as never,
    );
    const workingSetProvider = createVscodeContextWorkingSetProvider();
    const enrichmentProvider = createVscodeContextEnrichmentProvider();

    expect(documentProvider.resolveDocument).toBeTypeOf("function");
    expect(workingSetProvider.check).toBeTypeOf("function");
    expect(enrichmentProvider.getGitStatus).toBeTypeOf("function");
    expect(enrichmentProvider.getDocumentSymbols).toBeTypeOf("function");
    expect(enrichmentProvider.getDiagnosticsSummary).toBeTypeOf("function");
  });

  it("normalizes VS Code nonexistent-document errors for shared recovery", async () => {
    resolveAndOpenDocument.mockRejectedValueOnce(
      new Error(
        "Unable to resolve nonexistent file '/workspace/src/toolz/executeCommand.ts'",
      ),
    );
    const provider = createVscodeContextDocumentProvider(
      {} as never,
      {} as never,
    );

    await expect(
      provider.resolveDocument(
        "src/toolz/executeCommand.ts",
        "session-missing",
      ),
    ).rejects.toMatchObject({
      code: "FileNotFound",
      message: expect.stringContaining("Unable to resolve nonexistent file"),
    });
  });

  it("does not normalize unrelated document-resolution errors", async () => {
    const error = new Error("No workspace folder open and path is relative");
    resolveAndOpenDocument.mockRejectedValueOnce(error);
    const provider = createVscodeContextDocumentProvider(
      {} as never,
      {} as never,
    );

    await expect(
      provider.resolveDocument("src/file.ts", "session-error"),
    ).rejects.toBe(error);
  });
});

describe("createVscodeStructuralGraphProvider", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns undefined without global storage", () => {
    expect(createVscodeStructuralGraphProvider(undefined)).toBeUndefined();
  });

  it("exposes VS Code-backed structural graph hooks", () => {
    const provider = createVscodeStructuralGraphProvider({
      fsPath: "/global-storage",
    } as never);

    expect(provider).toMatchObject({
      resolveWorkspaceRoot: expect.any(Function),
      resolvePath: expect.any(Function),
      getWorkspaceRootForPath: expect.any(Function),
      getScopeStatus: expect.any(Function),
      loadGraph: expect.any(Function),
      getTargetFreshness: expect.any(Function),
    });
  });

  it("classifies missing and unindexed scopes from the filesystem", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-scope-"));
    directories.push(directory);
    const unindexedDirectory = path.join(directory, "src", "unindexed");
    const unindexedFile = path.join(directory, "src", "unindexed.ts");
    fs.mkdirSync(unindexedDirectory, { recursive: true });
    fs.writeFileSync(unindexedFile, "export {};", "utf8");
    const provider = createVscodeStructuralGraphProvider({
      fsPath: "/global-storage",
    } as never)!;

    expect(provider.getScopeStatus(unindexedDirectory, 0)).toBe("unindexed");
    expect(provider.getScopeStatus(unindexedFile, 0)).toBe("unindexed_file");
    expect(provider.getScopeStatus(path.join(directory, "missing"), 0)).toBe(
      "missing",
    );
    expect(provider.getScopeStatus(unindexedDirectory, 1)).toBe("indexed");
  });

  it("reports a missing unified retrieval store without creating one", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-storage-"));
    directories.push(directory);
    const storeRoot = getCodeRetrievalStoreRoot(directory, "workspace");
    fs.mkdirSync(storeRoot, { recursive: true });
    const before = fs.readdirSync(storeRoot);
    const provider = createVscodeStructuralGraphProvider({
      fsPath: directory,
    } as never)!;

    await expect(provider.loadGraph("workspace")).resolves.toMatchObject({
      workspaceRoot: "workspace",
      indexName: getCodeWorkspaceScopeId("workspace"),
      structuralStorePath: storeRoot,
      graphExists: false,
      graph: { files: {} },
    });
    expect(fs.readdirSync(storeRoot)).toEqual(before);
  });

  it("projects only the requested workspace from committed retrieval records", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-store-"));
    directories.push(directory);
    const storeRoot = getCodeRetrievalStoreRoot(directory, "workspace");
    const repository = new LanceDbRetrievalRepository({ root: storeRoot });
    await repository.migrate(createCodeIndexFingerprint("standard"));

    const publish = async (
      workspaceRoot: string,
      sourcePath: string,
      imports: Array<{
        specifier: string;
        kind: "static";
        resolvedRelPath: string;
        line: number;
      }> = [],
    ) => {
      const publication = prepareCodeFilePublication({
        publicationId: `publication:${workspaceRoot}:${sourcePath}`,
        generation: `generation:${workspaceRoot}:${sourcePath}`,
        workspaceRoot,
        sourcePath,
        contentHash: `hash:${workspaceRoot}:${sourcePath}`,
        observedAt: "2026-07-25T01:00:00.000Z",
        sourceContent: "export const value = true;",
        chunks: [],
        structuralEntry: {
          relPath: sourcePath,
          hash: `hash:${workspaceRoot}:${sourcePath}`,
          indexedAt: "2026-07-25T01:00:00.000Z",
          language: "typescript",
          imports,
          exports: [{ name: "value", kind: "named", line: 1 }],
          symbols: [{ name: "value", kind: "const", exported: true, line: 1 }],
        },
      });
      await repository.preparePublication(publication);
      await repository.commitPublication(publication.publicationId);
    };

    try {
      await publish("workspace", "src/helper.ts");
      await publish("workspace", "src/main.ts", [
        {
          specifier: "./helper.js",
          kind: "static",
          resolvedRelPath: "src/helper.ts",
          line: 1,
        },
      ]);
      await publish("other-workspace", "src/main.ts");
    } finally {
      await repository.close();
    }

    const provider = createVscodeStructuralGraphProvider(
      { fsPath: directory } as never,
      "standard",
    )!;
    const snapshot = await provider.loadGraph("workspace");

    expect(snapshot).toMatchObject({
      workspaceRoot: "workspace",
      indexName: getCodeWorkspaceScopeId("workspace"),
      structuralStorePath: storeRoot,
      graphExists: true,
      graph: {
        files: {
          "src/main.ts": {
            hash: "hash:workspace:src/main.ts",
            imports: [
              expect.objectContaining({
                specifier: "./helper.js",
                resolvedRelPath: "src/helper.ts",
              }),
            ],
          },
          "src/helper.ts": expect.any(Object),
        },
      },
    });
    expect(Object.keys(snapshot.graph.files)).toEqual([
      "src/helper.ts",
      "src/main.ts",
    ]);
  });

  it("returns the raw symlinked workspace root for canonical file paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-provider-"));
    directories.push(directory);
    const physicalRoot = path.join(directory, "physical");
    const rawRoot = path.join(directory, "workspace-link");
    const target = path.join(physicalRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};", "utf8");
    fs.symlinkSync(physicalRoot, rawRoot, "dir");
    getWorkspaceRoots.mockReturnValueOnce([rawRoot]);

    const provider = createVscodeStructuralGraphProvider({
      fsPath: "/global-storage",
    } as never)!;

    expect(provider.getWorkspaceRootForPath(fs.realpathSync(target))).toBe(
      rawRoot,
    );
  });
});

describe("createVscodePathAccessProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves in-workspace reads without UI approval", async () => {
    const approvalManager = { isPathTrusted: vi.fn() };
    const provider = createVscodePathAccessProvider(
      approvalManager as never,
      {} as never,
    );

    await expect(
      provider.ensureAccess({
        absolutePath: "/workspace/file.ts",
        inputPath: "file.ts",
        inWorkspace: true,
        sessionId: "session-1",
        kind: "read",
      }),
    ).resolves.toEqual({ approved: true });

    expect(approvalManager.isPathTrusted).not.toHaveBeenCalled();
    expect(approveOutsideWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("delegates outside-workspace reads to the existing approval UI", async () => {
    approveOutsideWorkspaceAccess.mockResolvedValue({
      approved: false,
      reason: "outside workspace",
    });
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const approvalPanel = {};
    const provider = createVscodePathAccessProvider(
      approvalManager as never,
      approvalPanel as never,
    );

    const result = await provider.ensureAccess({
      absolutePath: "/outside/file.ts",
      inputPath: "/outside/file.ts",
      inWorkspace: false,
      sessionId: "session-2",
      kind: "read",
    });

    expect(result).toEqual({ approved: false, reason: "outside workspace" });
    expect(approveOutsideWorkspaceAccess).toHaveBeenCalledWith(
      "/outside/file.ts",
      approvalManager,
      approvalPanel,
      "session-2",
      undefined,
    );
  });

  it("allows temporary AgentLink artifacts without UI approval", async () => {
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const provider = createVscodePathAccessProvider(
      approvalManager as never,
      {} as never,
    );

    await expect(
      provider.ensureAccess({
        absolutePath: "/tmp/agentlink-output-123/output.txt",
        inputPath: "/tmp/agentlink-output-123/output.txt",
        inWorkspace: false,
        sessionId: "session-3",
        kind: "read",
      }),
    ).resolves.toEqual({ approved: true });

    expect(approveOutsideWorkspaceAccess).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../util/agentlinkTmpArtifacts.js", () => ({
  isAgentlinkTmpArtifact: (filePath: string) =>
    filePath.includes("agentlink-output"),
}));

const approveOutsideWorkspaceAccess = vi.hoisted(() => vi.fn());
vi.mock("../../tools/pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess,
}));

const semanticSearch = vi.hoisted(() => vi.fn());
vi.mock("../../services/semanticSearch.js", () => ({
  getAlCollectionName: vi.fn((workspaceRoot: string) => `al-${workspaceRoot}`),
  semanticSearch,
}));

const resolveAndValidatePath = vi.hoisted(() => vi.fn());
const tryGetFirstWorkspaceRoot = vi.hoisted(() => vi.fn());
vi.mock("../../util/paths.js", () => ({
  getWorkspaceRootForPath: vi.fn(() => "/workspace"),
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
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
      content: [{ type: "text", text: "semantic results" }],
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
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "semantic results",
    });
  });

  it("uses all workspace roots when no path is provided", async () => {
    const provider = createVscodeSemanticSearchProvider();

    await provider.search({ query: "auth flow" });

    expect(resolveAndValidatePath).not.toHaveBeenCalled();
    expect(tryGetFirstWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(semanticSearch).toHaveBeenCalledWith(
      "/workspace",
      "auth flow",
      undefined,
      undefined,
      { includeAllWorkspaceRoots: true },
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
});

describe("createVscodeStructuralGraphProvider", () => {
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
      loadGraph: expect.any(Function),
      getTargetFreshness: expect.any(Function),
    });
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
    );
  });

  it("allows temporary AgentLink artifacts without UI approval when requested", async () => {
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
        allowTemporaryArtifact: true,
      }),
    ).resolves.toEqual({ approved: true });

    expect(approveOutsideWorkspaceAccess).not.toHaveBeenCalled();
  });
});

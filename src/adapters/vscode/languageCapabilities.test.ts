import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVscodeCodeActionsProvider,
  createVscodeCompletionsProvider,
  createVscodeDiagnosticsProvider,
  createVscodeHierarchyProvider,
  createVscodeHoverProvider,
  createVscodeInlayHintsProvider,
  createVscodeNavigationProvider,
  createVscodeReferencesProvider,
  createVscodeSymbolsProvider,
} from "./languageCapabilities.js";

const executeCommand = vi.hoisted(() => vi.fn());
const getDiagnostics = vi.hoisted(() => vi.fn());
const openTextDocument = vi.hoisted(() => vi.fn());
const showTextDocument = vi.hoisted(() => vi.fn());
const applyEdit = vi.hoisted(() => vi.fn());
const textDocuments = vi.hoisted(() => [] as Array<unknown>);
const resolveAndValidatePath = vi.hoisted(() => vi.fn());
const tryGetFirstWorkspaceRoot = vi.hoisted(() => vi.fn());
const getRelativePath = vi.hoisted(() => vi.fn());
const approveOutsideWorkspaceAccess = vi.hoisted(() => vi.fn());
const clearCachedCodeActions = vi.hoisted(() => vi.fn());
const getCachedCodeActions = vi.hoisted(() => vi.fn());
const setCachedCodeActions = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class Location {
    constructor(
      public uri: unknown,
      public range: unknown,
    ) {}
  }

  class Range {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  }

  class MarkdownString {
    constructor(public value: string) {}
  }

  return {
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    Position,
    Location,
    Range,
    MarkdownString,
    ViewColumn: { One: 1 },
    InlayHintKind: {
      Type: 1,
      Parameter: 2,
    },
    SymbolKind: {
      File: 0,
      Module: 1,
      Namespace: 2,
      Package: 3,
      Class: 4,
      Method: 5,
      Property: 6,
      Field: 7,
      Constructor: 8,
      Enum: 9,
      Interface: 10,
      Function: 11,
      Variable: 12,
      Constant: 13,
      String: 14,
      Number: 15,
      Boolean: 16,
      Array: 17,
      Object: 18,
      Key: 19,
      Null: 20,
      EnumMember: 21,
      Struct: 22,
      Event: 23,
      Operator: 24,
      TypeParameter: 25,
    },
    CompletionItemKind: {
      Text: 0,
      Method: 1,
      Function: 2,
      Constructor: 3,
      Field: 4,
      Variable: 5,
      Class: 6,
      Interface: 7,
      Module: 8,
      Property: 9,
      Unit: 10,
      Value: 11,
      Enum: 12,
      Keyword: 13,
      Snippet: 14,
      Color: 15,
      File: 16,
      Reference: 17,
      Folder: 18,
      EnumMember: 19,
      Constant: 20,
      Struct: 21,
      Event: 22,
      Operator: 23,
      TypeParameter: 24,
    },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    commands: { executeCommand },
    languages: { getDiagnostics },
    window: { showTextDocument },
    workspace: {
      applyEdit,
      openTextDocument,
      textDocuments,
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    },
  };
});

vi.mock("../../util/paths.js", () => ({
  getRelativePath,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
}));

vi.mock("../../tools/pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess,
}));

vi.mock("../../tools/codeActionCache.js", () => ({
  clearCachedCodeActions,
  getCachedCodeActions,
  setCachedCodeActions,
}));

function diagnostic({
  line,
  column,
  severity,
  message,
  source,
  code,
}: {
  line: number;
  column: number;
  severity: number;
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
}) {
  return {
    range: { start: { line, character: column } },
    severity,
    message,
    source,
    code,
  };
}

function textPayload(
  result: Awaited<
    ReturnType<
      ReturnType<typeof createVscodeDiagnosticsProvider>["getDiagnostics"]
    >
  >,
) {
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("createVscodeDiagnosticsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns workspace diagnostics in the legacy JSON shape", async () => {
    getDiagnostics.mockReturnValue([
      [
        { fsPath: "/workspace/src/file.ts" },
        [
          diagnostic({
            line: 1,
            column: 4,
            severity: 0,
            message: "Type mismatch",
            source: "typescript",
            code: { value: 2322 },
          }),
        ],
      ],
      [
        { fsPath: "/outside/other.ts" },
        [
          diagnostic({
            line: 0,
            column: 0,
            severity: 1,
            message: "Use const",
            source: "eslint",
            code: "prefer-const",
          }),
          diagnostic({
            line: 8,
            column: 2,
            severity: 2,
            message: "Informational diagnostic",
            code: 0,
          }),
        ],
      ],
    ]);

    const provider = createVscodeDiagnosticsProvider();
    const result = await provider.getDiagnostics({});

    expect(getDiagnostics).toHaveBeenCalledWith();
    expect(JSON.parse(textPayload(result))).toEqual([
      {
        file: "src/file.ts",
        diagnostics: [
          {
            line: 2,
            column: 5,
            severity: "error",
            message: "Type mismatch",
            source: "typescript",
            code: 2322,
          },
        ],
      },
      {
        file: "../outside/other.ts",
        diagnostics: [
          {
            line: 1,
            column: 1,
            severity: "warning",
            message: "Use const",
            source: "eslint",
            code: "prefer-const",
          },
          {
            line: 9,
            column: 3,
            severity: "info",
            message: "Informational diagnostic",
            code: 0,
          },
        ],
      },
    ]);
  });

  it("resolves a scoped path and applies severity and source filters", async () => {
    getDiagnostics.mockReturnValue([
      diagnostic({
        line: 2,
        column: 3,
        severity: 1,
        message: "Lint warning",
        source: "eslint-plugin",
      }),
      diagnostic({
        line: 4,
        column: 5,
        severity: 0,
        message: "TS error",
        source: "typescript",
      }),
      diagnostic({
        line: 6,
        column: 7,
        severity: 2,
        message: "Info",
        source: "eslint",
      }),
    ]);

    const provider = createVscodeDiagnosticsProvider();
    const result = await provider.getDiagnostics({
      path: "src/file.ts",
      severity: "warning,error",
      source: "eslint",
    });

    expect(resolveAndValidatePath).toHaveBeenCalledWith("src/file.ts");
    expect(getDiagnostics).toHaveBeenCalledWith({
      fsPath: "/workspace/src/file.ts",
    });
    expect(JSON.parse(textPayload(result))).toEqual([
      {
        file: "src/file.ts",
        diagnostics: [
          {
            line: 3,
            column: 4,
            severity: "warning",
            message: "Lint warning",
            source: "eslint-plugin",
          },
        ],
      },
    ]);
  });

  it("returns the scoped empty message when filters remove every diagnostic", async () => {
    getDiagnostics.mockReturnValue([
      diagnostic({
        line: 1,
        column: 1,
        severity: 1,
        message: "Lint warning",
        source: "eslint",
      }),
    ]);

    const provider = createVscodeDiagnosticsProvider();

    await expect(
      provider.getDiagnostics({ path: "src/file.ts", severity: "error" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "No diagnostics found for src/file.ts" }],
    });
  });

  it("returns the legacy empty messages", async () => {
    getDiagnostics.mockReturnValue([]);
    const provider = createVscodeDiagnosticsProvider();

    await expect(provider.getDiagnostics({})).resolves.toEqual({
      content: [{ type: "text", text: "No diagnostics found in workspace" }],
    });

    getDiagnostics.mockReturnValue([]);
    await expect(
      provider.getDiagnostics({ path: "src/empty.ts" }),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "No diagnostics found for src/empty.ts" },
      ],
    });
  });
});

describe("createVscodeNavigationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns definition locations and converts LocationLink results in the legacy shape", async () => {
    executeCommand.mockResolvedValue([
      {
        uri: { fsPath: "/workspace/src/target.ts" },
        range: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 12 },
        },
      },
      {
        targetUri: { fsPath: "/workspace/src/link-target.ts" },
        targetRange: {
          start: { line: 8, character: 0 },
          end: { line: 10, character: 1 },
        },
      },
    ]);

    const provider = createVscodeNavigationProvider({} as never, {} as never);
    const result = await provider.goToDefinition({
      path: "src/file.ts",
      line: 3,
      column: 5,
      sessionId: "session-1",
    });

    expect(resolveAndValidatePath).toHaveBeenCalledWith("src/file.ts");
    expect(openTextDocument).toHaveBeenCalledWith({
      fsPath: "/workspace/src/file.ts",
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeDefinitionProvider",
      { fsPath: "/workspace/src/file.ts" },
      { line: 2, character: 4 },
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      definitions: [
        {
          path: "src/target.ts",
          line: 5,
          column: 3,
          endLine: 5,
          endColumn: 13,
        },
        {
          path: "src/link-target.ts",
          line: 9,
          column: 1,
          endLine: 11,
          endColumn: 2,
        },
      ],
    });
  });

  it("returns tool-specific empty navigation messages", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeNavigationProvider({} as never, {} as never);

    await expect(
      provider.goToImplementation({
        path: "src/file.ts",
        line: 1,
        column: 1,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            implementations: [],
            message: "No implementation found",
          }),
        },
      ],
    });

    await expect(
      provider.goToTypeDefinition({
        path: "src/file.ts",
        line: 1,
        column: 1,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type_definitions: [],
            message: "No type definition found",
          }),
        },
      ],
    });
  });

  it("preserves outside-workspace access rejection passthrough", async () => {
    resolveAndValidatePath.mockReturnValue({
      absolutePath: "/outside/file.ts",
      inWorkspace: false,
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({
      approved: false,
      reason: "outside workspace",
    });
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const approvalPanel = {};
    const provider = createVscodeNavigationProvider(
      approvalManager as never,
      approvalPanel as never,
    );

    await expect(
      provider.goToDefinition({
        path: "/outside/file.ts",
        line: 1,
        column: 1,
        sessionId: "session-1",
      }),
    ).rejects.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            path: "/outside/file.ts",
            reason: "outside workspace",
          }),
        },
      ],
    });
    expect(approveOutsideWorkspaceAccess).toHaveBeenCalledWith(
      "/outside/file.ts",
      approvalManager,
      approvalPanel,
      "session-1",
    );
  });
});

describe("createVscodeReferencesProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns the legacy empty references shape", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeReferencesProvider({} as never, {} as never);

    await expect(
      provider.getReferences({
        path: "src/file.ts",
        line: 2,
        column: 3,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            total_references: 0,
            truncated: false,
            references: [],
          }),
        },
      ],
    });
  });

  it("keeps the declaration when include_declaration is omitted", async () => {
    executeCommand.mockResolvedValue([
      {
        uri: { fsPath: "/workspace/src/file.ts" },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 10 },
        },
      },
    ]);
    const provider = createVscodeReferencesProvider({} as never, {} as never);

    const result = await provider.getReferences({
      path: "src/file.ts",
      line: 2,
      column: 3,
      sessionId: "session-1",
    });

    expect(JSON.parse(textPayload(result))).toEqual({
      total_references: 1,
      truncated: false,
      references: [
        {
          path: "src/file.ts",
          line: 2,
          column: 1,
          endLine: 2,
          endColumn: 11,
        },
      ],
    });
  });

  it("filters the declaration when requested and serializes references", async () => {
    executeCommand.mockResolvedValue([
      {
        uri: { fsPath: "/workspace/src/file.ts" },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 10 },
        },
      },
      {
        uri: { fsPath: "/workspace/src/usage.ts" },
        range: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 8 },
        },
      },
    ]);
    const provider = createVscodeReferencesProvider({} as never, {} as never);

    const result = await provider.getReferences({
      path: "src/file.ts",
      line: 2,
      column: 3,
      sessionId: "session-1",
      include_declaration: false,
    });

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeReferenceProvider",
      { fsPath: "/workspace/src/file.ts" },
      { line: 1, character: 2 },
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      total_references: 1,
      truncated: false,
      references: [
        {
          path: "src/usage.ts",
          line: 5,
          column: 3,
          endLine: 5,
          endColumn: 9,
        },
      ],
    });
  });

  it("caps references at the legacy maximum and reports truncation", async () => {
    executeCommand.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        uri: { fsPath: `/workspace/src/ref-${index}.ts` },
        range: {
          start: { line: index, character: 0 },
          end: { line: index, character: 1 },
        },
      })),
    );
    const provider = createVscodeReferencesProvider({} as never, {} as never);

    const result = await provider.getReferences({
      path: "src/file.ts",
      line: 1,
      column: 1,
      sessionId: "session-1",
    });
    const payload = JSON.parse(textPayload(result));

    expect(payload.total_references).toBe(201);
    expect(payload.truncated).toBe(true);
    expect(payload.references).toHaveLength(200);
    expect(payload.references[199]).toMatchObject({ path: "src/ref-199.ts" });
  });

  it("preserves outside-workspace access rejection passthrough", async () => {
    resolveAndValidatePath.mockReturnValue({
      absolutePath: "/outside/file.ts",
      inWorkspace: false,
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({
      approved: false,
      reason: "outside workspace",
    });
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const approvalPanel = {};
    const provider = createVscodeReferencesProvider(
      approvalManager as never,
      approvalPanel as never,
    );

    await expect(
      provider.getReferences({
        path: "/outside/file.ts",
        line: 1,
        column: 1,
        sessionId: "session-1",
      }),
    ).rejects.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            path: "/outside/file.ts",
            reason: "outside workspace",
          }),
        },
      ],
    });
  });
});

describe("createVscodeSymbolsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns the legacy required-parameter error", async () => {
    const provider = createVscodeSymbolsProvider({} as never, {} as never);

    await expect(
      provider.getSymbols({ sessionId: "session-1" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Either 'path' (for document symbols) or 'query' (for workspace symbol search) is required",
          }),
        },
      ],
    });
  });

  it("returns nested document symbols in the legacy shape", async () => {
    executeCommand.mockResolvedValue([
      {
        name: "Example",
        kind: 4,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 8, character: 1 },
        },
        children: [
          {
            name: "method",
            kind: 5,
            range: {
              start: { line: 3, character: 2 },
              end: { line: 5, character: 3 },
            },
            children: [],
          },
        ],
      },
    ]);
    const provider = createVscodeSymbolsProvider({} as never, {} as never);

    const result = await provider.getSymbols({
      path: "src/file.ts",
      sessionId: "session-1",
    });

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeDocumentSymbolProvider",
      { fsPath: "/workspace/src/file.ts" },
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      mode: "document",
      path: "src/file.ts",
      symbols: [
        {
          name: "Example",
          kind: "class",
          line: 2,
          endLine: 9,
          children: [
            {
              name: "method",
              kind: "method",
              line: 4,
              endLine: 6,
              children: [],
            },
          ],
        },
      ],
    });
  });

  it("returns the legacy empty document symbols shape", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeSymbolsProvider({} as never, {} as never);

    await expect(
      provider.getSymbols({ path: "src/file.ts", sessionId: "session-1" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "document",
            path: "src/file.ts",
            symbols: [],
          }),
        },
      ],
    });
  });

  it("returns capped workspace symbols with truncation metadata", async () => {
    executeCommand.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        name: `Symbol${index}`,
        kind: 11,
        location: {
          uri: { fsPath: `/workspace/src/symbol-${index}.ts` },
          range: { start: { line: index, character: 0 } },
        },
        containerName: index === 0 ? "Container" : "",
      })),
    );
    const provider = createVscodeSymbolsProvider({} as never, {} as never);

    const result = await provider.getSymbols({
      query: "Symbol",
      sessionId: "session-1",
    });
    const rawPayload = textPayload(result);
    const payload = JSON.parse(rawPayload);

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeWorkspaceSymbolProvider",
      "Symbol",
    );
    expect(payload.mode).toBe("workspace");
    expect(payload.query).toBe("Symbol");
    expect(payload.total).toBe(101);
    expect(payload.truncated).toBe(true);
    expect(payload.symbols).toHaveLength(100);
    expect(payload.symbols[0]).toEqual({
      name: "Symbol0",
      kind: "function",
      path: "src/symbol-0.ts",
      line: 1,
      containerName: "Container",
    });
    expect(payload.symbols[1]).toEqual({
      name: "Symbol1",
      kind: "function",
      path: "src/symbol-1.ts",
      line: 2,
    });
    expect(rawPayload).toContain('"containerName":"Container"');
    expect(rawPayload).not.toContain('"containerName":null');
    expect(rawPayload).not.toContain('"containerName":undefined');
  });

  it("returns the legacy empty workspace symbols shape", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeSymbolsProvider({} as never, {} as never);

    await expect(
      provider.getSymbols({ query: "Missing", sessionId: "session-1" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: "workspace",
            query: "Missing",
            total: 0,
            symbols: [],
          }),
        },
      ],
    });
  });

  it("preserves outside-workspace access rejection passthrough", async () => {
    resolveAndValidatePath.mockReturnValue({
      absolutePath: "/outside/file.ts",
      inWorkspace: false,
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({
      approved: false,
      reason: "outside workspace",
    });
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const approvalPanel = {};
    const provider = createVscodeSymbolsProvider(
      approvalManager as never,
      approvalPanel as never,
    );

    await expect(
      provider.getSymbols({ path: "/outside/file.ts", sessionId: "session-1" }),
    ).rejects.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            path: "/outside/file.ts",
            reason: "outside workspace",
          }),
        },
      ],
    });
  });
});

describe("createVscodeHoverProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns combined hover text in the legacy shape", async () => {
    const { MarkdownString } = await import("vscode");
    executeCommand.mockResolvedValue([
      {
        contents: [
          new MarkdownString("**Type**: string"),
          { language: "ts", value: "const name: string" },
          "plain hover",
        ],
      },
      {
        contents: ["second hover"],
      },
    ]);
    const provider = createVscodeHoverProvider({} as never, {} as never);

    const result = await provider.getHover({
      path: "src/file.ts",
      line: 3,
      column: 5,
      sessionId: "session-1",
    });

    expect(resolveAndValidatePath).toHaveBeenCalledWith("src/file.ts");
    expect(openTextDocument).toHaveBeenCalledWith({
      fsPath: "/workspace/src/file.ts",
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeHoverProvider",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({ line: 2, character: 4 }),
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      hover:
        "**Type**: string\n---\n```ts\nconst name: string\n```\n---\nplain hover\n---\nsecond hover",
    });
  });

  it("returns the legacy empty hover shape", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeHoverProvider({} as never, {} as never);

    await expect(
      provider.getHover({
        path: "src/file.ts",
        line: 3,
        column: 5,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            hover: null,
            message: "No hover information available at this position",
          }),
        },
      ],
    });
  });
});

describe("createVscodeCompletionsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns capped completion items in the legacy shape", async () => {
    const { MarkdownString } = await import("vscode");
    executeCommand.mockResolvedValue({
      isIncomplete: true,
      items: [
        {
          label: "alpha",
          kind: 2,
          detail: "function alpha",
          documentation: new MarkdownString("a".repeat(205)),
          insertText: "alpha($1)",
        },
        {
          label: { label: "beta" },
          kind: 999,
          documentation: "beta docs",
          insertText: { value: "beta" },
        },
        {
          label: "gamma",
          insertText: "gammaValue",
        },
      ],
    });
    const provider = createVscodeCompletionsProvider({} as never, {} as never);

    const result = await provider.getCompletions({
      path: "src/file.ts",
      line: 3,
      column: 5,
      limit: 2,
      sessionId: "session-1",
    });

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeCompletionItemProvider",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({ line: 2, character: 4 }),
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      is_incomplete: true,
      total_items: 3,
      showing: 2,
      items: [
        {
          label: "alpha",
          kind: "function",
          detail: "function alpha",
          documentation: `${"a".repeat(200)}...`,
          insertText: "alpha($1)",
        },
        {
          label: "beta",
          kind: "unknown",
          documentation: "beta docs",
        },
      ],
    });
  });

  it("returns the legacy empty completions shape", async () => {
    executeCommand.mockResolvedValue(undefined);
    const provider = createVscodeCompletionsProvider({} as never, {} as never);

    await expect(
      provider.getCompletions({
        path: "src/file.ts",
        line: 3,
        column: 5,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            is_incomplete: false,
            total_items: 0,
            showing: 0,
            items: [],
          }),
        },
      ],
    });
  });
});

describe("createVscodeCodeActionsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    applyEdit.mockResolvedValue(true);
    textDocuments.length = 0;
    getCachedCodeActions.mockReturnValue(null);
    tryGetFirstWorkspaceRoot.mockReturnValue("/workspace");
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns the legacy empty code-actions shape and clears the session cache", async () => {
    executeCommand.mockResolvedValue(undefined);
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    await expect(
      provider.getCodeActions({
        path: "src/file.ts",
        line: 3,
        column: 5,
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            actions: [],
            message: "No code actions available",
          }),
        },
      ],
    });
    expect(clearCachedCodeActions).toHaveBeenCalledWith("session-1");
  });

  it("returns the legacy cache-miss result when applying without cached actions", async () => {
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    await expect(
      provider.applyCodeAction({ sessionId: "session-1", index: 0 }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "No cached code actions. Call get_code_actions first.",
          }),
        },
      ],
    });
  });

  it("returns the legacy invalid-index result for cached actions", async () => {
    getCachedCodeActions.mockReturnValue({
      path: "src/file.ts",
      line: 3,
      column: 5,
      actions: [{ title: "Fix issue" }],
    });
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    await expect(
      provider.applyCodeAction({ sessionId: "session-1", index: 2 }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Invalid index 2. Available: 0-0",
          }),
        },
      ],
    });
  });

  it("applies cached edits, saves dirty documents, executes commands, and clears the session cache", async () => {
    const save = vi.fn(async () => undefined);
    textDocuments.push({
      uri: { fsPath: "/workspace/src/file.ts" },
      isDirty: true,
      save,
    });
    const edit = {
      entries: vi.fn(() => [
        [{ fsPath: "/workspace/src/file.ts" }, [{ newText: "fixed" }]],
      ]),
    };
    getCachedCodeActions.mockReturnValue({
      path: "src/file.ts",
      line: 3,
      column: 5,
      actions: [
        {
          title: "Fix issue",
          kind: { value: "quickfix" },
          edit,
          command: { command: "do.fix", arguments: ["arg"] },
        },
      ],
    });
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    const result = await provider.applyCodeAction({
      sessionId: "session-1",
      index: 0,
    });

    expect(applyEdit).toHaveBeenCalledWith(edit);
    expect(save).toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith("do.fix", "arg");
    expect(clearCachedCodeActions).toHaveBeenCalledWith("session-1");
    expect(JSON.parse(textPayload(result))).toEqual({
      status: "applied",
      action: "Fix issue",
      kind: "quickfix",
      changed_files: ["src/file.ts"],
    });
  });

  it("rejects command actions targeting protected instruction files", async () => {
    getCachedCodeActions.mockReturnValue({
      path: "CLAUDE.md",
      line: 3,
      column: 5,
      actions: [
        {
          title: "Run protected command",
          command: { command: "do.protected" },
        },
      ],
    });
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    const result = await provider.applyCodeAction({
      sessionId: "session-1",
      index: 0,
    });

    expect(executeCommand).not.toHaveBeenCalledWith("do.protected");
    expect(JSON.parse(textPayload(result))).toEqual({
      status: "rejected",
      action: "Run protected command",
      reason:
        "Code action includes an executable command while targeting a protected instructions/memory file. Command side effects cannot be preflighted; use write_file/apply_diff with explicit user approval or propose_memory instead.",
      protected_files: ["CLAUDE.md"],
    });
  });

  it("rejects cached edits that modify protected instruction files", async () => {
    getCachedCodeActions.mockReturnValue({
      path: "src/file.ts",
      line: 3,
      column: 5,
      actions: [
        {
          title: "Edit protected file",
          edit: {
            entries: vi.fn(() => [
              [{ fsPath: "/workspace/.agentlink/memory.md" }, [{}]],
            ]),
          },
        },
      ],
    });
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    const result = await provider.applyCodeAction({
      sessionId: "session-1",
      index: 0,
    });

    expect(applyEdit).not.toHaveBeenCalled();
    expect(JSON.parse(textPayload(result))).toEqual({
      status: "rejected",
      action: "Edit protected file",
      reason:
        "Code action edits a protected instructions/memory file. Use write_file/apply_diff with explicit user approval or propose_memory instead.",
      protected_files: [".agentlink/memory.md"],
    });
  });

  it("serializes code actions, filters preferred actions, and updates the session cache", async () => {
    const edit = {
      entries: vi.fn(() => [
        [{ fsPath: "/workspace/src/a.ts" }, [{}, {}]],
        [{ fsPath: "/workspace/src/b.ts" }, [{}]],
      ]),
    };
    const preferredAction = {
      title: "Fix issue",
      kind: { value: "quickfix" },
      isPreferred: true,
      diagnostics: [
        { message: "broken", severity: 0 },
        { message: "warn", severity: 1 },
        { message: "info", severity: 2 },
      ],
      edit,
      command: { command: "do.fix" },
    };
    const nonPreferredAction = {
      title: "Other action",
      isPreferred: false,
    };
    executeCommand.mockResolvedValue([preferredAction, nonPreferredAction]);
    const provider = createVscodeCodeActionsProvider({} as never, {} as never);

    const result = await provider.getCodeActions({
      path: "src/file.ts",
      line: 3,
      column: 5,
      end_line: 4,
      end_column: 7,
      kind: "quickfix",
      only_preferred: true,
      sessionId: "session-1",
    });

    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeCodeActionProvider",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({
        start: expect.objectContaining({ line: 2, character: 4 }),
        end: expect.objectContaining({ line: 3, character: 6 }),
      }),
      "quickfix",
    );
    expect(setCachedCodeActions).toHaveBeenCalledWith("session-1", {
      path: "src/file.ts",
      line: 3,
      column: 5,
      actions: [preferredAction],
    });
    expect(JSON.parse(textPayload(result))).toEqual({
      actions: [
        {
          index: 0,
          title: "Fix issue",
          kind: "quickfix",
          preferred: true,
          fixes_diagnostics: [
            { message: "broken", severity: "error" },
            { message: "warn", severity: "warning" },
            { message: "info", severity: "info" },
          ],
          changes: { files: 2, edits: 3 },
          has_command: true,
        },
      ],
    });
  });
});

describe("createVscodeInlayHintsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
      lineCount: 10,
    });
    showTextDocument.mockResolvedValue(undefined);
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("shows the document, executes the provider over the requested range, and returns legacy serialized hints", async () => {
    executeCommand.mockResolvedValue([
      {
        position: { line: 1, character: 4 },
        label: ": string",
        kind: 1,
        paddingLeft: true,
      },
      {
        position: { line: 2, character: 8 },
        label: [{ value: "param" }, { value: ": " }],
        kind: 2,
        paddingRight: true,
      },
      {
        position: { line: 3, character: 0 },
        label: "unknown",
        kind: 999,
      },
    ]);
    const provider = createVscodeInlayHintsProvider({} as never, {} as never);

    const result = await provider.getInlayHints({
      path: "src/file.ts",
      start_line: 2,
      end_line: 20,
      sessionId: "session-1",
    });

    expect(resolveAndValidatePath).toHaveBeenCalledWith("src/file.ts");
    expect(openTextDocument).toHaveBeenCalledWith({
      fsPath: "/workspace/src/file.ts",
    });
    expect(showTextDocument).toHaveBeenCalledWith(
      { uri: { fsPath: "/workspace/src/file.ts" }, lineCount: 10 },
      expect.objectContaining({ preserveFocus: true, preview: true }),
    );
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeInlayHintProvider",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({
        start: expect.objectContaining({ line: 1, character: 0 }),
        end: expect.objectContaining({ line: 10, character: 0 }),
      }),
    );
    expect(JSON.parse(textPayload(result))).toEqual({
      hints: [
        {
          line: 2,
          column: 5,
          label: ": string",
          kind: "type",
          padding_left: true,
        },
        {
          line: 3,
          column: 9,
          label: "param: ",
          kind: "parameter",
          padding_right: true,
        },
        {
          line: 4,
          column: 1,
          label: "unknown",
          kind: "unknown",
        },
      ],
    });
  });

  it("uses the full document range by default and returns the legacy empty shape", async () => {
    executeCommand.mockResolvedValue([]);
    const provider = createVscodeInlayHintsProvider({} as never, {} as never);

    await expect(
      provider.getInlayHints({
        path: "src/file.ts",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            hints: [],
            message: "No inlay hints in this range",
          }),
        },
      ],
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeInlayHintProvider",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({
        start: expect.objectContaining({ line: 0, character: 0 }),
        end: expect.objectContaining({ line: 10, character: 0 }),
      }),
    );
  });
});

function hierarchyItem({
  name,
  kind = 11,
  path = "/workspace/src/target.ts",
  line = 1,
  column = 2,
  detail,
}: {
  name: string;
  kind?: number;
  path?: string;
  line?: number;
  column?: number;
  detail?: string;
}) {
  return {
    name,
    kind,
    uri: { fsPath: path },
    selectionRange: { start: { line, character: column } },
    detail,
  };
}

describe("createVscodeHierarchyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({
      uri: { fsPath: "/workspace/src/file.ts" },
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({ approved: true });
    getRelativePath.mockImplementation((absolutePath: string) =>
      absolutePath.replace("/workspace/", ""),
    );
    resolveAndValidatePath.mockImplementation((inputPath: string) => ({
      absolutePath: `/workspace/${inputPath}`,
      inWorkspace: true,
    }));
  });

  it("returns the legacy empty call hierarchy shape", async () => {
    executeCommand.mockResolvedValueOnce([]);
    const provider = createVscodeHierarchyProvider({} as never, {} as never);

    await expect(
      provider.getCallHierarchy({
        path: "src/file.ts",
        line: 3,
        column: 5,
        direction: "both",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: "No call hierarchy available at this position",
          }),
        },
      ],
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.prepareCallHierarchy",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({ line: 2, character: 4 }),
    );
  });

  it("returns incoming and outgoing call hierarchy in the legacy recursive shape", async () => {
    const root = hierarchyItem({ name: "root", detail: "root detail" });
    const incoming = hierarchyItem({ name: "caller", line: 4, column: 1 });
    const nestedIncoming = hierarchyItem({
      name: "grandCaller",
      line: 6,
      column: 3,
    });
    const outgoing = hierarchyItem({ name: "callee", line: 8, column: 5 });
    const nestedOutgoing = hierarchyItem({
      name: "grandCallee",
      line: 10,
      column: 7,
    });
    executeCommand.mockImplementation(
      async (command: string, item?: unknown) => {
        if (command === "vscode.prepareCallHierarchy") return [root];
        if (command === "vscode.provideIncomingCalls") {
          if (item === root) {
            return [
              {
                from: incoming,
                fromRanges: [{ start: { line: 20, character: 2 } }],
              },
            ];
          }
          if (item === incoming) {
            return [
              {
                from: nestedIncoming,
                fromRanges: [{ start: { line: 21, character: 4 } }],
              },
            ];
          }
          return [];
        }
        if (command === "vscode.provideOutgoingCalls") {
          if (item === root) {
            return [
              {
                to: outgoing,
                fromRanges: [{ start: { line: 30, character: 6 } }],
              },
            ];
          }
          if (item === outgoing) {
            return [
              {
                to: nestedOutgoing,
                fromRanges: [{ start: { line: 31, character: 8 } }],
              },
            ];
          }
          return [];
        }
        return [];
      },
    );
    const provider = createVscodeHierarchyProvider({} as never, {} as never);

    const result = await provider.getCallHierarchy({
      path: "src/file.ts",
      line: 3,
      column: 5,
      direction: "both",
      max_depth: 99,
      sessionId: "session-1",
    });

    expect(JSON.parse(textPayload(result))).toEqual({
      symbol: {
        name: "root",
        kind: "function",
        path: "src/target.ts",
        line: 2,
        column: 3,
        detail: "root detail",
      },
      incoming: [
        {
          from: {
            name: "caller",
            kind: "function",
            path: "src/target.ts",
            line: 5,
            column: 2,
          },
          call_sites: [{ line: 21, column: 3 }],
          incoming: [
            {
              from: {
                name: "grandCaller",
                kind: "function",
                path: "src/target.ts",
                line: 7,
                column: 4,
              },
              call_sites: [{ line: 22, column: 5 }],
            },
          ],
        },
      ],
      outgoing: [
        {
          to: {
            name: "callee",
            kind: "function",
            path: "src/target.ts",
            line: 9,
            column: 6,
          },
          call_sites: [{ line: 31, column: 7 }],
          outgoing: [
            {
              to: {
                name: "grandCallee",
                kind: "function",
                path: "src/target.ts",
                line: 11,
                column: 8,
              },
              call_sites: [{ line: 32, column: 9 }],
            },
          ],
        },
      ],
    });

    const incomingOnly = await provider.getCallHierarchy({
      path: "src/file.ts",
      line: 3,
      column: 5,
      direction: "incoming",
      max_depth: 1,
      sessionId: "session-1",
    });
    const incomingOnlyPayload = JSON.parse(textPayload(incomingOnly));
    expect(incomingOnlyPayload.incoming).toHaveLength(1);
    expect(incomingOnlyPayload).not.toHaveProperty("outgoing");
  });

  it("returns the legacy empty type hierarchy shape", async () => {
    executeCommand.mockResolvedValueOnce([]);
    const provider = createVscodeHierarchyProvider({} as never, {} as never);

    await expect(
      provider.getTypeHierarchy({
        path: "src/file.ts",
        line: 3,
        column: 5,
        direction: "both",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: "No type hierarchy available at this position",
          }),
        },
      ],
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.prepareTypeHierarchy",
      { fsPath: "/workspace/src/file.ts" },
      expect.objectContaining({ line: 2, character: 4 }),
    );
  });

  it("returns supertypes and subtypes in the legacy recursive shape", async () => {
    const root = hierarchyItem({
      name: "RootType",
      kind: 10,
      detail: "interface",
    });
    const supertype = hierarchyItem({ name: "BaseType", kind: 4, line: 4 });
    const nestedSupertype = hierarchyItem({
      name: "BaseBase",
      kind: 4,
      line: 5,
    });
    const subtype = hierarchyItem({ name: "ChildType", kind: 4, line: 6 });
    const nestedSubtype = hierarchyItem({
      name: "GrandChild",
      kind: 4,
      line: 7,
    });
    executeCommand.mockImplementation(
      async (command: string, item?: unknown) => {
        if (command === "vscode.prepareTypeHierarchy") return [root];
        if (command === "vscode.provideTypeHierarchySupertypes") {
          if (item === root) return [supertype];
          if (item === supertype) return [nestedSupertype];
          return [];
        }
        if (command === "vscode.provideTypeHierarchySubtypes") {
          if (item === root) return [subtype];
          if (item === subtype) return [nestedSubtype];
          return [];
        }
        return [];
      },
    );
    const provider = createVscodeHierarchyProvider({} as never, {} as never);

    const result = await provider.getTypeHierarchy({
      path: "src/file.ts",
      line: 3,
      column: 5,
      direction: "both",
      max_depth: 2,
      sessionId: "session-1",
    });

    expect(JSON.parse(textPayload(result))).toEqual({
      symbol: {
        name: "RootType",
        kind: "interface",
        path: "src/target.ts",
        line: 2,
        column: 3,
        detail: "interface",
      },
      supertypes: [
        {
          name: "BaseType",
          kind: "class",
          path: "src/target.ts",
          line: 5,
          column: 3,
          supertypes: [
            {
              name: "BaseBase",
              kind: "class",
              path: "src/target.ts",
              line: 6,
              column: 3,
            },
          ],
        },
      ],
      subtypes: [
        {
          name: "ChildType",
          kind: "class",
          path: "src/target.ts",
          line: 7,
          column: 3,
          subtypes: [
            {
              name: "GrandChild",
              kind: "class",
              path: "src/target.ts",
              line: 8,
              column: 3,
            },
          ],
        },
      ],
    });

    const supertypesOnly = await provider.getTypeHierarchy({
      path: "src/file.ts",
      line: 3,
      column: 5,
      direction: "supertypes",
      max_depth: 1,
      sessionId: "session-1",
    });
    const supertypesOnlyPayload = JSON.parse(textPayload(supertypesOnly));
    expect(supertypesOnlyPayload.supertypes).toHaveLength(1);
    expect(supertypesOnlyPayload).not.toHaveProperty("subtypes");
  });
});

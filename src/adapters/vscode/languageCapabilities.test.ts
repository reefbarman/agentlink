import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVscodeCompletionsProvider,
  createVscodeDiagnosticsProvider,
  createVscodeHoverProvider,
  createVscodeNavigationProvider,
  createVscodeReferencesProvider,
  createVscodeSymbolsProvider,
} from "./languageCapabilities.js";

const executeCommand = vi.hoisted(() => vi.fn());
const getDiagnostics = vi.hoisted(() => vi.fn());
const openTextDocument = vi.hoisted(() => vi.fn());
const resolveAndValidatePath = vi.hoisted(() => vi.fn());
const getRelativePath = vi.hoisted(() => vi.fn());
const approveOutsideWorkspaceAccess = vi.hoisted(() => vi.fn());

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
    MarkdownString,
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
    workspace: {
      openTextDocument,
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    },
  };
});

vi.mock("../../util/paths.js", () => ({
  getRelativePath,
  resolveAndValidatePath,
}));

vi.mock("../../tools/pathAccessUI.js", () => ({
  approveOutsideWorkspaceAccess,
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

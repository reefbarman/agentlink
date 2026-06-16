import type {
  ContextDocumentProvider,
  ContextEnrichmentProvider,
  ContextWorkingSetProvider,
} from "../../core/capabilities/readSearch.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkingSetStore } from "./WorkingSetStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const vscodeMock = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: { fsPath: string }; name: string }>,
  textDocuments: [] as Array<{
    uri: { scheme: string; fsPath: string };
    languageId: string;
  }>,
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  getDiagnostics: vi.fn(),
  getExtension: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: "file" }),
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    get textDocuments() {
      return vscodeMock.textDocuments;
    },
    openTextDocument: vscodeMock.openTextDocument,
  },
  commands: {
    executeCommand: vscodeMock.executeCommand,
  },
  languages: {
    getDiagnostics: vscodeMock.getDiagnostics,
  },
  extensions: {
    getExtension: vscodeMock.getExtension,
  },
  CompletionItemKind: {
    Text: 1,
    Method: 2,
    Function: 3,
    Constructor: 4,
    Field: 5,
    Variable: 6,
    Class: 7,
    Interface: 8,
    Module: 9,
    Property: 10,
    Unit: 11,
    Value: 12,
    Enum: 13,
    Keyword: 14,
    Snippet: 15,
    Color: 16,
    File: 17,
    Reference: 18,
    Folder: 19,
    EnumMember: 20,
    Constant: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25,
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
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
}));

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-get-context-"));
  tempDirs.push(dir);
  return dir;
}

function getText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const item = result.content[0];
  if (item?.type !== "text" || typeof item.text !== "string") {
    throw new Error("Expected text tool result");
  }
  return item.text;
}

function makeProviders(
  filePath: string,
  relPath: string,
  content: string,
  symbols: Record<string, string[]> | undefined = {
    class: ["Example (line 1)"],
    method: ["Example.run (line 2)"],
  },
): {
  documentProvider: ContextDocumentProvider;
  workingSetProvider: ContextWorkingSetProvider;
  enrichmentProvider: ContextEnrichmentProvider;
} {
  return {
    documentProvider: {
      async resolveDocument() {
        const currentContent = fs.readFileSync(filePath, "utf-8");
        const document = makeDocument(filePath, currentContent || content);
        return {
          absolutePath: filePath,
          relPath,
          languageId: document.languageId,
          hostDocument: { uri: document.uri, document },
        };
      },
    },
    workingSetProvider: new WorkingSetStore(),
    enrichmentProvider: {
      getGitStatus: vi.fn(() => undefined),
      getDocumentSymbols: vi.fn(async () => symbols),
      getDiagnosticsSummary: vi.fn(() => undefined),
    },
  };
}

function makeDocument(filePath: string, content: string) {
  const lines = content.split("\n");
  return {
    uri: { scheme: "file", fsPath: filePath },
    languageId: "typescript",
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("handleGetContext", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vscodeMock.textDocuments = [];
    vscodeMock.executeCommand.mockResolvedValue([
      {
        name: "Example",
        kind: 4,
        range: { start: { line: 0 }, end: { line: 2 } },
        children: [
          {
            name: "run",
            kind: 5,
            range: { start: { line: 1 }, end: { line: 1 } },
            children: [],
          },
        ],
      },
    ]);
    vscodeMock.getDiagnostics.mockReturnValue([]);
    vscodeMock.getExtension.mockReturnValue(undefined);
  });

  it("returns a compact context pack and tracks the first range as new", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const content = "class Example {\n  run() {}\n}\n";
    fs.writeFileSync(filePath, content);
    vscodeMock.workspaceFolders = [
      { uri: { fsPath: fs.realpathSync(workspace) }, name: "workspace" },
    ];
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, content),
    );

    const { handleGetContext } = await import("./getContext.js");
    const result = await handleGetContext(
      { path: "example.ts", limit: 2 },
      "session-1",
      makeProviders(filePath, "example.ts", content),
    );

    const payload = JSON.parse(getText(result));
    expect(payload).toMatchObject({
      path: "example.ts",
      total_lines: 4,
      showing: "1-2",
      truncated: true,
      language: "typescript",
      working_set: {
        status: "new",
        should_include_content: true,
        range: { startLine: 1, endLine: 2 },
      },
    });
    expect(payload.content).toBe("1 | class Example {\n2 |   run() {}");
    expect(payload.symbols).toMatchObject({
      class: ["Example (line 1)"],
      method: ["Example.run (line 2)"],
    });
  });

  it("groups VS Code document symbols in the context enrichment helper", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const content = "class Example {\n  constructor() {}\n}\n";
    fs.writeFileSync(filePath, content);
    const document = makeDocument(filePath, content);
    vscodeMock.executeCommand.mockResolvedValue([
      {
        name: "Example",
        kind: 4,
        range: { start: { line: 0 }, end: { line: 2 } },
        children: [
          {
            name: "constructor",
            kind: 8,
            range: { start: { line: 1 }, end: { line: 1 } },
            children: [],
          },
        ],
      },
    ]);

    const { getContextDocumentSymbols } = await import("./getContext.js");
    await expect(
      getContextDocumentSymbols({
        absolutePath: filePath,
        relPath: "example.ts",
        languageId: "typescript",
        hostDocument: { uri: document.uri, document },
      }),
    ).resolves.toMatchObject({
      class: ["Example (line 1)"],
      constructor: ["Example.constructor (line 2)"],
    });
  });

  it("skips JSON document symbols in the context enrichment helper", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "package.json");
    const content = '{"name":"example"}\n';
    fs.writeFileSync(filePath, content);
    const document = { ...makeDocument(filePath, content), languageId: "json" };

    const { getContextDocumentSymbols } = await import("./getContext.js");
    await expect(
      getContextDocumentSymbols({
        absolutePath: filePath,
        relPath: "package.json",
        languageId: "json",
        hostDocument: { uri: document.uri, document },
      }),
    ).resolves.toBeUndefined();
    expect(vscodeMock.executeCommand).not.toHaveBeenCalled();
  });

  it("summarizes diagnostics in the context enrichment helper", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const content = "const value = 1;\n";
    fs.writeFileSync(filePath, content);
    const document = makeDocument(filePath, content);
    vscodeMock.getDiagnostics.mockReturnValue([
      { severity: 0 },
      { severity: 1 },
      { severity: 1 },
      { severity: 2 },
    ]);

    const { getContextDiagnosticsSummary } = await import("./getContext.js");
    expect(
      getContextDiagnosticsSummary({
        absolutePath: filePath,
        relPath: "example.ts",
        languageId: "typescript",
        hostDocument: { uri: document.uri, document },
      }),
    ).toEqual({ errors: 1, warnings: 2 });
  });

  it("groups constructor symbols without colliding with Object.prototype", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const content = "class Example {\n  constructor() {}\n}\n";
    fs.writeFileSync(filePath, content);
    vscodeMock.workspaceFolders = [
      { uri: { fsPath: fs.realpathSync(workspace) }, name: "workspace" },
    ];
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, content),
    );
    vscodeMock.executeCommand.mockResolvedValue([
      {
        name: "Example",
        kind: 4,
        range: { start: { line: 0 }, end: { line: 2 } },
        children: [
          {
            name: "constructor",
            kind: 8,
            range: { start: { line: 1 }, end: { line: 1 } },
            children: [],
          },
        ],
      },
    ]);

    const { handleGetContext } = await import("./getContext.js");
    const result = await handleGetContext(
      { path: "example.ts" },
      "session-constructor-symbol",
      makeProviders(filePath, "example.ts", content, {
        class: ["Example (line 1)"],
        constructor: ["Example.constructor (line 2)"],
      }),
    );

    const payload = JSON.parse(getText(result));
    expect(payload.error).toBeUndefined();
    expect(payload.symbols).toMatchObject({
      class: ["Example (line 1)"],
      constructor: ["Example.constructor (line 2)"],
    });
  });

  it("omits unchanged content only when dedupe is enabled for the same returned range", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const content = "const one = 1;\nconst two = 2;\n";
    fs.writeFileSync(filePath, content);
    vscodeMock.workspaceFolders = [
      { uri: { fsPath: fs.realpathSync(workspace) }, name: "workspace" },
    ];
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, content),
    );

    const { handleGetContext } = await import("./getContext.js");
    const providers = makeProviders(filePath, "example.ts", content);
    await handleGetContext(
      { path: "example.ts", offset: 1, limit: 1 },
      "session-2",
      providers,
    );
    const result = await handleGetContext(
      {
        path: "example.ts",
        offset: 1,
        limit: 1,
        dedupe_unchanged_content: true,
      },
      "session-2",
      providers,
    );

    const payload = JSON.parse(getText(result));
    expect(payload.working_set).toMatchObject({
      status: "omitted_unchanged",
      should_include_content: false,
      range: { startLine: 1, endLine: 1 },
    });
    expect(payload.content).toBeUndefined();
  });

  it("renders content from the same disk snapshot used for the working-set hash", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const diskContent = "const value = 1;\n";
    const dirtyEditorContent = "const value = 999;\n";
    fs.writeFileSync(filePath, diskContent);
    vscodeMock.workspaceFolders = [
      { uri: { fsPath: fs.realpathSync(workspace) }, name: "workspace" },
    ];
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, dirtyEditorContent),
    );

    const { handleGetContext } = await import("./getContext.js");
    const result = await handleGetContext(
      { path: "example.ts" },
      "session-dirty-buffer",
      makeProviders(filePath, "example.ts", dirtyEditorContent),
    );

    const payload = JSON.parse(getText(result));
    expect(payload.content).toBe("1 | const value = 1;\n2 | ");
    expect(payload.content).not.toContain("999");
  });

  it("detects changed file contents between context calls", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "example.ts");
    const firstContent = "const value = 1;\n";
    const secondContent = "const value = 2;\n";
    fs.writeFileSync(filePath, firstContent);
    vscodeMock.workspaceFolders = [
      { uri: { fsPath: fs.realpathSync(workspace) }, name: "workspace" },
    ];
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, firstContent),
    );

    const { handleGetContext } = await import("./getContext.js");
    const providers = makeProviders(filePath, "example.ts", firstContent);
    const first = await handleGetContext(
      { path: "example.ts" },
      "session-3",
      providers,
    );

    fs.writeFileSync(filePath, secondContent);
    vscodeMock.openTextDocument.mockResolvedValue(
      makeDocument(filePath, secondContent),
    );
    const second = await handleGetContext(
      { path: "example.ts", dedupe_unchanged_content: true },
      "session-3",
      providers,
    );

    const firstPayload = JSON.parse(getText(first));
    const secondPayload = JSON.parse(getText(second));
    expect(secondPayload.working_set).toMatchObject({
      status: "changed",
      previous_content_hash: firstPayload.working_set.content_hash,
      should_include_content: true,
    });
    expect(secondPayload.working_set.content_hash).not.toBe(
      firstPayload.working_set.content_hash,
    );
  });
});

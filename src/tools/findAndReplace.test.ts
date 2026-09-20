import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MultiFileEditReviewProvider } from "../core/capabilities/editReview.js";

const mockWorkspace = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  openTextDocument: vi.fn(),
  findFiles: vi.fn(),
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class RelativePattern {
    constructor(
      public base: string,
      public pattern: string,
    ) {}
  }

  return {
    Position,
    RelativePattern,
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    workspace: mockWorkspace,
  };
});

describe("handleFindAndReplace", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-find-replace-")),
    );
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
    mockWorkspace.findFiles.mockReset();
    mockWorkspace.openTextDocument.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function toolJson(
    result: Awaited<
      ReturnType<typeof import("./findAndReplace.js").handleFindAndReplace>
    >,
  ) {
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    return JSON.parse(text) as Record<string, unknown>;
  }

  function createDocument(filePath: string, text: string) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") lineStarts.push(i + 1);
    }
    return {
      uri: { fsPath: filePath },
      getText: vi.fn(() => text),
      get lineCount() {
        return lineStarts.length;
      },
      positionAt: vi.fn((offset: number) => {
        let line = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          if (lineStarts[i] <= offset) line = i;
        }
        return new vscode.Position(line, offset - lineStarts[line]);
      }),
      lineAt: vi.fn((line: number) => {
        const start = lineStarts[line];
        const end =
          line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
        return { text: text.slice(start, end) };
      }),
    };
  }

  it("returns explicit unavailable after match computation when no multi-file provider exists", async () => {
    const filePath = path.join(workspaceDir, "src", "example.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old value", "utf-8");
    mockWorkspace.openTextDocument.mockResolvedValue(
      createDocument(filePath, "old value"),
    );
    const approvalManager = {
      isPathTrusted: vi.fn(() => true),
    };

    const { handleFindAndReplace } = await import("./findAndReplace.js");
    const result = await handleFindAndReplace(
      { path: "src/example.ts", find: "old", replace: "new" },
      approvalManager as never,
      {} as never,
      "session-1",
      {} as never,
    );

    expect(toolJson(result)).toMatchObject({
      error: "Multi-file edit review is unavailable in this runtime",
      reason: "edit_review_unavailable",
    });
  });

  it("skips only the read approval for outside agent instruction artifacts", async () => {
    const instructionPath = path.join(tempDir, "outside", "CLAUDE.md");
    fs.mkdirSync(path.dirname(instructionPath), { recursive: true });
    fs.writeFileSync(instructionPath, "old value", "utf-8");
    mockWorkspace.openTextDocument.mockResolvedValue(
      createDocument(instructionPath, "old value"),
    );
    const approvalManager = { isPathTrusted: vi.fn(() => false) };
    const reviewAndApply = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "review_required" }),
        },
      ],
    }));
    const { handleFindAndReplace } = await import("./findAndReplace.js");

    const result = await handleFindAndReplace(
      { path: instructionPath, find: "old", replace: "new" },
      approvalManager as never,
      {} as never,
      "session-instruction",
      {} as never,
      undefined,
      { multiFileEditReviewProvider: { reviewAndApply } },
    );

    expect(approvalManager.isPathTrusted).not.toHaveBeenCalled();
    expect(reviewAndApply).toHaveBeenCalledOnce();
    expect(toolJson(result)).toMatchObject({ status: "review_required" });
  });

  it("uses VS Code's default ignore behavior for glob searches", async () => {
    mockWorkspace.findFiles.mockResolvedValue([]);
    const { handleFindAndReplace } = await import("./findAndReplace.js");

    await handleFindAndReplace(
      { glob: "**/*.meta", find: "old", replace: "new" },
      { isPathTrusted: vi.fn(() => true) } as never,
      {} as never,
      "session-1",
      {} as never,
    );

    expect(mockWorkspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ base: workspaceDir, pattern: "**/*.meta" }),
      undefined,
      500,
    );
  });

  it.each([
    { find: "old", replace: "values ($1, $9)", expected: "values ($1, $9)" },
    { find: "(old)", replace: "$$1/$1/$$/$0/$9", expected: "$1/old/$/$0/$9" },
    { find: "(old)(missing)?", replace: "$1:$2:$3", expected: "old::$3" },
    { find: "(old)", replace: "$12/$123/$01", expected: "old2/old23/old" },
    { find: "(o)(l)(d)()()()()()()()()()", replace: "$12:$3", expected: ":d" },
    { find: "old", replace: "$&/$`/$'/$$", expected: "$&/$`/$'/$" },
    {
      find: "(old)",
      replace: "$$1/$1",
      expected: "$$1/$1",
      regex: false,
      text: "(old)",
    },
    { find: "(.+)", replace: "$1", expected: "$&$$1", text: "$&$$1" },
    {
      find: "(?<=prefix )(old)$",
      replace: "$1/$2",
      expected: "old/$2",
      text: "prefix old",
    },
    {
      find: "hashtextextended\\(\\$1, [146895]\\)",
      replace: "hashtextextended($1, 0)",
      expected: "hashtextextended($1, 0)",
      text: "hashtextextended($1, 6)",
    },
  ])(
    "preserves replacement semantics for $replace ($find)",
    async ({ find, replace, expected, regex = true, text = "old" }) => {
      const filePath = path.join(workspaceDir, "example.ts");
      mockWorkspace.openTextDocument.mockResolvedValue(
        createDocument(filePath, text),
      );
      const reviewAndApply = vi.fn<
        MultiFileEditReviewProvider["reviewAndApply"]
      >(async () => ({ content: [] }));
      const { handleFindAndReplace } = await import("./findAndReplace.js");
      await handleFindAndReplace(
        { path: "example.ts", find, replace, regex },
        { isPathTrusted: vi.fn(() => true) } as never,
        {} as never,
        "session-1",
        {} as never,
        undefined,
        { multiFileEditReviewProvider: { reviewAndApply } },
      );
      expect(reviewAndApply).toHaveBeenCalledOnce();
      const file = reviewAndApply.mock.calls[0][0].files[0];
      expect(file.replacements[0].newText).toBe(expected);
      expect(file.matches[0].replaceText).toBe(expected);
    },
  );

  it("matches regex line anchors on every line", async () => {
    const filePath = path.join(workspaceDir, "src", "example.meta");
    mockWorkspace.openTextDocument.mockResolvedValue(
      createDocument(filePath, "first  \nsecond\t\n"),
    );
    const provider: MultiFileEditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "applied" }),
          },
        ],
      })),
    };
    const { handleFindAndReplace } = await import("./findAndReplace.js");

    await handleFindAndReplace(
      { path: "src/example.meta", find: "[\\t ]+$", replace: "", regex: true },
      { isPathTrusted: vi.fn(() => true) } as never,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      { multiFileEditReviewProvider: provider },
    );

    expect(provider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({ totalMatches: 2 }),
    );
  });

  it("terminates after zero-width multiline anchor matches", async () => {
    const filePath = path.join(workspaceDir, "src", "example.meta");
    mockWorkspace.openTextDocument.mockResolvedValue(
      createDocument(filePath, "first\nsecond\n"),
    );
    const provider: MultiFileEditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "applied" }),
          },
        ],
      })),
    };
    const { handleFindAndReplace } = await import("./findAndReplace.js");

    await handleFindAndReplace(
      { path: "src/example.meta", find: "^", replace: "", regex: true },
      { isPathTrusted: vi.fn(() => true) } as never,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      { multiFileEditReviewProvider: provider },
    );

    expect(provider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({ totalMatches: 3 }),
    );
  });

  it("delegates computed matches and replacement offsets to the multi-file provider", async () => {
    const filePath = path.join(workspaceDir, "src", "example.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "before old after", "utf-8");
    mockWorkspace.openTextDocument.mockResolvedValue(
      createDocument(filePath, "before old after"),
    );
    const provider: MultiFileEditReviewProvider = {
      reviewAndApply: vi.fn(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "applied" }),
          },
        ],
      })),
    };

    const { handleFindAndReplace } = await import("./findAndReplace.js");
    const result = await handleFindAndReplace(
      { path: "src/example.ts", find: "old", replace: "new" },
      { isPathTrusted: vi.fn(() => true) } as never,
      {} as never,
      "session-1",
      {} as never,
      undefined,
      { multiFileEditReviewProvider: provider },
    );

    expect(toolJson(result)).toEqual({ status: "applied" });
    expect(provider.reviewAndApply).toHaveBeenCalledWith(
      expect.objectContaining({
        find: "old",
        replace: "new",
        isRegex: false,
        totalMatches: 1,
        sessionId: "session-1",
        files: [
          expect.objectContaining({
            absolutePath: filePath,
            relativePath: "src/example.ts",
            replacements: [
              {
                startOffset: 7,
                endOffset: 10,
                newText: "new",
                matchId: "0:0",
              },
            ],
            matches: [
              expect.objectContaining({
                id: "0:0",
                line: 1,
                columnStart: 7,
                columnEnd: 10,
                matchText: "old",
                replaceText: "new",
              }),
            ],
          }),
        ],
      }),
    );
  });
});

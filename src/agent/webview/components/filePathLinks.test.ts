import { describe, expect, it } from "vitest";

import { matchFilePaths } from "./filePathLinks";

describe("matchFilePaths", () => {
  it("matches absolute paths including the leading slash", () => {
    const text =
      "Open /home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md in the editor";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch:
          "/home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md",
        filePath:
          "/home/trist/workspace/openapi-generation/plans/arazzo-phase-0-5-generic-ast-refactor-plan.md",
        line: undefined,
        index: 5,
      },
    ]);
  });

  it("matches relative paths with line numbers", () => {
    const text =
      "Check src/agent/webview/components/MessageBubble.tsx:337 next";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "src/agent/webview/components/MessageBubble.tsx:337",
        filePath: "src/agent/webview/components/MessageBubble.tsx",
        line: 337,
        index: 6,
      },
    ]);
  });

  it("matches @-prefixed relative paths and strips @ from the opened file path", () => {
    const text = "Look at @src/agent/webview/components/InputArea.tsx next";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "@src/agent/webview/components/InputArea.tsx",
        filePath: "src/agent/webview/components/InputArea.tsx",
        line: undefined,
        index: 8,
      },
    ]);
  });

  it("matches @-prefixed relative paths with line numbers", () => {
    const text = "Look at @src/agent/webview/components/InputArea.tsx:42 next";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "@src/agent/webview/components/InputArea.tsx:42",
        filePath: "src/agent/webview/components/InputArea.tsx",
        line: 42,
        index: 8,
      },
    ]);
  });

  it("matches relative directory paths without requiring a file extension", () => {
    const text = "Open src/agent/webview/components/ in the Explorer";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "src/agent/webview/components/",
        filePath: "src/agent/webview/components/",
        line: undefined,
        index: 5,
      },
    ]);
  });

  it("matches @-prefixed directory paths and strips @ from the opened path", () => {
    const text = "Reveal @src/agent/webview/components in the Explorer";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "@src/agent/webview/components",
        filePath: "src/agent/webview/components",
        line: undefined,
        index: 7,
      },
    ]);
  });

  it("matches absolute directory paths", () => {
    const text = "Reveal /home/trist/workspace/agentlink/src/agent in Explorer";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "/home/trist/workspace/agentlink/src/agent",
        filePath: "/home/trist/workspace/agentlink/src/agent",
        line: undefined,
        index: 7,
      },
    ]);
  });

  it("does not include trailing punctuation in directory matches", () => {
    const text = "Reveal src/agent/webview/components, then continue";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: "src/agent/webview/components",
        filePath: "src/agent/webview/components",
        line: undefined,
        index: 7,
      },
    ]);
  });

  it("matches dotfile-rooted relative directory paths", () => {
    const text = "Reveal .github/workflows in the Explorer";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch: ".github/workflows",
        filePath: ".github/workflows",
        line: undefined,
        index: 7,
      },
    ]);
  });

  it("does not match casual slash-separated words as paths", () => {
    expect(matchFilePaths("Answer yes/no before continuing")).toEqual([]);
    expect(matchFilePaths("Pick red/green/blue for the theme")).toEqual([]);
  });

  it("does not match slash-separated dates as paths", () => {
    expect(matchFilePaths("Released on 2024/01/15 after testing")).toEqual([]);
  });

  it("does not include surrounding punctuation in the match prefix", () => {
    const text =
      "(/home/trist/workspace/native-claude/src/agent/webview/App.tsx)";

    expect(matchFilePaths(text)).toEqual([
      {
        fullMatch:
          "/home/trist/workspace/native-claude/src/agent/webview/App.tsx",
        filePath:
          "/home/trist/workspace/native-claude/src/agent/webview/App.tsx",
        line: undefined,
        index: 1,
      },
    ]);
  });

  it("does not match file-like suffixes inside urls", () => {
    expect(
      matchFilePaths("Visit https://github.com/org/repo/blob/main/src/foo.ts"),
    ).toEqual([]);
    expect(matchFilePaths("Visit https://example.com/foo/bar.ts")).toEqual([]);
  });

  it("returns no matches for plain text", () => {
    expect(matchFilePaths("just some normal chat text")).toEqual([]);
  });
});

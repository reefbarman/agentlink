import { describe, expect, it } from "vitest";

import path from "node:path";
import { readFileSync } from "node:fs";

const chatCss = readFileSync(path.resolve(__dirname, "chat.css"), "utf8");

function declarationsFor(selector: string): string[] {
  return Array.from(chatCss.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(([, selectors]) =>
      selectors
        ?.split(",")
        .map((candidate) => candidate.trim())
        .includes(selector),
    )
    .map(([, , declarations]) => declarations ?? "");
}

function hasDeclaration(
  declarations: string[],
  property: string,
  value: string,
) {
  const pattern = new RegExp(`(?:^|;)\\s*${property}:\\s*${value}\\s*(?:;|$)`);
  return declarations.some((block) => pattern.test(block));
}

describe("chat layout styles", () => {
  it("keeps editor-only controls inside the bounded root layout", () => {
    const root = declarationsFor("#root");
    const workspace = declarationsFor(".chat-workspace");
    const sessionPane = declarationsFor(".chat-session-pane");
    const editorActions = declarationsFor(".chat-editor-actions");

    expect(hasDeclaration(root, "display", "flex")).toBe(true);
    expect(hasDeclaration(root, "flex-direction", "column")).toBe(true);
    expect(hasDeclaration(root, "min-height", "0")).toBe(true);
    expect(hasDeclaration(workspace, "flex", "1")).toBe(true);
    expect(hasDeclaration(sessionPane, "flex", "1")).toBe(true);
    expect(hasDeclaration(editorActions, "flex-shrink", "0")).toBe(true);
    expect(hasDeclaration(workspace, "height", "100%")).toBe(false);
    expect(hasDeclaration(sessionPane, "height", "100%")).toBe(false);
  });
});

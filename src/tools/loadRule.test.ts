import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleLoadRule } from "./loadRule.js";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-load-rule-"));
  (
    vscode.workspace as unknown as { workspaceFolders: unknown[] }
  ).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<typeof handleLoadRule>>): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("handleLoadRule", () => {
  it("loads advertised rule files and strips frontmatter", async () => {
    const rulePath = path.join(tmpDir, ".agentlink", "rules", "typescript.md");
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(
      rulePath,
      "---\ndescription: TypeScript standards\n---\n# TypeScript standards\nUSE STRICT TYPES",
    );

    const result = await handleLoadRule(
      { path: ".agentlink/rules/typescript.md" },
      {} as never,
      {} as never,
      "session-1",
      [
        {
          source: ".agentlink/rules/typescript.md",
          filePath: rulePath,
          summary: "TypeScript standards",
        },
      ],
    );

    expect(JSON.parse(textOf(result))).toEqual({
      rule_name: ".agentlink/rules/typescript.md — TypeScript standards",
      rulePath: fs.realpathSync(rulePath),
      content: "# TypeScript standards\nUSE STRICT TYPES",
    });
  });

  it("rejects paths outside the advertised rule allowlist", async () => {
    const rulePath = path.join(tmpDir, ".agentlink", "rules", "security.md");
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, "# Security\nDO NOT LOAD");

    const result = await handleLoadRule(
      { path: ".agentlink/rules/security.md" },
      {} as never,
      {} as never,
      "session-1",
      [],
    );

    expect(JSON.parse(textOf(result))).toMatchObject({
      error:
        "Rule path is not in the current session's advertised rule allowlist",
      path: ".agentlink/rules/security.md",
    });
  });
});

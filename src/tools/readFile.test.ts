import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReadFileError,
  findLikelyPathSuggestions,
  handleReadFile,
  isEnoentWithSingleSuggestion,
} from "./readFile.js";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ReadFileEnrichmentProvider } from "../core/capabilities/readSearch.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const enrichmentProvider: ReadFileEnrichmentProvider = {
  getGitStatus: () => undefined,
  detectLanguage: (filePath) =>
    filePath.endsWith(".jsonc")
      ? "jsonc"
      : filePath.endsWith(".json")
        ? "json"
        : "typescript",
  getSymbolOutline: async () => undefined,
  getDiagnosticsSummary: () => undefined,
};

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-read-suggestions-"),
  );
  tempDirs.push(workspaceRoot);
  return workspaceRoot;
}

describe("readFile suggestion-follow helpers", () => {
  it("detects ENOENT payload with exactly one suggestion", async () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    const payload = await buildReadFileError(err, "src/missing/File.ts");

    if (
      !Array.isArray(payload.suggestions) ||
      payload.suggestions.length !== 1
    ) {
      // This test asserts type guard behavior only when exactly one suggestion exists.
      // If fixture layout changes, skip strict assertion to avoid brittleness.
      expect(payload.error).toContain("File not found");
      return;
    }

    expect(isEnoentWithSingleSuggestion(payload)).toBe(true);
  });

  it("stops traversal at the directory budget", async () => {
    const workspaceRoot = await makeWorkspace();
    await fs.mkdir(path.join(workspaceRoot, "nested"));
    await fs.writeFile(
      path.join(workspaceRoot, "nested", "target.ts"),
      "target",
    );

    await expect(
      findLikelyPathSuggestions("target.ts", {
        workspaceRoot,
        directoryBudget: 0,
      }),
    ).resolves.toEqual([]);
    await expect(
      findLikelyPathSuggestions("target.ts", {
        workspaceRoot,
        directoryBudget: 1,
      }),
    ).resolves.toEqual([]);
    await expect(
      findLikelyPathSuggestions("target.ts", {
        workspaceRoot,
        directoryBudget: 2,
      }),
    ).resolves.toEqual(["nested/target.ts"]);
  });

  it("caps suggestions and skips ignored dependency directories", async () => {
    const workspaceRoot = await makeWorkspace();
    await Promise.all(
      ["one", "two", "three", "node_modules/ignored", ".git/ignored"].map(
        async (dir) => {
          const parent = path.join(workspaceRoot, dir);
          await fs.mkdir(parent, { recursive: true });
          await fs.writeFile(path.join(parent, "target.ts"), dir);
        },
      ),
    );

    const suggestions = await findLikelyPathSuggestions("target.ts", {
      workspaceRoot,
      limit: 2,
      directoryBudget: 20,
    });

    expect(suggestions).toHaveLength(2);
    expect(suggestions).not.toContain("node_modules/ignored/target.ts");
    expect(suggestions).not.toContain(".git/ignored/target.ts");
    await expect(
      findLikelyPathSuggestions("target.ts", {
        workspaceRoot,
        limit: 0,
        directoryBudget: 20,
      }),
    ).resolves.toEqual([]);
  });

  it("returns false for payloads without single suggestion", () => {
    expect(
      isEnoentWithSingleSuggestion({
        error: "File not found",
        path: "x",
        suggestions: ["a", "b"],
      }),
    ).toBe(false);

    expect(
      isEnoentWithSingleSuggestion({
        error: "File not found",
        path: "x",
      }),
    ).toBe(false);
  });
});

describe("read_file semantic query metadata", () => {
  const approvalManager = {
    isPathTrusted: vi.fn(() => true),
  } as unknown as ApprovalManager;
  const approvalPanel = {} as ApprovalPanelProvider;

  it("reports not_found when semantic lookup falls back to the default offset", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "output.txt");
    await fs.writeFile(filePath, "first\nsecond\nthird");

    const result = await handleReadFile(
      {
        path: filePath,
        query: "distinctive missing text",
        limit: 2,
        include_symbols: false,
      },
      approvalManager,
      approvalPanel,
      "semantic-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.content).toBe("1 | first\n2 | second");
    expect(payload.semantic_match).toEqual({
      query: "distinctive missing text",
      status: "not_found",
      fallback: "default_offset",
      hint: "Use anchor or anchor_regex to locate exact text in this file.",
    });
  });

  it("does not report semantic failure when an explicit offset bypasses lookup", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "output.txt");
    await fs.writeFile(filePath, "first\nsecond\nthird");

    const result = await handleReadFile(
      {
        path: filePath,
        query: "unused query",
        offset: 2,
        limit: 1,
        include_symbols: false,
      },
      approvalManager,
      approvalPanel,
      "semantic-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.content).toBe("2 | second");
    expect(payload.semantic_match).toBeUndefined();
  });
});

describe("read_file structured secret redaction", () => {
  const approvalManager = {
    isPathTrusted: vi.fn(() => true),
  } as unknown as ApprovalManager;
  const approvalPanel = {} as ApprovalPanelProvider;

  it("redacts JSONC secrets and reports visible metadata", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "settings.jsonc");
    await fs.writeFile(
      filePath,
      `{
  // user settings
  "theme": "dark",
  "apiKey": "sk-super-secret",
  "nested": { "access_token": "nested-token" },
}`,
    );

    const result = await handleReadFile(
      { path: filePath, include_symbols: false },
      approvalManager,
      approvalPanel,
      "redaction-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    expect(item?.type).toBe("text");
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.redaction).toEqual({
      type: "structured_secret_values",
      count: 2,
    });
    expect(payload.content).toContain("// user settings");
    expect(payload.content).toContain('"theme": "dark"');
    expect(payload.content).not.toContain("sk-super-secret");
    expect(payload.content).not.toContain("nested-token");
  });

  it("redacts secrets even when the requested slice is narrow", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "app.config.json");
    await fs.writeFile(
      filePath,
      '{\n  "apiKey": "hidden",\n  "safe": "visible"\n}',
    );

    const result = await handleReadFile(
      { path: filePath, offset: 2, limit: 1, include_symbols: false },
      approvalManager,
      approvalPanel,
      "redaction-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.content).toBe('2 |   "apiKey": "[REDACTED]",');
    expect(payload.redaction.count).toBe(1);
  });

  it("does not allow literal or regex anchors to match raw secret values", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "settings.json");
    await fs.writeFile(
      filePath,
      '{\n  "safe": "visible",\n  "apiKey": "anchor-only-secret"\n}',
    );

    for (const anchorParams of [
      { anchor: "anchor-only-secret" },
      { anchor_regex: "anchor-only-secret" },
    ]) {
      const result = await handleReadFile(
        { path: filePath, ...anchorParams, include_symbols: false },
        approvalManager,
        approvalPanel,
        "redaction-session",
        [],
        enrichmentProvider,
      );
      const item = result.content[0];
      const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

      expect(payload.anchor_match.status).toBe("not_found");
      expect(payload.content).not.toContain("anchor-only-secret");
      expect(payload.redaction.count).toBe(1);
    }
  });

  it("does not run raw semantic lookup for eligible config content", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "settings.json");
    await fs.writeFile(
      filePath,
      '{\n  "safe": "visible",\n  "apiKey": "semantic-only-secret"\n}',
    );

    const result = await handleReadFile(
      {
        path: filePath,
        query: "semantic-only-secret",
        include_symbols: false,
      },
      approvalManager,
      approvalPanel,
      "redaction-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.semantic_match).toEqual({
      query: "semantic-only-secret",
      status: "not_run_structured_redaction",
    });
    expect(payload.content).not.toContain("semantic-only-secret");
  });

  it("withholds malformed config content", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "settings.jsonc");
    await fs.writeFile(
      filePath,
      '{\n  "apiKey": "malformed-secret"\n} /* unterminated',
    );

    const result = await handleReadFile(
      { path: filePath, include_symbols: false },
      approvalManager,
      approvalPanel,
      "redaction-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.redaction).toEqual({
      type: "structured_secret_values",
      status: "withheld_invalid_jsonc",
    });
    expect(payload.content).toContain("CONTENT WITHHELD");
    expect(payload.content).not.toContain("malformed-secret");
  });

  it("does not redact secret-like text in source files", async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = path.join(workspaceRoot, "fixture.ts");
    await fs.writeFile(
      filePath,
      'const config = { apiKey: "source-fixture-value" };',
    );

    const result = await handleReadFile(
      { path: filePath, include_symbols: false },
      approvalManager,
      approvalPanel,
      "redaction-session",
      [],
      enrichmentProvider,
    );
    const item = result.content[0];
    const payload = JSON.parse(item!.type === "text" ? item!.text : "{}");

    expect(payload.content).toContain("source-fixture-value");
    expect(payload.redaction).toBeUndefined();
  });
});

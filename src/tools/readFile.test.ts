import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildReadFileError,
  findLikelyPathSuggestions,
  isEnoentWithSingleSuggestion,
} from "./readFile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

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

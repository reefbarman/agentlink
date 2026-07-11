import * as path from "path";

import {
  DEFAULT_INDEX_EXCLUSIONS,
  IndexableFileDiscovery,
} from "./IndexableFileDiscovery.js";
import { describe, expect, it, vi } from "vitest";

const workspaceRoot = path.resolve("/workspace/project");
const file = (relativePath: string) => path.join(workspaceRoot, relativePath);

function createDiscovery(options?: {
  ignored?: string[];
  sizes?: Record<string, number>;
  directories?: string[];
  statErrors?: string[];
  discovered?: string[];
}) {
  const ignored = new Set(options?.ignored ?? []);
  const sizes = options?.sizes ?? {};
  const directories = new Set(options?.directories ?? []);
  const statErrors = new Set(options?.statErrors ?? []);
  const findFiles = vi.fn(async () => options?.discovered ?? []);
  const getGitIgnoredRelativePaths = vi.fn(async () => ignored);
  const statFile = vi.fn((filePath: string) => {
    if (statErrors.has(filePath)) throw new Error("stat failed");
    return {
      isFile: () => !directories.has(filePath),
      size: sizes[filePath] ?? 100,
    };
  });

  return {
    discovery: new IndexableFileDiscovery(vi.fn(), {
      findFiles,
      getGitIgnoredRelativePaths,
      statFile,
    }),
    findFiles,
    getGitIgnoredRelativePaths,
    statFile,
  };
}

describe("IndexableFileDiscovery", () => {
  it("discovers files with the configured exclusion pattern", async () => {
    const source = file("src/index.ts");
    const { discovery, findFiles } = createDiscovery({ discovered: [source] });

    await expect(
      discovery.discoverIndexableFiles(workspaceRoot, ["**/dist/**"]),
    ).resolves.toEqual([source]);
    expect(findFiles).toHaveBeenCalledWith(workspaceRoot, "{**/dist/**}");
  });

  it("filters excluded, external, empty, large, directory, and failed-stat paths", async () => {
    const source = file("src/index.ts");
    const empty = file("src/empty.ts");
    const large = file("src/large.ts");
    const directory = file("src/folder");
    const failed = file("src/missing.ts");
    const excluded = file("dist/output.js");
    const external = path.resolve("/workspace/other/file.ts");
    const { discovery, getGitIgnoredRelativePaths, statFile } = createDiscovery(
      {
        sizes: { [empty]: 0, [large]: 1_000_001 },
        directories: [directory],
        statErrors: [failed],
      },
    );

    await expect(
      discovery.filterIndexableFiles(
        [source, empty, large, directory, failed, excluded, external],
        workspaceRoot,
        ["**/dist/**"],
      ),
    ).resolves.toEqual([source]);
    expect(statFile).not.toHaveBeenCalledWith(excluded);
    expect(statFile).not.toHaveBeenCalledWith(external);
    expect(getGitIgnoredRelativePaths).toHaveBeenCalledWith(
      ["src/index.ts"],
      workspaceRoot,
    );
  });

  it("keeps only explicitly included ignored fixture paths and deduplicates them", async () => {
    const source = file("src/index.ts");
    const ordinaryIgnored = file("tmp/generated.ts");
    const fixture = file("fixtures/agent-eval-workspace/work/src/eval.ts");
    const { discovery, getGitIgnoredRelativePaths } = createDiscovery({
      ignored: [
        "tmp/generated.ts",
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ],
    });

    await expect(
      discovery.filterIndexableFiles(
        [source, ordinaryIgnored, fixture],
        workspaceRoot,
        [],
      ),
    ).resolves.toEqual([source, fixture]);
    expect(getGitIgnoredRelativePaths).toHaveBeenNthCalledWith(
      1,
      [
        "src/index.ts",
        "tmp/generated.ts",
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ],
      workspaceRoot,
    );
    expect(getGitIgnoredRelativePaths).toHaveBeenNthCalledWith(
      2,
      ["fixtures/agent-eval-workspace/work/src/eval.ts"],
      workspaceRoot,
    );
  });

  it("filters removed paths by relative and absolute exclusions without stat calls", async () => {
    const source = file("src/index.ts");
    const dist = file("dist/output.js");
    const exact = file("generated/output.ts");
    const external = path.resolve("/workspace/other/file.ts");
    const { discovery, statFile } = createDiscovery();

    await expect(
      discovery.filterExplicitlyIncludedRemovedPaths(
        [source, dist, exact, external],
        workspaceRoot,
        ["**/dist/**", exact.split(path.sep).join("/")],
      ),
    ).resolves.toEqual([source]);
    expect(statFile).not.toHaveBeenCalled();
  });

  it("exposes the existing default exclusion inventory", () => {
    expect(DEFAULT_INDEX_EXCLUSIONS).toContain("**/node_modules/**");
    expect(DEFAULT_INDEX_EXCLUSIONS).toContain("**/.agentlink/**");
    expect(DEFAULT_INDEX_EXCLUSIONS).toContain("**/*.map");
  });
});

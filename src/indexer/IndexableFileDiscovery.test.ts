import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEFAULT_INDEX_EXCLUSIONS,
  GitWorkspaceFileListing,
  IndexableFileDiscovery,
  getGitIgnoredRelativePaths,
  listGitWorkspaceFiles,
} from "./IndexableFileDiscovery.js";
import { describe, expect, it, vi } from "vitest";

import { execFileSync } from "child_process";

const workspaceRoot = path.resolve("/workspace/project");
const file = (relativePath: string) => path.join(workspaceRoot, relativePath);

function createDiscovery(options?: {
  ignored?: string[];
  sizes?: Record<string, number>;
  directories?: string[];
  statErrors?: string[];
  discovered?: string[];
  gitListing?: GitWorkspaceFileListing;
}) {
  const ignored = new Set(options?.ignored ?? []);
  const sizes = options?.sizes ?? {};
  const directories = new Set(options?.directories ?? []);
  const statErrors = new Set(options?.statErrors ?? []);
  const findFiles = vi.fn(async () => options?.discovered ?? []);
  const getGitIgnoredRelativePaths = vi.fn(async () => ignored);
  const listGitWorkspaceFiles = vi.fn(async () => options?.gitListing);
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
      listGitWorkspaceFiles,
      statFile,
    }),
    findFiles,
    getGitIgnoredRelativePaths,
    listGitWorkspaceFiles,
    statFile,
  };
}

describe("IndexableFileDiscovery", () => {
  it("discovers files with the configured exclusion pattern when git listing is unavailable", async () => {
    const source = file("src/index.ts");
    const { discovery, findFiles, listGitWorkspaceFiles } = createDiscovery({
      discovered: [source],
    });

    await expect(
      discovery.discoverIndexableFiles(workspaceRoot, ["**/dist/**"]),
    ).resolves.toEqual([source]);
    expect(listGitWorkspaceFiles).toHaveBeenCalledWith(workspaceRoot);
    expect(findFiles).toHaveBeenCalledWith(workspaceRoot, "{**/dist/**}");
  });

  it("discovers files from the git listing without workspace search or ignore checks", async () => {
    const source = file("src/index.ts");
    const fixture = file("fixtures/agent-eval-workspace/work/src/eval.ts");
    const { discovery, findFiles, getGitIgnoredRelativePaths } =
      createDiscovery({
        gitListing: {
          nonIgnoredRelativePaths: ["src/index.ts", "dist/output.js"],
          explicitlyIndexedIgnoredRelativePaths: [
            "fixtures/agent-eval-workspace/work/src/eval.ts",
          ],
        },
      });

    await expect(
      discovery.discoverIndexableFiles(workspaceRoot, ["**/dist/**"]),
    ).resolves.toEqual([source, fixture]);
    expect(findFiles).not.toHaveBeenCalled();
    expect(getGitIgnoredRelativePaths).not.toHaveBeenCalled();
  });

  it("applies stat filters to git-listed files", async () => {
    const source = file("src/index.ts");
    const empty = file("src/empty.ts");
    const large = file("src/large.ts");
    const { discovery } = createDiscovery({
      gitListing: {
        nonIgnoredRelativePaths: [
          "src/index.ts",
          "src/empty.ts",
          "src/large.ts",
        ],
        explicitlyIndexedIgnoredRelativePaths: [],
      },
      sizes: { [empty]: 0, [large]: 1_000_001 },
    });

    await expect(
      discovery.discoverIndexableFiles(workspaceRoot, []),
    ).resolves.toEqual([source]);
  });

  it("supports async statFile implementations", async () => {
    const source = file("src/index.ts");
    const statFile = vi.fn(async () => ({ isFile: () => true, size: 100 }));
    const discovery = new IndexableFileDiscovery(vi.fn(), {
      findFiles: async () => [],
      getGitIgnoredRelativePaths: async () => new Set<string>(),
      listGitWorkspaceFiles: async () => undefined,
      statFile,
    });

    await expect(
      discovery.filterIndexableFiles([source], workspaceRoot, []),
    ).resolves.toEqual([source]);
    expect(statFile).toHaveBeenCalledWith(source);
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

  it("rejects symlink escapes before stat and Git-ignore checks", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "discovery-paths-"),
    );
    try {
      const root = path.join(directory, "project");
      const outside = path.join(directory, "outside.ts");
      const alias = path.join(root, "src", "outside.ts");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.writeFileSync(outside, "outside", "utf8");
      fs.symlinkSync(outside, alias, "file");
      const { discovery, getGitIgnoredRelativePaths, statFile } =
        createDiscovery();

      await expect(
        discovery.filterIndexableFiles([alias], root, []),
      ).resolves.toEqual([]);
      expect(statFile).not.toHaveBeenCalled();
      expect(getGitIgnoredRelativePaths).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps explicitly included ignored skill and fixture paths", async () => {
    const source = file("src/index.ts");
    const ordinaryIgnored = file("tmp/generated.ts");
    const skill = file(".claude/skills/oss-upstream-sync/SKILL.md");
    const bundledSkillAsset = file(
      ".claude/skills/oss-upstream-sync/node_modules/vendor/index.min.js",
    );
    const fixture = file("fixtures/agent-eval-workspace/work/src/eval.ts");
    const { discovery, getGitIgnoredRelativePaths } = createDiscovery({
      ignored: [
        "tmp/generated.ts",
        ".claude/skills/oss-upstream-sync/SKILL.md",
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ],
    });

    await expect(
      discovery.filterIndexableFiles(
        [source, ordinaryIgnored, skill, bundledSkillAsset, fixture],
        workspaceRoot,
        DEFAULT_INDEX_EXCLUSIONS,
      ),
    ).resolves.toEqual([source, skill, fixture]);
    expect(getGitIgnoredRelativePaths).toHaveBeenNthCalledWith(
      1,
      [
        "src/index.ts",
        "tmp/generated.ts",
        ".claude/skills/oss-upstream-sync/SKILL.md",
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ],
      workspaceRoot,
    );
    expect(getGitIgnoredRelativePaths).toHaveBeenNthCalledWith(
      2,
      [
        ".claude/skills/oss-upstream-sync/SKILL.md",
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ],
      workspaceRoot,
    );
  });

  it("keeps explicitly indexed skill removals while preserving hard exclusions", async () => {
    const skill = file(".claude/skills/oss-upstream-sync/SKILL.md");
    const bundledSkillAsset = file(
      ".claude/skills/oss-upstream-sync/node_modules/vendor/index.min.js",
    );
    const { discovery, statFile } = createDiscovery();

    await expect(
      discovery.filterExplicitlyIncludedRemovedPaths(
        [skill, bundledSkillAsset],
        workspaceRoot,
        DEFAULT_INDEX_EXCLUSIONS,
      ),
    ).resolves.toEqual([skill]);
    expect(statFile).not.toHaveBeenCalled();
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

describe("git-backed enumeration (real repository)", () => {
  function createGitRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-git-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};", "utf8");
    fs.writeFileSync(path.join(root, "notes.md"), "untracked", "utf8");
    fs.writeFileSync(path.join(root, "ignored.log"), "ignored", "utf8");
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      "*.log\nfixtures/agent-eval-workspace/work/\n",
      "utf8",
    );
    const fixtureDir = path.join(
      root,
      "fixtures",
      "agent-eval-workspace",
      "work",
      "src",
    );
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "eval.ts"), "export {};", "utf8");
    execFileSync("git", ["add", "src/index.ts"], {
      cwd: root,
      stdio: "ignore",
    });
    return root;
  }

  it("lists tracked and untracked non-ignored files plus explicit ignored fixtures", async () => {
    const root = createGitRepo();
    try {
      const listing = await listGitWorkspaceFiles(root, vi.fn());
      expect(listing).toBeDefined();
      expect(listing?.nonIgnoredRelativePaths).toEqual(
        expect.arrayContaining([".gitignore", "notes.md", "src/index.ts"]),
      );
      expect(listing?.nonIgnoredRelativePaths).not.toContain("ignored.log");
      expect(listing?.explicitlyIndexedIgnoredRelativePaths).toEqual([
        "fixtures/agent-eval-workspace/work/src/eval.ts",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined outside a git work tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-nogit-"));
    try {
      const log = vi.fn();
      await expect(listGitWorkspaceFiles(root, log)).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("falling back to workspace search"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports ignored paths through chunked check-ignore", async () => {
    const root = createGitRepo();
    try {
      const ignored = await getGitIgnoredRelativePaths(
        ["ignored.log", "src/index.ts", "notes.md"],
        root,
        vi.fn(),
      );
      expect(ignored).toEqual(new Set(["ignored.log"]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

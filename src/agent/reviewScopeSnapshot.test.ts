import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { captureReviewScope } from "./reviewScopeSnapshot.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

async function createRepository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-scope-test-"));
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "test@example.com"]);
  await runGit(cwd, ["config", "user.name", "Review Scope Test"]);
  await fs.writeFile(path.join(cwd, "tracked.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(cwd, "staged.ts"), "export const staged = 1;\n");
  await runGit(cwd, ["add", "tracked.ts", "staged.ts"]);
  await runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

describe("captureReviewScope", () => {
  it("captures unstaged tracked changes and untracked file contents by default", async () => {
    const cwd = await createRepository();
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "export const value = 2;\n",
    );
    await fs.writeFile(
      path.join(cwd, "untracked.ts"),
      "export const untracked = true;\n",
    );
    await fs.writeFile(
      path.join(cwd, "staged.ts"),
      "export const staged = 2;\n",
    );
    await runGit(cwd, ["add", "staged.ts"]);

    const snapshot = await captureReviewScope(cwd, { kind: "working_tree" });

    expect(snapshot).toContain("Runtime-captured review scope");
    expect(snapshot).toContain("Unstaged tracked changes");
    expect(snapshot).toContain("+export const value = 2;");
    expect(snapshot).toContain("File: untracked.ts");
    expect(snapshot).toContain("export const untracked = true;");
    expect(snapshot).not.toContain("export const staged = 2;");
  });

  it("supports state and path filters for working-tree snapshots", async () => {
    const cwd = await createRepository();
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "export const value = 2;\n",
    );
    await fs.writeFile(
      path.join(cwd, "staged.ts"),
      "export const staged = 2;\n",
    );
    await runGit(cwd, ["add", "staged.ts"]);

    const snapshot = await captureReviewScope(cwd, {
      kind: "working_tree",
      include: ["staged"],
      paths: ["staged.ts"],
    });

    expect(snapshot).toContain("Staged changes");
    expect(snapshot).toContain("+export const staged = 2;");
    expect(snapshot).not.toContain("export const value = 2;");
  });

  it("captures exact current files without requiring Git state", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-files-test-"));
    await fs.writeFile(
      path.join(cwd, "standalone.ts"),
      "export const ok = true;\n",
    );

    const snapshot = await captureReviewScope(cwd, {
      kind: "files",
      paths: ["standalone.ts"],
    });

    expect(snapshot).toContain("Kind: files");
    expect(snapshot).toContain("File: standalone.ts");
    expect(snapshot).toContain("export const ok = true;");
  });

  it("captures absolute files across open workspace roots", async () => {
    const firstRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "review-files-first-"),
    );
    const secondRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "review-files-second-"),
    );
    const firstFile = path.join(firstRoot, "README.md");
    const secondFile = path.join(secondRoot, "README.md");
    await fs.writeFile(firstFile, "first root\n");
    await fs.writeFile(secondFile, "second root\n");

    const snapshot = await captureReviewScope(
      firstRoot,
      { kind: "files", paths: [firstFile, secondFile] },
      { workspaceRoots: [firstRoot, secondRoot] },
    );

    expect(snapshot).toContain(`File: ${await fs.realpath(firstFile)}`);
    expect(snapshot).toContain(`File: ${await fs.realpath(secondFile)}`);
    expect(snapshot).toContain("first root");
    expect(snapshot).toContain("second root");
  });

  it("captures an absolute working-tree path from its sibling Git root", async () => {
    const firstRoot = await createRepository();
    const secondRoot = await createRepository();
    const secondFile = path.join(secondRoot, "tracked.ts");
    await fs.writeFile(secondFile, "export const value = 2;\n");

    const snapshot = await captureReviewScope(
      firstRoot,
      { kind: "working_tree", paths: [secondFile] },
      { workspaceRoots: [firstRoot, secondRoot] },
    );

    expect(snapshot).toContain("Unstaged tracked changes");
    expect(snapshot).toContain("+export const value = 2;");
    expect(snapshot).toContain("Paths: tracked.ts");
  });

  it("rejects Git path filters spanning workspace roots with a files hint", async () => {
    const firstRoot = await createRepository();
    const secondRoot = await createRepository();

    await expect(
      captureReviewScope(
        firstRoot,
        {
          kind: "working_tree",
          paths: [
            path.join(firstRoot, "tracked.ts"),
            path.join(secondRoot, "tracked.ts"),
          ],
        },
        { workspaceRoots: [firstRoot, secondRoot] },
      ),
    ).rejects.toThrow(/cannot span multiple workspace roots.*kind "files"/);
  });

  it("accepts missing files beneath a symlinked workspace root", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "review-symlink-root-"),
    );
    const realRoot = path.join(parent, "real");
    const linkedRoot = path.join(parent, "linked");
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkedRoot);
    const missingPath = path.join(linkedRoot, "src", "missing.ts");

    const snapshot = await captureReviewScope(
      linkedRoot,
      { kind: "files", paths: [missingPath] },
      { workspaceRoots: [linkedRoot] },
    );

    expect(snapshot).toContain('File "src/missing.ts" is missing.');
  });

  it("rejects file scopes outside open roots with accepted guidance", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-path-test-"));

    await expect(
      captureReviewScope(
        cwd,
        { kind: "files", paths: ["../outside.ts"] },
        { workspaceRoots: [cwd] },
      ),
    ).rejects.toThrow(/outside the open workspace roots.*Accepted example/);
  });

  it("recommends file snapshots when working_tree has no Git repository", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-no-git-test-"));
    const filePath = path.join(cwd, "standalone.ts");
    await fs.writeFile(filePath, "export const value = 1;\n");

    await expect(
      captureReviewScope(cwd, {
        kind: "working_tree",
        paths: [filePath],
      }),
    ).rejects.toThrow(/not a Git repository.*kind "files"/);
  });

  it("drops excluded paths from working-tree captures with an explicit manifest entry", async () => {
    const cwd = await createRepository();
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "export const value = 2;\n",
    );
    await fs.writeFile(path.join(cwd, "asset.bin"), "binary-ish payload\n");

    const snapshot = await captureReviewScope(cwd, {
      kind: "working_tree",
      excludePaths: ["asset.bin"],
    });

    expect(snapshot).toContain("+export const value = 2;");
    expect(snapshot).toContain("Excluded paths: asset.bin");
    expect(snapshot).not.toContain("binary-ish payload");
  });

  it("captures large binary deletions as bounded Git metadata", async () => {
    const cwd = await createRepository();
    const binaryPath = path.join(cwd, "large.wasm");
    await fs.writeFile(binaryPath, Buffer.alloc(2_500_000, 0));
    await runGit(cwd, ["add", "large.wasm"]);
    await runGit(cwd, ["commit", "-m", "add binary"]);
    await fs.rm(binaryPath);

    const snapshot = await captureReviewScope(cwd, {
      kind: "working_tree",
      include: ["unstaged"],
    });

    expect(snapshot).toContain(
      "Binary files a/large.wasm and /dev/null differ",
    );
    expect(Buffer.byteLength(snapshot)).toBeLessThan(50_000);
    expect(snapshot).not.toContain("GIT binary patch");
  });

  it("applies excludes before buffering a large tracked diff", async () => {
    const cwd = await createRepository();
    const largePath = path.join(cwd, "generated", "large.txt");
    await fs.mkdir(path.dirname(largePath));
    await fs.writeFile(largePath, `${"a".repeat(2_200_000)}\n`);
    await runGit(cwd, ["add", "generated/large.txt"]);
    await runGit(cwd, ["commit", "-m", "add generated text"]);
    await fs.writeFile(largePath, `${"b".repeat(2_200_000)}\n`);
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "export const value = 2;\n",
    );

    const snapshot = await captureReviewScope(cwd, {
      kind: "working_tree",
      include: ["unstaged"],
      excludePaths: ["generated"],
    });

    expect(snapshot).toContain("+export const value = 2;");
    expect(snapshot).toContain("Excluded paths: generated");
    expect(snapshot).not.toContain("large.txt");
    expect(Buffer.byteLength(snapshot)).toBeLessThan(50_000);
  });

  it("records oversized files as metadata instead of rejecting the capture", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-large-test-"));
    await fs.writeFile(path.join(cwd, "small.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(cwd, "huge.png"), Buffer.alloc(1_100_000, 7));

    const snapshot = await captureReviewScope(cwd, {
      kind: "files",
      paths: ["small.ts", "huge.png"],
    });

    expect(snapshot).toContain("export const ok = 1;");
    expect(snapshot).toContain("Oversized file");
    expect(snapshot).toContain("1100000 bytes");
    expect(snapshot).toContain("content omitted");
  });

  it("names the largest captured files when the total capture exceeds the limit", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-limit-test-"));
    await fs.writeFile(path.join(cwd, "big-a.txt"), "a".repeat(600_000) + "\n");
    await fs.writeFile(path.join(cwd, "big-b.txt"), "b".repeat(600_000) + "\n");

    await expect(
      captureReviewScope(cwd, {
        kind: "files",
        paths: ["big-a.txt", "big-b.txt"],
      }),
    ).rejects.toThrow(/Largest captured items: big-[ab]\.txt \(\d+ bytes\)/);
  });

  it("selects the requested workspace root for multi-root working-tree captures", async () => {
    const firstRoot = await createRepository();
    const secondRoot = await createRepository();
    await fs.writeFile(
      path.join(secondRoot, "tracked.ts"),
      "export const value = 42;\n",
    );

    const snapshot = await captureReviewScope(
      firstRoot,
      { kind: "working_tree", root: secondRoot },
      { workspaceRoots: [firstRoot, secondRoot] },
    );

    expect(snapshot).toContain("+export const value = 42;");
    expect(snapshot).toContain(`Git root: ${await fs.realpath(secondRoot)}`);

    await expect(
      captureReviewScope(
        firstRoot,
        { kind: "working_tree", root: "/nonexistent/root" },
        { workspaceRoots: [firstRoot, secondRoot] },
      ),
    ).rejects.toThrow(/does not match an open workspace root/);
  });

  it("resolves commit ranges into diff snapshots", async () => {
    const cwd = await createRepository();
    const base = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
    await fs.writeFile(
      path.join(cwd, "tracked.ts"),
      "export const value = 3;\n",
    );
    await runGit(cwd, ["add", "tracked.ts"]);
    await runGit(cwd, ["commit", "-m", "change"]);

    const snapshot = await captureReviewScope(cwd, {
      kind: "commit_range",
      range: `${base}..HEAD`,
    });

    expect(snapshot).toContain(`Git range: ${base}..HEAD`);
    expect(snapshot).toContain("+export const value = 3;");
  });
});

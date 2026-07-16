import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { describe, expect, it } from "vitest";

import { captureReviewScope } from "./reviewScopeSnapshot.js";

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

  it("rejects file scopes outside the workspace", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-path-test-"));

    await expect(
      captureReviewScope(cwd, { kind: "files", paths: ["../outside.ts"] }),
    ).rejects.toThrow(/outside the workspace/);
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

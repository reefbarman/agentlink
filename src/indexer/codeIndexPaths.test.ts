import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CODE_INDEX_PATH_IDENTITY_VERSION,
  getContainedCodeIndexRelativePath,
  requireCanonicalPortableCodeIndexPath,
  resolveContainedCodeIndexPath,
} from "./codeIndexPaths.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalizePath } from "../util/canonicalPath.js";

describe("code-index path identity", () => {
  let directory: string;
  let workspaceRoot: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "code-index-paths-"));
    workspaceRoot = path.join(directory, "project");
    fs.mkdirSync(workspaceRoot);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function writeFile(relativePath: string): string {
    const absolutePath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, "content", "utf8");
    return absolutePath;
  }

  it("returns one native and portable identity for a nested file", () => {
    const absolutePath = writeFile(path.join("src", "index.ts"));

    expect(resolveContainedCodeIndexPath(workspaceRoot, absolutePath)).toEqual({
      absolutePath: canonicalizePath(absolutePath),
      relativePath: path.join("src", "index.ts"),
      portableRelativePath: "src/index.ts",
    });
    expect(CODE_INDEX_PATH_IDENTITY_VERSION).toBe(1);
  });

  it("rejects the root and sibling-prefix paths but accepts '..config.ts'", () => {
    const sibling = path.join(directory, "project-other", "index.ts");
    fs.mkdirSync(path.dirname(sibling));
    fs.writeFileSync(sibling, "content", "utf8");
    const dotDotName = writeFile("..config.ts");

    expect(
      resolveContainedCodeIndexPath(workspaceRoot, workspaceRoot),
    ).toBeUndefined();
    expect(
      resolveContainedCodeIndexPath(workspaceRoot, sibling),
    ).toBeUndefined();
    expect(
      resolveContainedCodeIndexPath(workspaceRoot, dotDotName),
    ).toMatchObject({
      relativePath: "..config.ts",
      portableRelativePath: "..config.ts",
    });
  });

  it("uses the physical target identity for a symlinked workspace root", () => {
    const target = writeFile(path.join("src", "linked.ts"));
    const rootAlias = path.join(directory, "workspace-alias");
    fs.symlinkSync(workspaceRoot, rootAlias, "dir");

    expect(
      resolveContainedCodeIndexPath(
        rootAlias,
        path.join(rootAlias, "src", "linked.ts"),
      ),
    ).toEqual({
      absolutePath: canonicalizePath(target),
      relativePath: path.join("src", "linked.ts"),
      portableRelativePath: "src/linked.ts",
    });
  });

  it("rejects an internal symlink whose physical target is outside", () => {
    const outside = path.join(directory, "outside.ts");
    fs.writeFileSync(outside, "outside", "utf8");
    const alias = path.join(workspaceRoot, "src", "outside.ts");
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(outside, alias, "file");

    expect(resolveContainedCodeIndexPath(workspaceRoot, alias)).toBeUndefined();
  });

  it("canonicalizes a deleted path through its nearest existing symlinked parent", () => {
    const physical = path.join(workspaceRoot, "physical");
    const alias = path.join(workspaceRoot, "alias");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias, "dir");
    const missing = path.join(alias, "deleted", "file.ts");

    expect(resolveContainedCodeIndexPath(workspaceRoot, missing)).toEqual({
      absolutePath: canonicalizePath(path.join(physical, "deleted", "file.ts")),
      relativePath: path.join("physical", "deleted", "file.ts"),
      portableRelativePath: "physical/deleted/file.ts",
    });
  });

  it("applies Windows case-insensitive containment without prefix matching", () => {
    expect(
      getContainedCodeIndexRelativePath(
        "C:\\Repo",
        "c:\\repo\\Src\\Index.ts",
        path.win32,
      ),
    ).toBe("Src\\Index.ts");
    expect(
      getContainedCodeIndexRelativePath("C:\\Repo", "c:\\repo", path.win32),
    ).toBeUndefined();
    expect(
      getContainedCodeIndexRelativePath(
        "C:\\Repo",
        "C:\\Repo-Other\\Index.ts",
        path.win32,
      ),
    ).toBeUndefined();
    expect(
      getContainedCodeIndexRelativePath(
        "C:\\Repo",
        "C:\\Outside\\Index.ts",
        path.win32,
      ),
    ).toBeUndefined();
    expect(
      getContainedCodeIndexRelativePath(
        "C:\\Repo",
        "D:\\Repo\\Index.ts",
        path.win32,
      ),
    ).toBeUndefined();
  });

  it.each([
    "",
    ".",
    "..",
    "../outside.ts",
    "src/../outside.ts",
    "src/./file.ts",
    "src//file.ts",
    "src\\file.ts",
    "/absolute.ts",
    "C:relative.ts",
    "C:\\absolute.ts",
  ])("rejects non-canonical portable path %j", (candidate) => {
    expect(() => requireCanonicalPortableCodeIndexPath(candidate)).toThrow(
      "Invalid code-index relative path",
    );
  });

  it("accepts a canonical portable path", () => {
    expect(requireCanonicalPortableCodeIndexPath("src/index.ts")).toBe(
      "src/index.ts",
    );
  });
});

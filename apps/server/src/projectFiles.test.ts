import { afterEach, describe, expect, it } from "vitest";

import { HttpError } from "./httpJson.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectFile } from "./projectFiles.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-files-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Agents\n");
  await fs.writeFile(path.join(root, "docs", "notes.md"), "notes");
  await fs.writeFile(path.join(dir, "secret.txt"), "secret");
  return { dir, root };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HttpError);
  const { status, code } = error as HttpError;
  return { status, code };
}

describe("readProjectFile", () => {
  it("reads relative and absolute paths inside the project", async () => {
    const { root } = await setup();
    expect(await readProjectFile(root, "AGENTS.md")).toEqual({
      path: "AGENTS.md",
      size: 9,
      content: "# Agents\n",
      truncated: false,
    });
    expect(
      await readProjectFile(root, path.join(root, "docs", "notes.md")),
    ).toMatchObject({ path: "docs/notes.md", content: "notes" });
    expect(await readProjectFile(root, "./docs/../AGENTS.md")).toMatchObject({
      path: "AGENTS.md",
    });
  });

  it("refuses paths that leave the project, including through symlinks", async () => {
    const { dir, root } = await setup();
    expect(await failure(readProjectFile(root, "../secret.txt"))).toEqual({
      status: 403,
      code: "outside_project",
    });
    // Outside absolute paths are refused whether or not they exist.
    expect(
      await failure(readProjectFile(root, path.join(dir, "secret.txt"))),
    ).toEqual({ status: 403, code: "outside_project" });
    expect(
      await failure(readProjectFile(root, path.join(dir, "missing.txt"))),
    ).toEqual({ status: 403, code: "outside_project" });
    await fs.symlink(path.join(dir, "secret.txt"), path.join(root, "link.txt"));
    expect(await failure(readProjectFile(root, "link.txt"))).toEqual({
      status: 403,
      code: "outside_project",
    });
  });

  it("explains missing, directory, binary, and invalid requests", async () => {
    const { root } = await setup();
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([1, 0, 2]));
    expect(await failure(readProjectFile(root, "nope.md"))).toEqual({
      status: 404,
      code: "file_not_found",
    });
    expect(await failure(readProjectFile(root, "docs"))).toEqual({
      status: 400,
      code: "not_a_file",
    });
    expect(await failure(readProjectFile(root, "image.bin"))).toEqual({
      status: 415,
      code: "binary_file",
    });
    expect(await failure(readProjectFile(root, "  "))).toEqual({
      status: 400,
      code: "path_invalid",
    });
    expect(await failure(readProjectFile(root, "a\0b"))).toEqual({
      status: 400,
      code: "path_invalid",
    });
  });

  it("returns the start of large files and says so", async () => {
    const { root } = await setup();
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(100));
    expect(await readProjectFile(root, "big.txt", 10)).toEqual({
      path: "big.txt",
      size: 100,
      content: "x".repeat(10),
      truncated: true,
    });
  });
});

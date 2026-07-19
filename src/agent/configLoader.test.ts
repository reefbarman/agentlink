import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  loadAllInstructionBlocks,
  resolveProjectActiveFilePath,
} from "./configLoader.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("project active-file containment", () => {
  it("accepts nested paths inside the project", async () => {
    const project = await tempDir("agentlink-config-project-");
    const activeFilePath = path.join(project, "src", "nested", "file.ts");

    await expect(
      resolveProjectActiveFilePath(project, activeFilePath),
    ).resolves.toEqual({ status: "accepted", activeFilePath });
  });

  it("rejects lexical outside and sibling-prefix paths", async () => {
    const parent = await tempDir("agentlink-config-parent-");
    const project = path.join(parent, "project");
    const sibling = path.join(parent, "project-other", "file.ts");
    await fs.mkdir(project);

    await expect(
      resolveProjectActiveFilePath(project, sibling),
    ).resolves.toEqual({ status: "ignored", reason: "outside_project" });
    await expect(
      resolveProjectActiveFilePath(
        project,
        path.join(project, "..", "outside.ts"),
      ),
    ).resolves.toEqual({ status: "ignored", reason: "outside_project" });
  });

  it("rejects symlink escapes and does not load escaped nested instructions", async () => {
    const project = await tempDir("agentlink-config-project-");
    const outside = await tempDir("agentlink-config-outside-");
    const linkedDir = path.join(project, "linked");
    await fs.symlink(outside, linkedDir, "dir");
    await fs.writeFile(path.join(outside, "AGENTS.md"), "OUTSIDE INSTRUCTIONS");
    const activeFilePath = path.join(linkedDir, "file.ts");

    await expect(
      resolveProjectActiveFilePath(project, activeFilePath),
    ).resolves.toEqual({ status: "ignored", reason: "symlink_escape" });

    const blocks = await loadAllInstructionBlocks(project, { activeFilePath });
    expect(
      blocks.some((block) => block.content.includes("OUTSIDE INSTRUCTIONS")),
    ).toBe(false);
  });

  it("loads nested instructions only from the selected project", async () => {
    const projectA = await tempDir("agentlink-config-a-");
    const projectB = await tempDir("agentlink-config-b-");
    const projectASrc = path.join(projectA, "src");
    const projectBSrc = path.join(projectB, "src");
    await fs.mkdir(projectASrc);
    await fs.mkdir(projectBSrc);
    await fs.writeFile(path.join(projectASrc, "AGENTS.md"), "PROJECT A NESTED");
    await fs.writeFile(path.join(projectBSrc, "AGENTS.md"), "PROJECT B NESTED");

    const blocks = await loadAllInstructionBlocks(projectA, {
      activeFilePath: path.join(projectB, "src", "file.ts"),
    });

    expect(
      blocks.some((block) => block.content.includes("PROJECT A NESTED")),
    ).toBe(false);
    expect(
      blocks.some((block) => block.content.includes("PROJECT B NESTED")),
    ).toBe(false);
  });
});

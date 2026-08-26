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

describe("project root instruction aliases", () => {
  it("loads a declared same-root instruction alias through a symlinked workspace root", async () => {
    const parent = await tempDir("agentlink-config-parent-");
    const project = path.join(parent, "project");
    const projectAlias = path.join(parent, "project-alias");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "CLAUDE.md"), "SHARED INSTRUCTIONS");
    await fs.symlink("CLAUDE.md", path.join(project, "AGENTS.md"));
    await fs.symlink(project, projectAlias, "dir");

    const blocks = await loadAllInstructionBlocks(projectAlias);

    expect(blocks).toContainEqual({
      source: "AGENTS.md",
      content: "SHARED INSTRUCTIONS",
    });
  });

  it("loads a declared same-root instruction alias", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.writeFile(path.join(project, "CLAUDE.md"), "SHARED INSTRUCTIONS");
    await fs.symlink("CLAUDE.md", path.join(project, "AGENTS.md"));

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks).toContainEqual({
      source: "AGENTS.md",
      content: "SHARED INSTRUCTIONS",
    });
  });

  it.each([
    ["external target", "external"],
    ["undeclared workspace file", "undeclared"],
    ["path-bearing declared target", "path-bearing"],
    ["missing declared target", "missing"],
    ["instruction symlink chain", "chain"],
  ])("ignores a root instruction alias with %s", async (_label, kind) => {
    const project = await tempDir("agentlink-config-project-");
    const instruction = path.join(project, "AGENTS.md");
    if (kind === "external") {
      const outside = await tempDir("agentlink-config-outside-");
      const target = path.join(outside, "AGENTS.md");
      await fs.writeFile(target, "EXTERNAL INSTRUCTIONS");
      await fs.symlink(target, instruction);
    } else if (kind === "undeclared") {
      await fs.writeFile(
        path.join(project, "README.md"),
        "README INSTRUCTIONS",
      );
      await fs.symlink("README.md", instruction);
    } else if (kind === "path-bearing") {
      await fs.writeFile(
        path.join(project, "CLAUDE.md"),
        "SHARED INSTRUCTIONS",
      );
      await fs.symlink("nested/../CLAUDE.md", instruction);
    } else if (kind === "missing") {
      await fs.symlink("CLAUDE.md", instruction);
    } else {
      await fs.writeFile(path.join(project, "AGENT.md"), "FINAL INSTRUCTIONS");
      await fs.symlink("AGENT.md", path.join(project, "CLAUDE.md"));
      await fs.symlink("CLAUDE.md", instruction);
    }

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks.some((block) => block.source === "AGENTS.md")).toBe(false);
    expect(
      blocks.some((block) =>
        /EXTERNAL|README INSTRUCTIONS/.test(block.content),
      ),
    ).toBe(false);
  });
});

describe("project AgentLink instructions", () => {
  it("loads .agentlink/AGENTS.md", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.mkdir(path.join(project, ".agentlink"));
    await fs.writeFile(
      path.join(project, ".agentlink", "AGENTS.md"),
      "AGENTLINK AGENTS",
    );

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks).toContainEqual({
      source: ".agentlink/AGENTS.md",
      content: "AGENTLINK AGENTS",
    });
  });

  it("falls back to .agentlink/CLAUDE.md", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.mkdir(path.join(project, ".agentlink"));
    await fs.writeFile(
      path.join(project, ".agentlink", "CLAUDE.md"),
      "AGENTLINK CLAUDE",
    );

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks).toContainEqual({
      source: ".agentlink/CLAUDE.md",
      content: "AGENTLINK CLAUDE",
    });
  });

  it("falls back to .agentlink/CLAUDE.md when AGENTS.md is empty", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.mkdir(path.join(project, ".agentlink"));
    await Promise.all([
      fs.writeFile(path.join(project, ".agentlink", "AGENTS.md"), ""),
      fs.writeFile(
        path.join(project, ".agentlink", "CLAUDE.md"),
        "AGENTLINK CLAUDE",
      ),
    ]);

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks).toContainEqual({
      source: ".agentlink/CLAUDE.md",
      content: "AGENTLINK CLAUDE",
    });
  });

  it("loads .agentlink/AGENTS.md after Claude instructions and before its rules", async () => {
    const project = await tempDir("agentlink-config-project-");
    await Promise.all([
      fs.mkdir(path.join(project, ".claude")),
      fs.mkdir(path.join(project, ".agentlink", "rules"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(project, ".claude", "CLAUDE.md"),
        "PROJECT CLAUDE",
      ),
      fs.writeFile(
        path.join(project, ".agentlink", "AGENTS.md"),
        "AGENTLINK AGENTS",
      ),
      fs.writeFile(
        path.join(project, ".agentlink", "rules", "test.md"),
        "RULE",
      ),
    ]);

    const blocks = await loadAllInstructionBlocks(project);
    const sources = blocks.map((block) => block.source);

    expect(sources.indexOf(".agentlink/AGENTS.md")).toBeGreaterThan(
      sources.indexOf(".claude/CLAUDE.md"),
    );
    expect(sources.indexOf(".agentlink/AGENTS.md")).toBeLessThan(
      sources.indexOf(".agentlink/rules/test.md"),
    );
  });

  it("prefers .agentlink/AGENTS.md when both files exist", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.mkdir(path.join(project, ".agentlink"));
    await Promise.all([
      fs.writeFile(
        path.join(project, ".agentlink", "AGENTS.md"),
        "AGENTLINK AGENTS",
      ),
      fs.writeFile(
        path.join(project, ".agentlink", "CLAUDE.md"),
        "AGENTLINK CLAUDE",
      ),
    ]);

    const blocks = await loadAllInstructionBlocks(project);

    expect(blocks).toContainEqual({
      source: ".agentlink/AGENTS.md",
      content: "AGENTLINK AGENTS",
    });
    expect(blocks).not.toContainEqual({
      source: ".agentlink/CLAUDE.md",
      content: "AGENTLINK CLAUDE",
    });
  });

  it("does not duplicate .agentlink/AGENTS.md for active files under .agentlink", async () => {
    const project = await tempDir("agentlink-config-project-");
    await fs.mkdir(path.join(project, ".agentlink", "skills", "test"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, ".agentlink", "AGENTS.md"),
      "AGENTLINK AGENTS",
    );

    const blocks = await loadAllInstructionBlocks(project, {
      activeFilePath: path.join(
        project,
        ".agentlink",
        "skills",
        "test",
        "SKILL.md",
      ),
    });

    expect(
      blocks.filter((block) => block.source === ".agentlink/AGENTS.md"),
    ).toHaveLength(1);
  });
});

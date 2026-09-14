import { describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceProject } from "./projectIdentity.js";

describe("resolveWorkspaceProject", () => {
  it("pins aliases to one canonical filesystem identity", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-project-"),
    );
    const project = path.join(parent, "project");
    const alias = path.join(parent, "alias");
    await fs.mkdir(project);
    await fs.symlink(project, alias);

    const direct = await resolveWorkspaceProject(project);
    const linked = await resolveWorkspaceProject(alias);

    expect(linked).toEqual(direct);
    expect(direct.root).toBe(await fs.realpath(project));
  });

  it("rejects a file as a project root", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-project-"),
    );
    const file = path.join(parent, "file.txt");
    await fs.writeFile(file, "text");

    await expect(resolveWorkspaceProject(file)).rejects.toThrow(
      "Project path is not a directory",
    );
  });
});

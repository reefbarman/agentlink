import {
  createNodeHostArtifactCatalog,
  createNodeHostInstructionResolver,
} from "./instructionCatalog.js";
import { describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

describe("node host instruction artifact catalog", () => {
  it("loads only explicit roots with ordered instruction and command precedence", async () => {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-artifacts-"),
    );
    const globalRoot = path.join(temp, "global");
    const projectRoot = path.join(temp, "project");
    await fs.mkdir(globalRoot);
    await fs.mkdir(projectRoot);
    await write(globalRoot, "AGENTS.md", "global instruction");
    await write(
      globalRoot,
      "rules/base.md",
      "---\ndescription: base\n---\nglobal rule",
    );
    await write(
      globalRoot,
      "skills/helper/SKILL.md",
      "---\nname: helper\ndescription: A safe helper\n---\nUse the helper.",
    );
    await write(globalRoot, "commands/review.md", "global review prompt");
    await write(projectRoot, "CLAUDE.md", "project instruction");
    await write(
      projectRoot,
      "commands/review.md",
      "---\ndescription: Review locally\n---\nproject review prompt",
    );

    const catalog = createNodeHostArtifactCatalog({
      roots: [
        { id: "global", scope: "global", rootPath: globalRoot },
        { id: "project", scope: "project", rootPath: projectRoot },
      ],
    });
    const snapshot = await catalog.snapshot();

    expect(snapshot.instructions.map((artifact) => artifact.content)).toEqual([
      "global instruction",
      "global rule",
      "project instruction",
    ]);
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: "helper", scope: "global" }),
    ]);
    expect(snapshot.commands).toEqual([
      expect.objectContaining({
        name: "review",
        scope: "project",
        description: "Review locally",
      }),
    ]);

    const resolver = createNodeHostInstructionResolver({
      identity: "Node test agent",
      resolveCatalog: () => catalog,
    });
    await expect(
      resolver({
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        session: {
          schemaVersion: 1,
          sessionId: "session-a",
          principal: { tenantId: "tenant-a", subjectId: "subject-a" },
          createdAt: 1,
          updatedAt: 1,
          messages: [],
          runState: { phase: "idle" },
        },
        turnId: "turn-a",
      }),
    ).resolves.toEqual({
      identity: "Node test agent",
      instructions: "global instruction\n\nglobal rule\n\nproject instruction",
    });

    await fs.rm(temp, { recursive: true, force: true });
  });

  it("fails closed for symlink escapes, malformed skills, and stale artifacts", async () => {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-artifacts-"),
    );
    const root = path.join(temp, "root");
    const outside = path.join(temp, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const outsideSkill = await write(
      outside,
      "escaped/SKILL.md",
      "---\nname: escaped\ndescription: outside\n---\nnot allowed",
    );
    await fs.mkdir(path.join(root, "skills"));
    await fs.symlink(
      path.dirname(outsideSkill),
      path.join(root, "skills", "escaped"),
    );
    await write(
      root,
      "skills/bad/SKILL.md",
      "---\nname: mismatched\ndescription: Broken\n---\nignored",
    );
    const command = await write(root, "commands/ok.md", "first version");

    const catalog = createNodeHostArtifactCatalog({
      roots: [{ id: "project", scope: "project", rootPath: root }],
    });
    const snapshot = await catalog.snapshot();
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsafe-symlink" }),
        expect.objectContaining({ code: "invalid-skill" }),
      ]),
    );
    const advertisedCommand = snapshot.commands[0]!;
    expect(
      await catalog.read({
        catalogRevision: snapshot.revision,
        id: "not-advertised",
        revision: advertisedCommand.revision,
      }),
    ).toEqual({ ok: false, reason: "artifact_not_advertised" });

    await fs.writeFile(command, "second version", "utf8");
    await expect(
      catalog.read({
        catalogRevision: snapshot.revision,
        id: advertisedCommand.id,
        revision: advertisedCommand.revision,
      }),
    ).resolves.toEqual({ ok: false, reason: "stale_advertised_artifact" });

    await fs.rm(temp, { recursive: true, force: true });
  });

  it("rejects non-absolute and duplicate host root identities", () => {
    expect(() =>
      createNodeHostArtifactCatalog({
        roots: [{ id: "relative", scope: "project", rootPath: "relative" }],
      }),
    ).toThrow(/absolute/i);
    expect(() =>
      createNodeHostArtifactCatalog({
        roots: [
          { id: "same", scope: "global", rootPath: "/global" },
          { id: "same", scope: "project", rootPath: "/project" },
        ],
      }),
    ).toThrow(/unique/i);
  });
});

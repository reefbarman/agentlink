import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgentPluginProjectDeclarationPath,
  readAgentPluginProjectDeclarations,
  resolveAgentPluginProjectDeclaration,
  upsertAgentPluginProjectDeclaration,
} from "./agentPluginProjectDeclarations.js";

import type { SessionProjectScope } from "../core/workspaceProjects.js";

function projectScope(
  rootPath: string,
  projectId = "project-a",
): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId,
    workspaceFolderUri: `file://${rootPath}`,
    displayName: projectId,
    rootPath,
  };
}

describe("agentPluginProjectDeclarations", () => {
  let directory: string;
  let workspace: string;
  let scope: SessionProjectScope;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-plugin-declarations-"),
    );
    workspace = path.join(directory, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    scope = projectScope(workspace);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("treats a missing file as an empty zero-authority declaration snapshot", async () => {
    const snapshot = await readAgentPluginProjectDeclarations(scope);

    expect(snapshot.declarations).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.declarationPath).toBe(
      path.join(workspace, ".agentlink", "plugins.json"),
    );
  });

  it("rejects malformed, duplicate, unknown, and authority-bearing declaration fields", async () => {
    const declarationPath = getAgentPluginProjectDeclarationPath(scope);
    await fs.mkdir(path.dirname(declarationPath), { recursive: true });
    await fs.writeFile(
      declarationPath,
      JSON.stringify({
        plugins: [
          {
            name: "fixture",
            source: { path: "plugins/fixture" },
            enabled: true,
          },
          {
            name: "fixture",
            source: {
              git: "https://example.test/plugin.git",
              commit: "a".repeat(40),
            },
          },
          {
            name: "fixture",
            source: {
              git: "https://example.test/plugin.git",
              commit: "a".repeat(40),
            },
          },
        ],
      }),
    );

    const snapshot = await readAgentPluginProjectDeclarations(scope);

    expect(snapshot.declarations).toHaveLength(1);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ code: "declaration_invalid_entry", index: 0 }),
      expect.objectContaining({ code: "declaration_invalid_entry", index: 2 }),
    ]);
    expect(JSON.stringify(snapshot.declarations)).not.toContain("enabled");
  });

  it("resolves paths only against their owning folder and rejects traversal and symlink escapes", async () => {
    const plugin = path.join(workspace, "plugins", "fixture");
    const outside = path.join(directory, "outside");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspace, "escape"));

    const available = await resolveAgentPluginProjectDeclaration(scope, {
      name: "fixture",
      source: { path: "plugins/fixture" },
    });
    const traversal = await resolveAgentPluginProjectDeclaration(scope, {
      name: "fixture",
      source: { path: "../outside" },
    });
    const escaped = await resolveAgentPluginProjectDeclaration(scope, {
      name: "fixture",
      source: { path: "escape/plugin" },
    });

    expect(available).toMatchObject({
      status: "available",
      source: {
        kind: "local-directory",
        path: await fs.realpath(plugin),
        workspaceRelativePath: "plugins/fixture",
      },
    });
    expect(traversal).toMatchObject({ status: "unavailable" });
    expect(escaped).toMatchObject({
      status: "unavailable",
      diagnostic: { message: expect.stringContaining("unsafe") },
    });
  });

  it("reports missing declared paths without creating or installing anything", async () => {
    const missing = path.join(workspace, "plugins", "missing");
    const result = await resolveAgentPluginProjectDeclaration(scope, {
      name: "fixture",
      source: { path: "plugins/missing" },
    });

    expect(result).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "declaration_source_unavailable" },
    });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps pinned Git declarations without persisting credentials or extra authority", async () => {
    const result = await resolveAgentPluginProjectDeclaration(scope, {
      name: "fixture",
      source: {
        git: "https://example.test/plugin.git",
        commit: "a".repeat(40),
      },
    });

    expect(result).toMatchObject({
      status: "available",
      source: {
        kind: "git",
        remote: "https://example.test/plugin.git",
        commit: "a".repeat(40),
      },
    });
  });

  it("atomically upserts declarations with revision checks and no gitignore mutation", async () => {
    const initial = await readAgentPluginProjectDeclarations(scope);
    const first = await upsertAgentPluginProjectDeclaration({
      scope,
      expectedRevision: initial.revision,
      declaration: { name: "one", source: { path: "plugins/one" } },
    });
    const second = await upsertAgentPluginProjectDeclaration({
      scope,
      expectedRevision: first.revision,
      declaration: {
        name: "two",
        source: {
          git: "https://example.test/two.git",
          commit: "b".repeat(40),
        },
      },
    });

    expect(second.declarations.map((item) => item.name)).toEqual([
      "one",
      "two",
    ]);
    const source = await fs.readFile(second.declarationPath, "utf8");
    expect(source).not.toMatch(/enabled|policy|approval|\/Users\//u);
    await expect(
      fs.stat(path.join(workspace, ".gitignore")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      upsertAgentPluginProjectDeclaration({
        scope,
        expectedRevision: initial.revision,
        declaration: { name: "three", source: { path: "plugins/three" } },
      }),
    ).rejects.toMatchObject({ code: "declaration_revision_conflict" });
  });
});

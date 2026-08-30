import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { AutonomousMemoryToolProvider } from "../storage/retrieval/AutonomousMemoryToolProvider.js";
import type { WorkspaceProject } from "@agentlink/protocol/workspace-project";
import { migrateLegacyMemoryFiles } from "./legacyMemoryMigration.js";

interface Fixture {
  home: string;
  projectA: string;
  projectB: string;
  store: string;
}

describe("legacy memory migration", () => {
  it("imports global then sorted workspaces and leaves source files byte-identical", async () => {
    await withFixture(async (fixture) => {
      const globalPath = path.join(fixture.home, ".agentlink", "memory.md");
      const projectAPath = path.join(
        fixture.projectA,
        ".agentlink",
        "memory.md",
      );
      const globalContent = "# Preferences\n\n- Prefer concise answers.\n";
      const projectContent = "# Gotchas\n\n- Run packaging inventory checks.\n";
      await writeSource(globalPath, globalContent);
      await writeSource(projectAPath, projectContent);
      const provider = providerFor(fixture.store);
      try {
        const result = await migrateLegacyMemoryFiles({
          provider,
          homeDirectory: fixture.home,
          projectCatalog: catalog([
            project("project-b", fixture.projectB),
            project("project-a", fixture.projectA),
          ]),
        });

        expect(result.imported).toHaveLength(2);
        expect(
          result.imported.map((entry) => entry.checkpoint.sourceKey),
        ).toEqual([
          "global:agentlink-user:memory.md",
          "workspace:project-a:memory.md",
        ]);
        expect(result.skippedMissing).toEqual([
          path.join(fixture.projectB, ".agentlink", "memory.md"),
        ]);
        expect(await fs.readFile(globalPath, "utf8")).toBe(globalContent);
        expect(await fs.readFile(projectAPath, "utf8")).toBe(projectContent);
        await expect(provider.health()).resolves.toMatchObject({
          status: "ready",
          recordCount: 2,
        });

        const rerun = await migrateLegacyMemoryFiles({
          provider,
          homeDirectory: fixture.home,
          projectCatalog: catalog([
            project("project-a", fixture.projectA),
            project("project-b", fixture.projectB),
          ]),
        });
        expect(rerun.imported.map((entry) => entry.status)).toEqual([
          "already-complete",
          "already-complete",
        ]);
        await expect(provider.health()).resolves.toMatchObject({
          recordCount: 2,
        });
      } finally {
        await provider.dispose();
      }
    });
  });

  it("records malformed source failure without blocking memory or modifying the file", async () => {
    await withFixture(async (fixture) => {
      const globalPath = path.join(fixture.home, ".agentlink", "memory.md");
      const content = "A fact.\n<!-- added yesterday -->\n";
      await writeSource(globalPath, content);
      const provider = providerFor(fixture.store);
      try {
        await expect(
          migrateLegacyMemoryFiles({
            provider,
            homeDirectory: fixture.home,
            projectCatalog: catalog([]),
          }),
        ).rejects.toThrow("Malformed legacy memory added date");
        expect(await fs.readFile(globalPath, "utf8")).toBe(content);
        await expect(provider.health()).resolves.toMatchObject({
          status: "degraded",
          crud: true,
          recordCount: 0,
          reason: "migration_blocked",
        });
      } finally {
        await provider.dispose();
      }
    });
  });

  it("continues importing later sources after an earlier source fails", async () => {
    await withFixture(async (fixture) => {
      const globalPath = path.join(fixture.home, ".agentlink", "memory.md");
      const projectPath = path.join(
        fixture.projectA,
        ".agentlink",
        "memory.md",
      );
      await writeSource(globalPath, "A fact.\n<!-- added yesterday -->\n");
      await writeSource(projectPath, "# Facts\n\n- Valid workspace fact.\n");
      const provider = providerFor(fixture.store);
      try {
        await expect(
          migrateLegacyMemoryFiles({
            provider,
            homeDirectory: fixture.home,
            projectCatalog: catalog([project("project-a", fixture.projectA)]),
          }),
        ).rejects.toThrow("Malformed legacy memory added date");
        await expect(provider.health()).resolves.toMatchObject({
          status: "degraded",
          crud: true,
          recordCount: 1,
          reason: "migration_blocked",
        });
      } finally {
        await provider.dispose();
      }
    });
  });

  it("imports an existing empty file and skips unavailable projects", async () => {
    await withFixture(async (fixture) => {
      const globalPath = path.join(fixture.home, ".agentlink", "memory.md");
      await writeSource(globalPath, "");
      const provider = providerFor(fixture.store);
      try {
        const unavailable: WorkspaceProject = {
          id: "project-unavailable",
          name: "Unavailable",
          uri: "file:///missing",
          availability: {
            status: "unavailable",
            reason: "root_unavailable",
            message: "Missing",
          },
        };
        const result = await migrateLegacyMemoryFiles({
          provider,
          homeDirectory: fixture.home,
          projectCatalog: catalog([unavailable]),
        });
        expect(result.imported).toMatchObject([
          {
            status: "imported",
            checkpoint: {
              sourceKey: "global:agentlink-user:memory.md",
              importedRecordIds: [],
            },
            results: [],
          },
        ]);
        expect(result.skippedMissing).toEqual([]);
      } finally {
        await provider.dispose();
      }
    });
  });
});

function providerFor(root: string): AutonomousMemoryToolProvider {
  return new AutonomousMemoryToolProvider({
    root,
    getMode: () => "autonomous",
  });
}

function project(id: string, rootPath: string): WorkspaceProject {
  return {
    id,
    name: id,
    uri: `file://${rootPath}`,
    rootPath,
    availability: { status: "available" },
  };
}

function catalog(projects: WorkspaceProject[]) {
  return { listProjects: () => projects };
}

async function writeSource(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function withFixture(
  operation: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-legacy-memory-migration-"),
  );
  const fixture = {
    home: path.join(root, "home"),
    projectA: path.join(root, "project-a"),
    projectB: path.join(root, "project-b"),
    store: path.join(root, "store"),
  };
  await Promise.all([
    fs.mkdir(fixture.home, { recursive: true }),
    fs.mkdir(fixture.projectA, { recursive: true }),
    fs.mkdir(fixture.projectB, { recursive: true }),
  ]);
  try {
    await operation(fixture);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

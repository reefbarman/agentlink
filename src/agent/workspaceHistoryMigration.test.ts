import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyWorkspaceHistoryTransition,
  hasPersistedWorkspaceHistory,
  migrateWorkspaceHistory,
  type WorkspaceHistoryShape,
} from "./workspaceHistoryMigration.js";

const tempDirectories: string[] = [];

function makeTempDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirectories.push(directory);
  return directory;
}

function shape(
  workspaceIdentity: string,
  workspaceFolderUris: string[],
): WorkspaceHistoryShape {
  return { workspaceIdentity, workspaceFolderUris };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("classifyWorkspaceHistoryTransition", () => {
  it("accepts only strict subset and superset folder transitions", () => {
    const single = shape("source", ["file:///workspace/app"]);
    const expanded = shape("destination", [
      "file:///workspace/api",
      "file:///workspace/app",
    ]);

    expect(classifyWorkspaceHistoryTransition(single, expanded)).toBe(
      "source_subset_of_destination",
    );
    expect(classifyWorkspaceHistoryTransition(expanded, single)).toBe(
      "destination_subset_of_source",
    );
    expect(classifyWorkspaceHistoryTransition(single, single)).toBe(
      "unrelated",
    );
    expect(
      classifyWorkspaceHistoryTransition(
        { ...single, workspaceFileUri: "file:///workspace/a.code-workspace" },
        { ...expanded, workspaceFileUri: "file:///workspace/b.code-workspace" },
      ),
    ).toBe("unrelated");
    expect(
      classifyWorkspaceHistoryTransition(single, {
        ...expanded,
        workspaceFileUri: "untitled:workspace-configuration",
      }),
    ).toBe("source_subset_of_destination");
    expect(
      classifyWorkspaceHistoryTransition(
        { ...single, workspaceFileUri: "file:///workspace/app.code-workspace" },
        {
          ...expanded,
          workspaceFileUri: "untitled:workspace-configuration",
        },
      ),
    ).toBe("unrelated");
    expect(
      classifyWorkspaceHistoryTransition(
        single,
        shape("other", ["file:///workspace/docs"]),
      ),
    ).toBe("unrelated");
  });
});

describe("hasPersistedWorkspaceHistory", () => {
  it("treats an auto-created empty legacy index as no history", () => {
    const directory = makeTempDirectory("agentlink-empty-history");
    fs.writeFileSync(path.join(directory, "sessions.json"), "[]\n", "utf-8");

    expect(hasPersistedWorkspaceHistory(directory, "legacy")).toBe(false);
  });

  it("detects non-empty, corrupt, and v2 history locations", () => {
    const nonEmpty = makeTempDirectory("agentlink-history-non-empty");
    fs.writeFileSync(
      path.join(nonEmpty, "sessions.json"),
      '[{"id":"session"}]\n',
      "utf-8",
    );
    const corrupt = makeTempDirectory("agentlink-history-corrupt");
    fs.writeFileSync(path.join(corrupt, "sessions.json"), "{", "utf-8");
    const lineage = makeTempDirectory("agentlink-history-lineage");

    expect(hasPersistedWorkspaceHistory(nonEmpty, "legacy")).toBe(true);
    expect(hasPersistedWorkspaceHistory(corrupt, "legacy")).toBe(true);
    expect(hasPersistedWorkspaceHistory(lineage, "lineage_v2")).toBe(true);
  });
});

describe("migrateWorkspaceHistory", () => {
  it("branches source history into a v2 lineage without changing the source", async () => {
    const sourceRoot = makeTempDirectory("agentlink-history-source");
    const destinationRoot = makeTempDirectory("agentlink-history-destination");
    const sourceHistory = path.join(sourceRoot, ".agentlink", "history");
    fs.mkdirSync(path.join(sourceHistory, "session-1"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceHistory, "sessions.json"),
      '[{"id":"session-1"}]\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceHistory, "session-1", "messages.json"),
      '{"messages":[]}\n',
      "utf-8",
    );
    const sourceBefore = fs.readFileSync(
      path.join(sourceHistory, "session-1", "messages.json"),
      "utf-8",
    );

    const progress: string[] = [];
    const result = await migrateWorkspaceHistory({
      source: shape("source-identity", ["file:///workspace/app"]),
      destination: shape("destination-identity", [
        "file:///workspace/app",
        "file:///workspace/docs",
      ]),
      sourceHistoryDirectory: sourceHistory,
      destinationAnchorRootPath: destinationRoot,
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toEqual(
      expect.arrayContaining([
        "Inspecting source history…",
        "Publishing migrated history…",
      ]),
    );
    expect(progress.some((message) => message.startsWith("Copying "))).toBe(
      true,
    );
    expect(result.lineage).toMatch(/^l-[a-f\d]{16}$/);
    expect(
      fs.readFileSync(
        path.join(result.historyDirectory, "sessions.json"),
        "utf-8",
      ),
    ).toBe('[{"id":"session-1"}]\n');
    expect(
      fs.readFileSync(
        path.join(sourceHistory, "session-1", "messages.json"),
        "utf-8",
      ),
    ).toBe(sourceBefore);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.workspaceRoot, "workspace.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      workspaceIdentity: "destination-identity",
      activeLineage: result.lineage,
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.historyDirectory, "lineage.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({
      sourceWorkspaceIdentity: "source-identity",
      kind: "import",
    });
  });

  it("retains non-empty legacy destination history as a rollback lineage", async () => {
    const sourceRoot = makeTempDirectory("agentlink-history-source");
    const destinationRoot = makeTempDirectory("agentlink-history-destination");
    const sourceHistory = path.join(sourceRoot, ".agentlink", "history");
    const destinationHistory = path.join(
      destinationRoot,
      ".agentlink",
      "history",
    );
    fs.mkdirSync(sourceHistory, { recursive: true });
    fs.mkdirSync(destinationHistory, { recursive: true });
    fs.writeFileSync(
      path.join(sourceHistory, "sessions.json"),
      "[]\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(destinationHistory, "sessions.json"),
      '[{"id":"destination"}]\n',
      "utf-8",
    );

    const result = await migrateWorkspaceHistory({
      source: shape("source-identity", ["file:///workspace/app"]),
      destination: shape("destination-identity", [
        "file:///workspace/app",
        "file:///workspace/docs",
      ]),
      sourceHistoryDirectory: sourceHistory,
      destinationAnchorRootPath: destinationRoot,
      destinationLegacyHistoryDirectory: destinationHistory,
    });

    expect(result.rollbackLineage).toMatch(/^l-[a-f\d]{16}$/);
    const rollbackDirectory = path.join(
      result.workspaceRoot,
      result.rollbackLineage!,
    );
    expect(
      fs.readFileSync(path.join(rollbackDirectory, "sessions.json"), "utf-8"),
    ).toBe('[{"id":"destination"}]\n');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.workspaceRoot, "workspace.json"),
          "utf-8",
        ),
      ).previousLineages,
    ).toContain(result.rollbackLineage);
  });

  it("does not copy sibling legacy namespaces from a single-folder source", async () => {
    const sourceRoot = makeTempDirectory("agentlink-history-source");
    const destinationRoot = makeTempDirectory("agentlink-history-destination");
    const sourceHistory = path.join(sourceRoot, ".agentlink", "history");
    fs.mkdirSync(path.join(sourceHistory, "workspace-0123456789abcdef"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sourceHistory, "sessions.json"),
      "[]\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceHistory, "workspace-0123456789abcdef", "sessions.json"),
      '[{"id":"unrelated"}]\n',
      "utf-8",
    );

    const result = await migrateWorkspaceHistory({
      source: shape("source-identity", ["file:///workspace/app"]),
      destination: shape("destination-identity", [
        "file:///workspace/app",
        "file:///workspace/docs",
      ]),
      sourceHistoryDirectory: sourceHistory,
      destinationAnchorRootPath: destinationRoot,
    });

    expect(
      fs.existsSync(
        path.join(
          result.historyDirectory,
          "workspace-0123456789abcdef",
          "sessions.json",
        ),
      ),
    ).toBe(false);
  });

  it("rejects an empty source history before changing a destination pointer", async () => {
    const sourceRoot = makeTempDirectory("agentlink-history-source");
    const destinationRoot = makeTempDirectory("agentlink-history-destination");
    const sourceHistory = path.join(sourceRoot, ".agentlink", "history");
    fs.mkdirSync(sourceHistory, { recursive: true });

    await expect(
      migrateWorkspaceHistory({
        source: shape("source-identity", ["file:///workspace/app"]),
        destination: shape("destination-identity", [
          "file:///workspace/app",
          "file:///workspace/docs",
        ]),
        sourceHistoryDirectory: sourceHistory,
        destinationAnchorRootPath: destinationRoot,
      }),
    ).rejects.toThrow("no persisted history");
    expect(
      fs.existsSync(
        path.join(
          destinationRoot,
          ".agentlink",
          "workspaces",
          "ws-destination-iden",
          "workspace.json",
        ),
      ),
    ).toBe(false);
  });

  it("rejects a symlinked source entry before publishing a destination pointer", async () => {
    const sourceRoot = makeTempDirectory("agentlink-history-source");
    const destinationRoot = makeTempDirectory("agentlink-history-destination");
    const sourceHistory = path.join(sourceRoot, ".agentlink", "history");
    fs.mkdirSync(sourceHistory, { recursive: true });
    fs.symlinkSync(
      path.join(sourceRoot, "outside"),
      path.join(sourceHistory, "escape"),
    );

    await expect(
      migrateWorkspaceHistory({
        source: shape("source-identity", ["file:///workspace/app"]),
        destination: shape("destination-identity", [
          "file:///workspace/app",
          "file:///workspace/docs",
        ]),
        sourceHistoryDirectory: sourceHistory,
        destinationAnchorRootPath: destinationRoot,
      }),
    ).rejects.toThrow("rejects symbolic links");
    expect(
      fs.existsSync(
        path.join(
          destinationRoot,
          ".agentlink",
          "workspaces",
          "ws-destination-iden",
          "workspace.json",
        ),
      ),
    ).toBe(false);
  });
});

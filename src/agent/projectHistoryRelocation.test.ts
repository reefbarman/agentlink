import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";

import { normalizeWorkspaceProjectUri } from "../adapters/vscode/workspaceProjectCapabilities.js";
import { createWorkspaceProjectId } from "../core/workspaceProjects.js";
import {
  findProjectHistoryRelocationCandidates,
  planProjectHistoryRelocation,
  relocateProjectHistory,
  type ProjectHistoryRelocationRequest,
} from "./projectHistoryRelocation.js";
import { recordProjectLocation } from "./projectLocationMarker.js";
import { resolveWorkspaceSessionLocation } from "./workspaceSessionIdentity.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeWorkspaceParent(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "history-relocation-")),
  );
  tempDirectories.push(directory);
  return directory;
}

function fileUri(rootPath: string) {
  return {
    scheme: "file",
    authority: "",
    path: rootPath,
    fsPath: rootPath,
    toString: () => pathToFileURL(rootPath).href,
  };
}

function scopeFor(rootPath: string): SessionProjectScope {
  const uri = normalizeWorkspaceProjectUri(fileUri(rootPath));
  return {
    schemaVersion: 1,
    kind: "project",
    projectId: createWorkspaceProjectId(uri),
    workspaceFolderUri: uri,
    displayName: path.basename(rootPath),
    rootPath,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeSessions(
  historyDirectory: string,
  sessions: { id: string; scope?: SessionProjectScope; resource?: string }[],
): void {
  writeJson(
    path.join(historyDirectory, "sessions.json"),
    sessions.map(({ id, scope }) => ({
      id,
      title: id,
      ...(scope ? { projectScope: scope } : {}),
    })),
  );
  for (const { id, scope, resource } of sessions) {
    writeJson(path.join(historyDirectory, id, "metadata.json"), {
      schemaVersion: 1,
      mode: "code",
      model: "m",
      ...(scope
        ? { projectScope: scope, summary: { id, projectScope: scope } }
        : {}),
      ...(resource ? { activeContextResourceUri: resource } : {}),
    });
    fs.writeFileSync(
      path.join(historyDirectory, id, "messages.json"),
      `{"messages":["${scope?.rootPath ?? ""}/App.swift"]}`,
    );
  }
}

function request(
  previousRoot: string,
  currentRoot: string,
): ProjectHistoryRelocationRequest {
  return {
    workspaceFolders: [
      { name: path.basename(currentRoot), uri: fileUri(currentRoot) },
    ],
    workspaceFile: undefined,
    previous: {
      rootPath: previousRoot,
      uri: fileUri(previousRoot),
      projectUri: normalizeWorkspaceProjectUri(fileUri(previousRoot)),
    },
    current: {
      rootPath: currentRoot,
      uri: fileUri(currentRoot),
      scope: scopeFor(currentRoot),
    },
  };
}

function resolveCurrent(currentRoot: string) {
  return resolveWorkspaceSessionLocation({
    workspaceFolders: [{ uri: fileUri(currentRoot) }],
    workspaceFile: undefined,
    fallbackCwd: currentRoot,
  });
}

describe("project history relocation", () => {
  it("rewrites legacy in-folder history after a rename and keeps a backup", async () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "iPlayGFN");
    const newRoot = path.join(parent, "iPlayNow");
    const history = path.join(oldRoot, ".agentlink", "history");
    const other = scopeFor(path.join(parent, "elsewhere"));
    writeSessions(history, [
      {
        id: "a",
        scope: scopeFor(oldRoot),
        resource: `${pathToFileURL(oldRoot).href}/App/Main.swift`,
      },
      { id: "b", scope: scopeFor(oldRoot) },
      { id: "c", scope: other },
    ]);
    fs.renameSync(oldRoot, newRoot);

    const planned = planProjectHistoryRelocation(request(oldRoot, newRoot));
    expect(planned).toMatchObject({
      ok: true,
      plan: { storageKind: "legacy", totalSessions: 3, sessionsToRewrite: 2 },
    });
    if (!planned.ok) return;
    const result = await relocateProjectHistory(planned.plan);

    const newHistory = path.join(newRoot, ".agentlink", "history");
    expect(result).toMatchObject({
      historyDirectory: newHistory,
      sessionsRewritten: 2,
      moved: false,
    });
    const metadata = readJson(path.join(newHistory, "a", "metadata.json"));
    expect(metadata.projectScope).toEqual(scopeFor(newRoot));
    expect(metadata.summary.projectScope).toEqual(scopeFor(newRoot));
    expect(metadata.activeContextResourceUri).toBe(
      `${scopeFor(newRoot).workspaceFolderUri}/App/Main.swift`,
    );
    expect(
      readJson(path.join(newHistory, "c", "metadata.json")).projectScope,
    ).toEqual(other);
    expect(
      readJson(path.join(newHistory, "sessions.json")).map(
        (entry: { projectScope: SessionProjectScope }) =>
          entry.projectScope.workspaceFolderUri,
      ),
    ).toEqual([
      scopeFor(newRoot).workspaceFolderUri,
      scopeFor(newRoot).workspaceFolderUri,
      other.workspaceFolderUri,
    ]);
    // Transcripts are historical records and stay untouched.
    expect(
      fs.readFileSync(path.join(newHistory, "a", "messages.json"), "utf-8"),
    ).toContain(oldRoot);
    expect(
      readJson(
        path.join(result.backupDirectory, "history", "a", "metadata.json"),
      ).projectScope,
    ).toEqual(scopeFor(oldRoot));
    expect(
      readJson(path.join(result.backupDirectory, "backup.json")),
    ).toMatchObject({ previousRootPath: oldRoot, currentRootPath: newRoot });

    expect(
      planProjectHistoryRelocation(request(oldRoot, newRoot)),
    ).toMatchObject({ ok: false, reason: "nothing_to_migrate" });
  });

  it("moves v2 lineage history keyed by the old identity", async () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    fs.mkdirSync(oldRoot);
    const oldLocation = resolveCurrent(oldRoot);
    const workspaceRoot = path.join(
      oldRoot,
      ".agentlink",
      "workspaces",
      `ws-${oldLocation.workspaceIdentity.slice(0, 16)}`,
    );
    writeSessions(path.join(workspaceRoot, "l-active"), [
      { id: "a", scope: scopeFor(oldRoot) },
    ]);
    writeSessions(path.join(workspaceRoot, "l-older"), [
      { id: "b", scope: scopeFor(oldRoot) },
    ]);
    writeJson(path.join(workspaceRoot, "workspace.json"), {
      version: 1,
      workspaceIdentity: oldLocation.workspaceIdentity,
      workspaceFolderUris: oldLocation.workspaceFolderUris,
      activeLineage: "l-active",
      previousLineages: ["l-older"],
      updatedAt: 1,
    });
    // A stale pre-v2 legacy history must not block or confuse the move.
    writeSessions(path.join(oldRoot, ".agentlink", "history"), [
      { id: "legacy", scope: scopeFor(oldRoot) },
    ]);
    expect(resolveCurrent(oldRoot).historyStorageKind).toBe("lineage_v2");
    fs.renameSync(oldRoot, newRoot);
    expect(resolveCurrent(newRoot).historyStorageKind).toBe("legacy");

    const planned = planProjectHistoryRelocation(request(oldRoot, newRoot));
    expect(planned).toMatchObject({
      ok: true,
      plan: { storageKind: "lineage_v2", totalSessions: 2 },
    });
    if (!planned.ok) return;
    const result = await relocateProjectHistory(planned.plan);

    const after = resolveCurrent(newRoot);
    expect(after.historyStorageKind).toBe("lineage_v2");
    expect(after.historyDirectory).toBe(result.historyDirectory);
    expect(result.moved).toBe(true);
    expect(
      readJson(path.join(after.historyDirectory!, "a", "metadata.json"))
        .projectScope,
    ).toEqual(scopeFor(newRoot));
    expect(
      readJson(
        path.join(
          path.dirname(after.historyDirectory!),
          "l-older",
          "b",
          "metadata.json",
        ),
      ).projectScope,
    ).toEqual(scopeFor(newRoot));
    expect(
      readJson(
        path.join(path.dirname(after.historyDirectory!), "workspace.json"),
      ),
    ).toMatchObject({
      workspaceIdentity: after.workspaceIdentity,
      workspaceFolderUris: after.workspaceFolderUris,
    });
    expect(
      fs.existsSync(
        path.join(
          newRoot,
          ".agentlink",
          "workspaces",
          `ws-${oldLocation.workspaceIdentity.slice(0, 16)}`,
        ),
      ),
    ).toBe(false);
  });

  function writeV2History(
    root: string,
    workspaceFile?: ReturnType<typeof fileUri>,
  ): void {
    const location = resolveWorkspaceSessionLocation({
      workspaceFolders: [{ uri: fileUri(root) }],
      workspaceFile,
      fallbackCwd: root,
    });
    const workspaceRoot = path.join(
      root,
      ".agentlink",
      "workspaces",
      `ws-${location.workspaceIdentity.slice(0, 16)}`,
    );
    writeSessions(path.join(workspaceRoot, "l-active"), [
      { id: "a", scope: scopeFor(root) },
    ]);
    writeJson(path.join(workspaceRoot, "workspace.json"), {
      version: 1,
      workspaceIdentity: location.workspaceIdentity,
      workspaceFolderUris: location.workspaceFolderUris,
      ...(location.workspaceFileUri
        ? { workspaceFileUri: location.workspaceFileUri }
        : {}),
      activeLineage: "l-active",
      previousLineages: [],
    });
  }

  it("refuses a v2 move that would hide sessions created since the rename", () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    writeV2History(oldRoot);
    fs.renameSync(oldRoot, newRoot);
    writeSessions(path.join(newRoot, ".agentlink", "history"), [
      { id: "fresh", scope: scopeFor(newRoot) },
    ]);

    expect(
      planProjectHistoryRelocation(request(oldRoot, newRoot)),
    ).toMatchObject({ ok: false, reason: "destination_has_history" });
  });

  it("finds v2 history keyed by a workspace file that moved with the folder", () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    writeV2History(oldRoot, fileUri(path.join(oldRoot, "app.code-workspace")));
    fs.renameSync(oldRoot, newRoot);

    const planned = planProjectHistoryRelocation({
      ...request(oldRoot, newRoot),
      workspaceFile: fileUri(path.join(newRoot, "app.code-workspace")),
    });
    expect(planned).toMatchObject({
      ok: true,
      plan: { storageKind: "lineage_v2", totalSessions: 1 },
    });
  });

  it("refuses when the destination already has its own v2 history", () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    fs.mkdirSync(newRoot);
    writeSessions(path.join(newRoot, ".agentlink", "history"), [
      { id: "a", scope: scopeFor(oldRoot) },
    ]);
    const current = resolveCurrent(newRoot);
    const workspaceRoot = path.join(
      newRoot,
      ".agentlink",
      "workspaces",
      `ws-${current.workspaceIdentity.slice(0, 16)}`,
    );
    writeSessions(path.join(workspaceRoot, "l-x"), [
      { id: "z", scope: scopeFor(newRoot) },
    ]);
    writeJson(path.join(workspaceRoot, "workspace.json"), {
      version: 1,
      workspaceIdentity: current.workspaceIdentity,
      workspaceFolderUris: current.workspaceFolderUris,
      activeLineage: "l-x",
      previousLineages: [],
    });

    expect(
      planProjectHistoryRelocation(request(oldRoot, newRoot)),
    ).toMatchObject({ ok: false, reason: "destination_has_history" });
  });

  it("restores the original history when verification fails", async () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    writeSessions(path.join(oldRoot, ".agentlink", "history"), [
      { id: "a", scope: scopeFor(oldRoot) },
    ]);
    fs.renameSync(oldRoot, newRoot);
    const planned = planProjectHistoryRelocation(request(oldRoot, newRoot));
    if (!planned.ok) throw new Error(planned.message);

    await expect(
      relocateProjectHistory({ ...planned.plan, totalSessions: 99 }),
    ).rejects.toThrow(/original history was restored/);
    expect(
      readJson(
        path.join(newRoot, ".agentlink", "history", "a", "metadata.json"),
      ).projectScope,
    ).toEqual(scopeFor(oldRoot));
  });

  it("discovers previous locations from the marker, history, and v2 manifests", () => {
    const parent = makeWorkspaceParent();
    const oldRoot = path.join(parent, "old-name");
    const newRoot = path.join(parent, "new-name");
    writeSessions(path.join(oldRoot, ".agentlink", "history"), [
      { id: "a", scope: scopeFor(oldRoot) },
    ]);
    recordProjectLocation(oldRoot, {
      workspaceFolderUri: scopeFor(oldRoot).workspaceFolderUri,
      rootPath: oldRoot,
      displayName: "old-name",
    });
    fs.renameSync(oldRoot, newRoot);
    const moved = recordProjectLocation(newRoot, {
      workspaceFolderUri: scopeFor(newRoot).workspaceFolderUri,
      rootPath: newRoot,
      displayName: "new-name",
    });
    expect(moved?.movedFrom).toMatchObject({ rootPath: oldRoot });

    const candidates = findProjectHistoryRelocationCandidates({
      folders: [
        {
          rootPath: newRoot,
          uri: fileUri(newRoot),
          projectUri: scopeFor(newRoot).workspaceFolderUri,
        },
      ],
      currentHistoryDirectory: path.join(newRoot, ".agentlink", "history"),
    });
    expect(candidates).toEqual([
      {
        previousRootPath: oldRoot,
        previousDisplayName: "old-name",
        previousProjectUri: scopeFor(oldRoot).workspaceFolderUri,
        currentRootPath: newRoot,
        previousExists: false,
        evidence: ["location_marker", "session_history"],
      },
    ]);
  });
});

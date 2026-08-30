import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
} from "../core/agentPlugins/schemaRegistry.js";
import type {
  SessionProjectScope,
  WorkspaceProject,
} from "@agentlink/protocol/workspace-project";
import type { ProjectScopeResolver } from "../core/workspaceProjects.js";
import { AgentPluginInstaller } from "./AgentPluginInstaller.js";
import { AgentPluginManagerHost } from "./AgentPluginManagerHost.js";
import { readAgentPluginProjectDeclarations } from "./agentPluginProjectDeclarations.js";
import {
  AgentPluginStore,
  type ProcessInstanceInspector,
} from "./AgentPluginStore.js";

const now = new Date("2026-08-15T00:00:00.000Z");

function inspector(): ProcessInstanceInspector {
  return {
    async current() {
      return { pid: process.pid, processStartFingerprint: "manager-test" };
    },
    async inspect(pid) {
      return pid === process.pid
        ? { status: "alive", processStartFingerprint: "manager-test" }
        : { status: "dead" };
    },
  };
}

function projectResolver(
  projects: readonly WorkspaceProject[],
): ProjectScopeResolver {
  return {
    listProjects: () => projects,
    resolveProjectForResource: () => undefined,
    resolvePersistedScope(scope) {
      const project = projects.find(
        (candidate) => candidate.uri === scope.workspaceFolderUri,
      );
      if (!project) return { status: "missing", scope };
      if (project.id !== scope.projectId) {
        return { status: "invalid", scope, reason: "project_id_mismatch" };
      }
      if (project.availability.status !== "available") {
        return {
          status: "unavailable",
          project,
          scope,
          availability: project.availability,
        };
      }
      return {
        status: "available",
        project,
        scope: {
          ...scope,
          displayName: project.name,
          ...(project.rootPath ? { rootPath: project.rootPath } : {}),
        },
      };
    },
  };
}

async function writePlugin(
  root: string,
  description: string,
  withMcp = false,
): Promise<void> {
  await fs.mkdir(path.join(root, "skills", "helper"), { recursive: true });
  await fs.writeFile(
    path.join(root, "plugin.json"),
    `${JSON.stringify({
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
      name: "managed-fixture",
      version: "1.0.0",
    })}\n`,
  );
  await fs.writeFile(
    path.join(root, "skills", "helper", "SKILL.md"),
    `---\nname: helper\ndescription: ${description}\n---\n\nHelp.\n`,
  );
  if (withMcp) {
    await fs.writeFile(
      path.join(root, "mcp.json"),
      `${JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
        mcpServers: { tools: { type: "stdio", command: "node" } },
      })}\n`,
    );
    await fs.mkdir(path.join(root, "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(root, "hooks", "hooks.json"),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                {
                  type: "command",
                  command: "node ${PLUGIN_ROOT}/hooks/check.js --token secret",
                  async: true,
                },
                { type: "mcp_tool", server: "tools", tool: "check" },
              ],
            },
          ],
        },
      })}\n`,
    );
  }
}

describe("AgentPluginManagerHost", () => {
  let directory: string;
  let source: string;
  let store: AgentPluginStore;
  let manager: AgentPluginManagerHost;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-plugin-manager-"),
    );
    source = path.join(directory, "source");
    await writePlugin(source, "First");
    store = new AgentPluginStore({
      rootPath: path.join(directory, "store"),
      processInspector: inspector(),
      now: () => now,
    });
    manager = new AgentPluginManagerHost(
      store,
      new AgentPluginInstaller({ stagingParent: directory }),
      { enabled: true, now: () => now },
    );
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("commits a validated disabled package, then enables and removes it", async () => {
    const prepared = await manager.prepareInstall(source);
    const candidate = prepared.candidates[0]!;
    const row = await manager.commitPrepared({
      prepared,
      candidate,
      enabled: false,
    });
    await prepared.acquired.cleanup();

    expect(row.enabled).toBe(false);
    expect(row.source).toMatchObject({
      kind: "local-directory",
      label: "source",
    });
    await expect(
      fs.stat(store.getPackagePath(row.installInstanceId, row.currentDigest)),
    ).resolves.toBeDefined();

    await manager.setEnabled(row.installInstanceId, true);
    expect(
      (await manager.list()).installs[row.installInstanceId]?.enabled,
    ).toBe(true);

    await manager.remove(row.installInstanceId);
    expect(
      (await manager.list()).installs[row.installInstanceId],
    ).toBeUndefined();
    await expect(
      fs.stat(store.getPackagePath(row.installInstanceId, row.currentDigest)),
    ).resolves.toBeDefined();
  });

  it("rejects duplicate manifest names in the same scope", async () => {
    const first = await manager.prepareInstall(source);
    await manager.commitPrepared({
      prepared: first,
      candidate: first.candidates[0]!,
      enabled: false,
    });
    await first.acquired.cleanup();

    const second = await manager.prepareInstall(source);
    await expect(
      manager.commitPrepared({
        prepared: second,
        candidate: second.candidates[0]!,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
    await second.acquired.cleanup();
  });

  it("mutates only the targeted current MCP policy overlay", async () => {
    await writePlugin(source, "First", true);
    const prepared = await manager.prepareInstall(source);
    const row = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: true,
    });
    await prepared.acquired.cleanup();
    const registry = await manager.list();
    const target = {
      kind: "agent-plugin-overlay" as const,
      installInstanceId: row.installInstanceId,
      packageDigest: row.currentDigest,
      declaredServerName: "tools",
      runtimeServerName: `plugin-${row.installInstanceId}-tools`,
      scope: "global" as const,
      projectId: "requesting-project",
    };

    const updated = await manager.mutateMcpPolicy({
      target,
      expectedRevision: registry.revision,
      update: () => ({ allowedTools: ["read"] }),
    });

    expect(updated.policy.mcp?.tools).toEqual({ allowedTools: ["read"] });
    await expect(
      manager.mutateMcpPolicy({
        target: { ...target, runtimeServerName: "spoofed" },
        update: () => ({ toolPolicy: "allow" }),
      }),
    ).rejects.toMatchObject({ code: "mcp_server_not_found" });
    await expect(
      manager.mutateMcpPolicy({
        target: { ...target, packageDigest: "b".repeat(64) },
        update: () => ({ toolPolicy: "allow" }),
      }),
    ).rejects.toMatchObject({ code: "mcp_package_changed" });
  });

  it("installs a workspace-contained source at canonical project scope and writes a zero-authority declaration", async () => {
    const workspace = path.join(directory, "workspace");
    const projectSource = path.join(workspace, "plugins", "managed-fixture");
    await writePlugin(projectSource, "Project fixture");
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspace}`,
      displayName: "Project A",
      rootPath: workspace,
    };

    const prepared = await manager.prepareInstall(projectSource, {
      target: { kind: "project", scope: projectScope },
    });
    expect(prepared.shareability).toBe("shareable");
    const row = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: false,
    });
    await prepared.acquired.cleanup();

    expect(row.scope).toEqual({
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspace}`,
    });
    expect(row.source).toMatchObject({
      kind: "workspace-directory",
      path: "plugins/managed-fixture",
    });
    const declarations = await readAgentPluginProjectDeclarations(projectScope);
    expect(declarations.declarations).toEqual([
      {
        name: "managed-fixture",
        source: { path: "plugins/managed-fixture" },
      },
    ]);
    const declarationSource = await fs.readFile(
      declarations.declarationPath,
      "utf8",
    );
    expect(declarationSource).not.toMatch(/enabled|policy|approval|\/Users\//u);
  });

  it("keeps outside-workspace project sources machine-local and marks them not shareable", async () => {
    const workspace = path.join(directory, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspace}`,
      displayName: "Project A",
      rootPath: workspace,
    };

    const prepared = await manager.prepareInstall(source, {
      target: { kind: "project", scope: projectScope },
    });
    expect(prepared.shareability).toBe("not-shareable");
    await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: false,
    });
    await prepared.acquired.cleanup();

    const snapshot = await manager.getSnapshot(projectScope);
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        status: "installed",
        shareability: "not-shareable",
      }),
    ]);
    await expect(
      fs.stat(path.join(workspace, ".agentlink", "plugins.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows declaration-only entries and installs only the exact declared manifest", async () => {
    const workspace = path.join(directory, "workspace");
    const declaredSource = path.join(workspace, "plugins", "fixture");
    await writePlugin(declaredSource, "Declared fixture");
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspace}`,
      displayName: "Project A",
      rootPath: workspace,
    };
    await fs.mkdir(path.join(workspace, ".agentlink"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".agentlink", "plugins.json"),
      `${JSON.stringify({
        plugins: [
          {
            name: "managed-fixture",
            source: { path: "plugins/fixture" },
          },
        ],
      })}\n`,
    );

    expect(await manager.getSnapshot(projectScope)).toMatchObject({
      entries: [
        {
          status: "declared",
          manifestName: "managed-fixture",
          shareability: "shareable",
        },
      ],
    });
    const prepared = await manager.prepareDeclaredInstall(
      projectScope,
      "managed-fixture",
    );
    const row = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: true,
    });
    await prepared.acquired.cleanup();
    expect(row.enabled).toBe(true);
    expect((await manager.getSnapshot(projectScope)).entries).toEqual([
      expect.objectContaining({
        status: "installed",
        manifestName: "managed-fixture",
      }),
    ]);
  });

  it("does not bind a declaration to a different manifest name", async () => {
    const workspace = path.join(directory, "workspace");
    const declaredSource = path.join(workspace, "plugins", "fixture");
    await writePlugin(declaredSource, "Declared fixture");
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspace}`,
      displayName: "Project A",
      rootPath: workspace,
    };
    await fs.mkdir(path.join(workspace, ".agentlink"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".agentlink", "plugins.json"),
      `${JSON.stringify({
        plugins: [
          { name: "other-plugin", source: { path: "plugins/fixture" } },
        ],
      })}\n`,
    );

    await expect(
      manager.prepareDeclaredInstall(projectScope, "other-plugin"),
    ).rejects.toMatchObject({ code: "declared_name_mismatch" });
    expect(Object.keys((await manager.list()).installs)).toEqual([]);
  });

  it("canonicalizes the selected multi-root target and rejects moved folder identity", async () => {
    const workspaceA = path.join(directory, "workspace-a");
    const workspaceB = path.join(directory, "workspace-b");
    await Promise.all([
      fs.mkdir(workspaceA, { recursive: true }),
      fs.mkdir(workspaceB, { recursive: true }),
    ]);
    const projects: WorkspaceProject[] = [
      {
        id: "project-a",
        name: "Project A",
        uri: "file:///workspace-a",
        rootPath: workspaceA,
        availability: { status: "available" },
      },
      {
        id: "project-b",
        name: "Project B",
        uri: "file:///workspace-b",
        rootPath: workspaceB,
        availability: { status: "available" },
      },
    ];
    const scopedManager = new AgentPluginManagerHost(
      store,
      new AgentPluginInstaller({ stagingParent: directory }),
      {
        enabled: true,
        now: () => now,
        projectResolver: projectResolver(projects),
      },
    );
    const staleRootScope: SessionProjectScope = {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-b",
      workspaceFolderUri: "file:///workspace-b",
      displayName: "Old Project B",
      rootPath: "/stale/root",
    };

    const prepared = await scopedManager.prepareInstall(source, {
      target: { kind: "project", scope: staleRootScope },
    });
    expect(prepared.target).toMatchObject({
      kind: "project",
      scope: {
        projectId: "project-b",
        workspaceFolderUri: "file:///workspace-b",
        displayName: "Project B",
        rootPath: workspaceB,
      },
    });
    await prepared.acquired.cleanup();

    await expect(
      scopedManager.prepareInstall(source, {
        target: {
          kind: "project",
          scope: {
            ...staleRootScope,
            workspaceFolderUri: "file:///moved/workspace-b",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "project_scope_unavailable" });
  });

  it("reports project-over-global shadowing in project manager snapshots", async () => {
    const globalPrepared = await manager.prepareInstall(source);
    const global = await manager.commitPrepared({
      prepared: globalPrepared,
      candidate: globalPrepared.candidates[0]!,
      enabled: true,
    });
    await globalPrepared.acquired.cleanup();

    const workspace = path.join(directory, "workspace");
    const projectSource = path.join(workspace, "plugins", "managed-fixture");
    await writePlugin(projectSource, "Project fixture");
    const projectScope: SessionProjectScope = {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: "file:///workspace",
      displayName: "Project A",
      rootPath: workspace,
    };
    const projectPrepared = await manager.prepareInstall(projectSource, {
      target: { kind: "project", scope: projectScope },
    });
    const project = await manager.commitPrepared({
      prepared: projectPrepared,
      candidate: projectPrepared.candidates[0]!,
      enabled: true,
    });
    await projectPrepared.acquired.cleanup();

    expect((await manager.getSnapshot(projectScope)).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          install: expect.objectContaining({
            installInstanceId: global.installInstanceId,
          }),
          effective: false,
          shadowedByInstallInstanceId: project.installInstanceId,
        }),
        expect.objectContaining({
          install: expect.objectContaining({
            installInstanceId: project.installInstanceId,
          }),
          effective: true,
        }),
      ]),
    );
  });

  it("returns a committed install with a failed declaration outcome when the declaration changed concurrently", async () => {
    const workspace = path.join(directory, "workspace");
    const projectSource = path.join(workspace, "plugins", "managed-fixture");
    await writePlugin(projectSource, "Project fixture");
    const projectScope: SessionProjectScope = {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: "file:///workspace",
      displayName: "Project A",
      rootPath: workspace,
    };
    const prepared = await manager.prepareInstall(projectSource, {
      target: { kind: "project", scope: projectScope },
    });
    await fs.mkdir(path.join(workspace, ".agentlink"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".agentlink", "plugins.json"),
      '{"plugins":[]}\n',
    );

    const committed = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: false,
    });
    await prepared.acquired.cleanup();

    expect(committed.declarationOutcome).toMatchObject({
      status: "failed",
      message: expect.stringContaining("changed before the update"),
    });
    expect(
      (await manager.list()).installs[committed.installInstanceId],
    ).toBeDefined();
  });

  it("builds bounded browser-safe manager rows without secret values or host paths", async () => {
    await writePlugin(source, "Manager projection", true);
    const prepared = await manager.prepareInstall(source);
    const installed = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: true,
    });
    await prepared.acquired.cleanup();

    const snapshot = await manager.getManagerSnapshot(undefined, {
      readOnly: true,
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      rows: [
        {
          status: "enabled",
          manifestName: "managed-fixture",
          installInstanceId: installed.installInstanceId,
          source: {
            kind: "local-directory",
            label: "source",
            shareability: "not-applicable",
          },
          skills: [{ name: "helper", description: "Manager projection" }],
          mcpServers: [
            {
              name: "tools",
              type: "stdio",
              command: "node",
              toolPolicy: "ask",
            },
          ],
          hooks: [
            {
              event: "PreToolUse",
              matcher: "^Bash$",
              command: "node ${PLUGIN_ROOT}/hooks/check.js --token secret",
              handlerType: "command",
              async: true,
              sourceRelativePath: "hooks/hooks.json",
            },
            {
              event: "PreToolUse",
              matcher: "^Bash$",
              handlerType: "mcp_tool",
              async: false,
              sourceRelativePath: "hooks/hooks.json",
            },
          ],
        },
      ],
      capabilities: { canInstall: false, canInspect: true },
      readOnlyReason: "Manage plugins in VS Code.",
    });
    expect(JSON.stringify(snapshot)).not.toContain(directory);
    expect(JSON.stringify(snapshot)).not.toContain("plugin-data");
  });

  it("rolls back only to the validated previous generation and keeps a swap slot", async () => {
    const first = await manager.prepareInstall(source);
    const installed = await manager.commitPrepared({
      prepared: first,
      candidate: first.candidates[0]!,
      enabled: true,
    });
    await first.acquired.cleanup();

    await writePlugin(source, "Second generation");
    const update = await manager.prepareInstall(source);
    const updated = await manager.commitPrepared({
      prepared: update,
      candidate: update.candidates[0]!,
      enabled: true,
      replacingInstallInstanceId: installed.installInstanceId,
    });
    await update.acquired.cleanup();
    expect(updated.currentDigest).not.toBe(installed.currentDigest);
    expect(updated.previousDigest).toBe(installed.currentDigest);

    const rolledBack = await manager.rollback(installed.installInstanceId);
    expect(rolledBack.currentDigest).toBe(installed.currentDigest);
    expect(rolledBack.previousDigest).toBe(updated.currentDigest);
  });

  it("removes plugin data only through the explicit destructive operation", async () => {
    const prepared = await manager.prepareInstall(source);
    const installed = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: true,
    });
    await prepared.acquired.cleanup();
    const dataPath = store.getGlobalDataPath(installed.installInstanceId);
    await fs.mkdir(dataPath, { recursive: true });
    await fs.writeFile(path.join(dataPath, "state.json"), "{}\n");

    await manager.removeData(installed.installInstanceId);

    await expect(fs.stat(dataPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await manager.list()).installs[installed.installInstanceId],
    ).toBeDefined();
  });

  it("does not claim that sanitized local provenance can be updated automatically", async () => {
    const prepared = await manager.prepareInstall(source);
    const row = await manager.commitPrepared({
      prepared,
      candidate: prepared.candidates[0]!,
      enabled: false,
    });
    await prepared.acquired.cleanup();

    await expect(
      manager.prepareUpdate(row.installInstanceId),
    ).rejects.toMatchObject({
      code: "update_source_unavailable",
    });
  });
});

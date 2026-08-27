import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProjectlessSessionScope,
  type SessionProjectScope,
} from "../core/workspaceProjects.js";
import { AGENT_PLUGIN_MANIFEST_SCHEMA_ID } from "../core/agentPlugins/schemaRegistry.js";
import { AgentPluginCatalog } from "./AgentPluginCatalog.js";
import {
  AgentPluginStore,
  digestAgentPluginTree,
  type AgentPluginRegistryRow,
  type ProcessInstanceInspector,
} from "./AgentPluginStore.js";
import { loadSkillCatalog } from "./skillLoader.js";

const now = "2026-08-14T00:00:00.000Z";

function inspector(): ProcessInstanceInspector {
  return {
    async current() {
      return { pid: process.pid, processStartFingerprint: "current-process" };
    },
    async inspect(pid) {
      return pid === process.pid
        ? { status: "alive", processStartFingerprint: "current-process" }
        : { status: "dead" };
    },
  };
}

function projectScope(rootPath: string): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId: "project-fixture",
    workspaceFolderUri: "file:///fixture",
    displayName: "Fixture",
    rootPath,
  };
}

async function createPackage(
  root: string,
  name: string,
  skillName: string,
  withHooks = false,
): Promise<void> {
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "plugin.json"),
    `${JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID, name })}\n`,
  );
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Plugin ${skillName}\n---\n\nPlugin body.\n`,
  );
  if (withHooks) {
    await fs.mkdir(path.join(root, "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(root, "hooks", "hooks.json"),
      `${JSON.stringify({
        description: `${name} hooks`,
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [{ type: "command", command: `echo ${name}` }],
            },
          ],
        },
      })}\n`,
    );
  }
}

function registryRow(
  installInstanceId: string,
  manifestName: string,
  digest: string,
  rowScope: AgentPluginRegistryRow["scope"] = { kind: "global" },
): AgentPluginRegistryRow {
  return {
    installInstanceId,
    scope: rowScope,
    manifestName,
    manifestSchema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
    currentDigest: digest,
    source: {
      kind: "local-directory",
      label: manifestName,
      sourceDigest: digest,
    },
    enabled: true,
    installedAt: now,
    updatedAt: now,
    policy: {},
  };
}

describe("AgentPluginCatalog", () => {
  let directory: string;
  let store: AgentPluginStore;
  let scope: SessionProjectScope;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-plugin-catalog-"),
    );
    const projectRoot = path.join(directory, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    scope = projectScope(projectRoot);
    store = new AgentPluginStore({
      rootPath: path.join(directory, ".agentlink", "plugins"),
      processInspector: inspector(),
    });
  });

  afterEach(async () => {
    await store.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function installFixture(
    installInstanceId = "fixture-install",
    manifestName = "fixture-plugin",
    skillName = "fixture-skill",
    rowScope: AgentPluginRegistryRow["scope"] = { kind: "global" },
  ): Promise<AgentPluginRegistryRow> {
    const staged = path.join(directory, `staged-${installInstanceId}`);
    await createPackage(staged, manifestName, skillName, true);
    const digest = await digestAgentPluginTree(staged);
    await store.commitPackage({
      installInstanceId,
      stagedDirectory: staged,
      expectedDigest: digest,
    });
    const row = registryRow(installInstanceId, manifestName, digest, rowScope);
    const registry = await store.readRegistry();
    await store.mutateRegistry({
      expectedRevision: registry.revision,
      apply: (current) => ({
        registry: {
          ...current,
          installs: { ...current.installs, [installInstanceId]: row },
        },
        result: undefined,
      }),
    });
    return row;
  }

  it("projects enabled global skills with stable logical provenance", async () => {
    const row = await installFixture();
    const catalog = new AgentPluginCatalog(store, { enabled: true });

    const snapshot = await catalog.getSnapshot(scope);

    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({
      id: "global:plugin:fixture-install/skills/fixture-skill",
      name: "fixture-skill",
      provenance: {
        namespace: "plugin",
        plugin: {
          installInstanceId: "fixture-install",
          packageDigest: row.currentDigest,
          manifestName: "fixture-plugin",
          packageRelativePath: "skills/fixture-skill/SKILL.md",
          effectiveScope: "global",
        },
      },
    });
    catalog.dispose();
  });

  it("shadows a same-name global plugin only in its owning project", async () => {
    const global = await installFixture(
      "global-shared",
      "shared-plugin",
      "global-skill",
    );
    const project = await installFixture(
      "project-shared",
      "shared-plugin",
      "project-skill",
      {
        kind: "project",
        projectId: scope.projectId,
        workspaceFolderUri: scope.workspaceFolderUri,
      },
    );
    const otherScope: SessionProjectScope = {
      ...scope,
      projectId: "project-other",
      workspaceFolderUri: "file:///other",
      displayName: "Other",
    };
    const catalog = new AgentPluginCatalog(store, { enabled: true });

    const owningSnapshot = await catalog.getSnapshot(scope);
    expect(owningSnapshot.installs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          installInstanceId: global.installInstanceId,
          effective: false,
          shadowedByInstallInstanceId: project.installInstanceId,
        }),
        expect.objectContaining({
          installInstanceId: project.installInstanceId,
          effective: true,
        }),
      ]),
    );
    expect(owningSnapshot.skills.map((skill) => skill.name)).toEqual([
      "project-skill",
    ]);
    const projectPluginRoot = await fs.realpath(
      store.getPackagePath(project.installInstanceId, project.currentDigest),
    );
    expect(owningSnapshot.hooks).toEqual([
      expect.objectContaining({
        installInstanceId: project.installInstanceId,
        packageDigest: project.currentDigest,
        manifestName: "shared-plugin",
        scope: project.scope,
        pluginRoot: projectPluginRoot,
        pluginData: store.getProjectDataPath(
          scope.projectId,
          project.installInstanceId,
        ),
        sourcePath: path.join(projectPluginRoot, "hooks", "hooks.json"),
        sourceRelativePath: "hooks/hooks.json",
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [{ type: "command", command: "echo shared-plugin" }],
            },
          ],
        },
      }),
    ]);

    const otherSnapshot = await catalog.getSnapshot(otherScope);
    expect(otherSnapshot.installs).toEqual([
      expect.objectContaining({
        installInstanceId: global.installInstanceId,
        effective: true,
      }),
    ]);
    expect(otherSnapshot.skills.map((skill) => skill.name)).toEqual([
      "global-skill",
    ]);
    expect(otherSnapshot.hooks).toEqual([
      expect.objectContaining({
        installInstanceId: global.installInstanceId,
        packageDigest: global.currentDigest,
        scope: global.scope,
        pluginData: store.getGlobalDataPath(global.installInstanceId),
        sourceRelativePath: "hooks/hooks.json",
      }),
    ]);
    catalog.dispose();
  });

  it("does not inherit a project plugin after the workspace-folder identity changes", async () => {
    await installFixture("project-only", "project-plugin", "project-skill", {
      kind: "project",
      projectId: scope.projectId,
      workspaceFolderUri: scope.workspaceFolderUri,
    });
    const movedScope: SessionProjectScope = {
      ...scope,
      projectId: "project-moved",
      workspaceFolderUri: "file:///moved/fixture",
      rootPath: path.join(directory, "moved-project"),
    };
    await fs.mkdir(movedScope.rootPath!, { recursive: true });
    const catalog = new AgentPluginCatalog(store, { enabled: true });

    await expect(catalog.getSnapshot(movedScope)).resolves.toMatchObject({
      installs: [],
      skills: [],
      mcpServers: [],
    });
    catalog.dispose();
  });

  it("keeps projectless, unavailable, disabled-gate, and Windows snapshots empty", async () => {
    await installFixture();
    const enabled = new AgentPluginCatalog(store, { enabled: true });
    const disabled = new AgentPluginCatalog(store, { enabled: false });
    const windows = new AgentPluginCatalog(store, {
      enabled: true,
      platform: "win32",
    });

    await expect(
      enabled.getSnapshot(createProjectlessSessionScope()),
    ).resolves.toMatchObject({ skills: [], registryRevision: 0 });
    await expect(
      enabled.getSnapshot({ ...scope, rootPath: undefined }),
    ).resolves.toMatchObject({ skills: [], hooks: [], registryRevision: 0 });
    await expect(disabled.getSnapshot(scope)).resolves.toMatchObject({
      skills: [],
    });
    await expect(windows.getSnapshot(scope)).resolves.toMatchObject({
      skills: [],
    });
    enabled.dispose();
    disabled.dispose();
    windows.dispose();
  });

  it("fails closed to an empty projection when the registry becomes corrupt", async () => {
    await fs.mkdir(path.dirname(store.registryPath), { recursive: true });
    await fs.writeFile(store.registryPath, '{"schemaVersion":1,}\n');
    const catalog = new AgentPluginCatalog(store, { enabled: true });

    const snapshot = await catalog.getSnapshot(scope);

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: "agent_plugin_registry_corrupt",
        severity: "error",
      }),
    ]);
    catalog.dispose();
  });

  it("merges plugin entries through canonical collision handling", async () => {
    await installFixture(
      "plugin-shared-install",
      "plugin-with-shared",
      "shared-helper",
    );
    const projectSkill = path.join(
      scope.rootPath!,
      ".agentlink",
      "skills",
      "shared-helper",
    );
    await fs.mkdir(projectSkill, { recursive: true });
    await fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "---\nname: shared-helper\ndescription: Project helper\n---\n",
    );
    const pluginCatalog = new AgentPluginCatalog(store, { enabled: true });
    const plugins = await pluginCatalog.getSnapshot(scope);

    const canonical = await loadSkillCatalog(scope.rootPath!, "code", {
      additionalEntries: plugins.skills,
    });

    expect(canonical.collisions).toContainEqual({
      name: "shared-helper",
      skillIds: [
        "global:plugin:plugin-shared-install/skills/shared-helper",
        "project:agentlink:.agentlink/skills/shared-helper",
      ],
    });
    pluginCatalog.dispose();
  });

  it("observes another store instance's revision and emits invalidation", async () => {
    const observerStore = new AgentPluginStore({
      rootPath: path.join(directory, ".agentlink", "plugins"),
      processInspector: inspector(),
    });
    const catalog = new AgentPluginCatalog(observerStore, { enabled: true });
    const listener = vi.fn();
    catalog.subscribe(listener);
    await catalog.getSnapshot(scope);

    await installFixture();
    await observerStore.checkForUpdates();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ registryRevision: 1 }),
    );
    catalog.dispose();
    await observerStore.dispose();
  });
});

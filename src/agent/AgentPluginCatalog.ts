import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createHash } from "node:crypto";

import type {
  AgentPluginDiagnostic,
  AgentPluginHookEventMap,
  AgentPluginMcpServer,
  AgentPluginPackageSnapshot,
} from "../core/agentPlugins/contracts.js";
import { loadAgentPluginPackage } from "../core/agentPlugins/validation.js";
import {
  isProjectlessSessionScope,
  type SessionProjectScope,
} from "@agentlink/protocol/workspace-project";
import { createNodePluginPackageFileSystem } from "./agentPluginFileSystem.js";
import {
  AgentPluginStore,
  AgentPluginStoreError,
  digestAgentPluginTree,
  type AgentPluginDisposable,
  type AgentPluginMcpPolicyOverlay,
  type AgentPluginRegistryInvalidation,
  type AgentPluginRegistryScope,
} from "./AgentPluginStore.js";
import type { SkillEntry } from "./skillLoader.js";

export interface AgentPluginSkillProvenance {
  readonly installInstanceId: string;
  readonly packageDigest: string;
  readonly manifestName: string;
  readonly packageRelativePath: string;
  readonly effectiveScope: "global" | "project";
}

export interface AgentPluginCatalogDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly installInstanceId?: string;
  readonly packageDigest?: string;
  readonly path?: string;
}

export interface AgentPluginCatalogInstall {
  readonly installInstanceId: string;
  readonly packageDigest: string;
  readonly manifestName: string;
  readonly scope: "global" | "project";
  readonly effective: boolean;
  readonly shadowedByInstallInstanceId?: string;
}

export interface AgentPluginCatalogHookSource {
  readonly installInstanceId: string;
  readonly packageDigest: string;
  readonly manifestName: string;
  readonly scope: AgentPluginRegistryScope;
  readonly pluginRoot: string;
  readonly pluginData: string;
  readonly sourcePath: string;
  readonly sourceRelativePath: string;
  readonly description?: string;
  readonly hooks: AgentPluginHookEventMap;
}

export interface AgentPluginCatalogMcpServer {
  readonly installInstanceId: string;
  readonly packageDigest: string;
  readonly manifestName: string;
  readonly portableServerName: string;
  readonly server: AgentPluginMcpServer;
  readonly scope: AgentPluginRegistryScope;
  readonly pluginRoot: string;
  readonly pluginData: string;
  readonly policy: AgentPluginMcpPolicyOverlay;
}

export interface AgentPluginCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly registryRevision: number;
  readonly projectId: string;
  readonly workspaceFolderUri: string;
  readonly selectedDigests: Readonly<Record<string, string>>;
  readonly installs: readonly AgentPluginCatalogInstall[];
  readonly skills: readonly SkillEntry[];
  readonly mcpServers: readonly AgentPluginCatalogMcpServer[];
  /** Present on catalog-produced snapshots; optional for legacy/test providers. */
  readonly hooks?: readonly AgentPluginCatalogHookSource[];
  readonly diagnostics: readonly AgentPluginCatalogDiagnostic[];
}

export interface AgentPluginCatalogInvalidation {
  readonly registryRevision: number;
  readonly projectId?: string;
  readonly source: AgentPluginRegistryInvalidation["source"];
}

export interface AgentPluginCatalogProvider {
  getSnapshot(
    scope: Readonly<SessionProjectScope>,
  ): Promise<AgentPluginCatalogSnapshot>;
  subscribe(
    listener: (event: AgentPluginCatalogInvalidation) => void,
  ): AgentPluginDisposable;
}

export interface AgentPluginCatalogOptions {
  readonly enabled: boolean;
  readonly platform?: NodeJS.Platform;
}

export class AgentPluginCatalog implements AgentPluginCatalogProvider {
  private readonly cache = new Map<
    string,
    Promise<AgentPluginCatalogSnapshot>
  >();
  private readonly listeners = new Set<
    (event: AgentPluginCatalogInvalidation) => void
  >();
  private readonly storeSubscription: AgentPluginDisposable;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly store: AgentPluginStore,
    private readonly options: Readonly<AgentPluginCatalogOptions>,
  ) {
    this.platform = options.platform ?? process.platform;
    this.storeSubscription = store.subscribe((event) => {
      this.cache.clear();
      for (const listener of this.listeners) {
        listener({
          registryRevision: event.revision,
          source: event.source,
        });
      }
    });
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.cache.clear();
    this.listeners.clear();
  }

  subscribe(
    listener: (event: AgentPluginCatalogInvalidation) => void,
  ): AgentPluginDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async getSnapshot(
    scope: Readonly<SessionProjectScope>,
  ): Promise<AgentPluginCatalogSnapshot> {
    if (
      !this.options.enabled ||
      this.platform === "win32" ||
      isProjectlessSessionScope(scope) ||
      !scope.rootPath
    ) {
      return emptyCatalogSnapshot(scope);
    }

    let registry: Awaited<ReturnType<AgentPluginStore["checkForUpdates"]>>;
    try {
      registry = await this.store.checkForUpdates();
    } catch (error) {
      return unavailableCatalogSnapshot(scope, error);
    }
    const selectedRows = Object.values(registry.installs)
      .filter(
        (row) =>
          row.enabled &&
          (row.scope.kind === "global" ||
            (row.scope.projectId === scope.projectId &&
              row.scope.workspaceFolderUri === scope.workspaceFolderUri)),
      )
      .sort((left, right) =>
        left.installInstanceId.localeCompare(right.installInstanceId),
      );
    const selectedDigests = Object.fromEntries(
      selectedRows.map((row) => [row.installInstanceId, row.currentDigest]),
    );
    const cacheKey = stableHash({
      registryRevision: registry.revision,
      projectId: scope.projectId,
      workspaceFolderUri: scope.workspaceFolderUri,
      selectedDigests,
    });
    let snapshot = this.cache.get(cacheKey);
    if (!snapshot) {
      snapshot = this.buildSnapshot(scope, registry.revision, selectedRows);
      this.cache.set(cacheKey, snapshot);
    }
    return snapshot;
  }

  private async buildSnapshot(
    scope: Readonly<SessionProjectScope>,
    registryRevision: number,
    selectedRows: readonly import("./AgentPluginStore.js").AgentPluginRegistryRow[],
  ): Promise<AgentPluginCatalogSnapshot> {
    const diagnostics: AgentPluginCatalogDiagnostic[] = [];
    const loaded = new Map<
      string,
      {
        row: (typeof selectedRows)[number];
        package: AgentPluginPackageSnapshot;
        skills: SkillEntry[];
      }
    >();

    for (const row of selectedRows) {
      const packagePath = this.store.getPackagePath(
        row.installInstanceId,
        row.currentDigest,
      );
      try {
        const actualDigest = await digestAgentPluginTree(packagePath);
        if (actualDigest !== row.currentDigest) {
          diagnostics.push({
            code: "installed_package_digest_mismatch",
            severity: "error",
            message: "Installed immutable package failed digest verification.",
            installInstanceId: row.installInstanceId,
            packageDigest: row.currentDigest,
            path: packagePath,
          });
          continue;
        }
        const packageSnapshot = await loadAgentPluginPackage({
          rootPath: packagePath,
          fileSystem: createNodePluginPackageFileSystem(),
        });
        diagnostics.push(
          ...packageSnapshot.diagnostics.map((diagnostic) =>
            toCatalogDiagnostic(
              row.installInstanceId,
              row.currentDigest,
              diagnostic,
            ),
          ),
        );
        if (
          !packageSnapshot.valid ||
          !packageSnapshot.manifest ||
          packageSnapshot.manifest.name !== row.manifestName ||
          packageSnapshot.manifest.schema !== row.manifestSchema
        ) {
          diagnostics.push({
            code: "installed_package_registry_mismatch",
            severity: "error",
            message:
              "Installed package manifest does not match its authoritative registry row.",
            installInstanceId: row.installInstanceId,
            packageDigest: row.currentDigest,
            path: packagePath,
          });
          continue;
        }
        loaded.set(row.installInstanceId, {
          row,
          package: packageSnapshot,
          skills: await Promise.all(
            packageSnapshot.skills.map((skill) =>
              toSkillEntry(row, packageSnapshot, skill.skillPath),
            ),
          ),
        });
      } catch (error) {
        diagnostics.push({
          code: "installed_package_unavailable",
          severity: "error",
          message: `Installed package is unavailable: ${errorMessage(error)}`,
          installInstanceId: row.installInstanceId,
          packageDigest: row.currentDigest,
          path: packagePath,
        });
      }
    }

    const effectiveByManifest = new Map<string, string>();
    for (const item of loaded.values()) {
      const existingId = effectiveByManifest.get(item.row.manifestName);
      if (!existingId) {
        effectiveByManifest.set(
          item.row.manifestName,
          item.row.installInstanceId,
        );
        continue;
      }
      const existing = loaded.get(existingId)!;
      if (
        existing.row.scope.kind === "global" &&
        item.row.scope.kind === "project"
      ) {
        effectiveByManifest.set(
          item.row.manifestName,
          item.row.installInstanceId,
        );
      }
    }

    const installs: AgentPluginCatalogInstall[] = [];
    const skills: SkillEntry[] = [];
    const mcpServers: AgentPluginCatalogMcpServer[] = [];
    const hooks: AgentPluginCatalogHookSource[] = [];
    for (const item of loaded.values()) {
      const effectiveId = effectiveByManifest.get(item.row.manifestName);
      const effective = effectiveId === item.row.installInstanceId;
      installs.push({
        installInstanceId: item.row.installInstanceId,
        packageDigest: item.row.currentDigest,
        manifestName: item.row.manifestName,
        scope: item.row.scope.kind,
        effective,
        ...(effective || !effectiveId
          ? {}
          : { shadowedByInstallInstanceId: effectiveId }),
      });
      if (effective) {
        skills.push(...item.skills);
        const pluginData =
          item.row.scope.kind === "global"
            ? this.store.getGlobalDataPath(item.row.installInstanceId)
            : this.store.getProjectDataPath(
                item.row.scope.projectId,
                item.row.installInstanceId,
              );
        for (const hookSource of item.package.hooks) {
          hooks.push({
            installInstanceId: item.row.installInstanceId,
            packageDigest: item.row.currentDigest,
            manifestName: item.row.manifestName,
            scope: item.row.scope,
            pluginRoot: item.package.rootPath,
            pluginData,
            sourcePath: hookSource.sourcePath,
            sourceRelativePath: hookSource.sourceRelativePath,
            ...(hookSource.description
              ? { description: hookSource.description }
              : {}),
            hooks: hookSource.hooks,
          });
        }
        for (const [portableServerName, server] of Object.entries(
          item.package.mcp?.servers ?? {},
        )) {
          mcpServers.push({
            installInstanceId: item.row.installInstanceId,
            packageDigest: item.row.currentDigest,
            manifestName: item.row.manifestName,
            portableServerName,
            server,
            scope: item.row.scope,
            pluginRoot: item.package.rootPath,
            pluginData,
            policy: item.row.policy.mcp?.[portableServerName] ?? {},
          });
        }
      }
    }

    installs.sort((left, right) =>
      left.installInstanceId.localeCompare(right.installInstanceId),
    );
    skills.sort((left, right) => left.id.localeCompare(right.id));
    mcpServers.sort((left, right) =>
      `${left.installInstanceId}:${left.portableServerName}`.localeCompare(
        `${right.installInstanceId}:${right.portableServerName}`,
      ),
    );
    hooks.sort((left, right) =>
      `${left.installInstanceId}:${left.sourceRelativePath}`.localeCompare(
        `${right.installInstanceId}:${right.sourceRelativePath}`,
      ),
    );
    diagnostics.sort((left, right) =>
      `${left.installInstanceId ?? ""}:${left.code}:${left.path ?? ""}`.localeCompare(
        `${right.installInstanceId ?? ""}:${right.code}:${right.path ?? ""}`,
      ),
    );
    return {
      schemaVersion: 1,
      registryRevision,
      projectId: scope.projectId,
      workspaceFolderUri: scope.workspaceFolderUri,
      selectedDigests: Object.fromEntries(
        selectedRows.map((row) => [row.installInstanceId, row.currentDigest]),
      ),
      installs,
      skills,
      mcpServers,
      hooks,
      diagnostics,
    };
  }
}

async function toSkillEntry(
  row: import("./AgentPluginStore.js").AgentPluginRegistryRow,
  packageSnapshot: AgentPluginPackageSnapshot,
  skillPath: string,
): Promise<SkillEntry> {
  const skill = packageSnapshot.skills.find(
    (item) => item.skillPath === skillPath,
  )!;
  const raw = await fs.readFile(skillPath, "utf8");
  const relativePath = toPosix(
    path.relative(packageSnapshot.rootPath, skillPath),
  );
  const scope = row.scope.kind;
  const id = `${scope}:plugin:${row.installInstanceId}/skills/${skill.name}`;
  const allowedTools = skill.metadata.allowedTools
    ?.split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    id,
    name: skill.name,
    description: skill.metadata.description,
    revision: createHash("sha256").update(raw).digest("hex"),
    sourceChars: raw.length,
    provenance: {
      scope,
      namespace: "plugin",
      sourceRoot: packageSnapshot.rootPath,
      skillDirectory: skill.directoryPath,
      realSkillPath: skill.skillPath,
      priority: -1,
      plugin: {
        installInstanceId: row.installInstanceId,
        packageDigest: row.currentDigest,
        manifestName: row.manifestName,
        packageRelativePath: relativePath,
        effectiveScope: scope,
      },
    },
    skillPath,
    allowedTools,
    restrictions: { allowedTools },
    permissions: { requestedTools: [] },
    dependencies: [],
    recommendations: [],
    resolvedDependencies: [],
    enabled: true,
  };
}

function toCatalogDiagnostic(
  installInstanceId: string,
  packageDigest: string,
  diagnostic: AgentPluginDiagnostic,
): AgentPluginCatalogDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    installInstanceId,
    packageDigest,
    path: diagnostic.path,
  };
}

function emptyCatalogSnapshot(
  scope: Readonly<SessionProjectScope>,
): AgentPluginCatalogSnapshot {
  return catalogSnapshotWithoutPlugins(scope, []);
}

function unavailableCatalogSnapshot(
  scope: Readonly<SessionProjectScope>,
  error: unknown,
): AgentPluginCatalogSnapshot {
  const code =
    error instanceof AgentPluginStoreError
      ? `agent_plugin_${error.code}`
      : "agent_plugin_registry_unavailable";
  return catalogSnapshotWithoutPlugins(scope, [
    {
      code,
      severity: "error",
      message: `Agent plugin activation is disabled until the registry is repaired: ${errorMessage(error)}`,
    },
  ]);
}

function catalogSnapshotWithoutPlugins(
  scope: Readonly<SessionProjectScope>,
  diagnostics: readonly AgentPluginCatalogDiagnostic[],
): AgentPluginCatalogSnapshot {
  return {
    schemaVersion: 1,
    registryRevision: 0,
    projectId: scope.projectId,
    workspaceFolderUri: scope.workspaceFolderUri,
    selectedDigests: {},
    installs: [],
    skills: [],
    mcpServers: [],
    hooks: [],
    diagnostics,
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

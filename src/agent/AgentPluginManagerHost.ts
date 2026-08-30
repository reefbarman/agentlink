import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createHash } from "node:crypto";

import type {
  AgentPluginManifest,
  AgentPluginMcpServer,
} from "../core/agentPlugins/contracts.js";
import { loadAgentPluginPackage } from "../core/agentPlugins/validation.js";
import { isPathWithin } from "../core/agentPlugins/pathPolicy.js";
import type {
  AgentPluginManagerDiagnostic,
  AgentPluginManagerMcpSummary,
  AgentPluginManagerRow,
  AgentPluginManagerSnapshot as SharedAgentPluginManagerSnapshot,
  AgentPluginManagerSourceSummary,
} from "@agentlink/protocol/agent-plugin-manager";
import type { McpConfigMutationTarget } from "@agentlink/protocol/mcp-manager";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type { ProjectScopeResolver } from "../core/workspaceProjects.js";
import {
  AgentPluginInstaller,
  type AcquiredAgentPluginSource,
  type AgentPluginInstallCandidate,
} from "./AgentPluginInstaller.js";
import {
  AgentPluginStore,
  AgentPluginStoreError,
  type AgentPluginMcpPolicyOverlay,
  type AgentPluginRegistry,
  type AgentPluginRegistryRow,
  type AgentPluginRegistryScope,
  type AgentPluginSourceProvenance,
} from "./AgentPluginStore.js";
import { createNodePluginPackageFileSystem } from "./agentPluginFileSystem.js";
import { agentPluginMcpRuntimeServerName } from "./agentPluginMcpRuntime.js";
import {
  parseAgentPluginSource,
  type AgentPluginSource,
} from "./agentPluginSources.js";
import {
  readAgentPluginProjectDeclarations,
  resolveAgentPluginProjectDeclaration,
  upsertAgentPluginProjectDeclaration,
  type AgentPluginProjectDeclaration,
  type AgentPluginProjectDeclarationDiagnostic,
} from "./agentPluginProjectDeclarations.js";

export type AgentPluginInstallTarget =
  | { readonly kind: "global" }
  | {
      readonly kind: "project";
      readonly scope: Readonly<SessionProjectScope>;
    };

export interface PreparedAgentPluginInstall {
  readonly acquired: AcquiredAgentPluginSource;
  readonly candidates: readonly AgentPluginInstallCandidate[];
  readonly target: AgentPluginInstallTarget;
  readonly expectedManifestName?: string;
  readonly declarationToWrite?: AgentPluginProjectDeclaration;
  readonly declarationRevision?: string;
  readonly shareability: "shareable" | "not-shareable" | "not-applicable";
}

export interface AgentPluginManagerEntry {
  readonly status: "installed" | "declared";
  readonly manifestName: string;
  readonly scope: AgentPluginRegistryScope;
  readonly install?: AgentPluginRegistryRow;
  readonly declaration?: AgentPluginProjectDeclaration;
  readonly shareability: "shareable" | "not-shareable" | "not-applicable";
  readonly effective?: boolean;
  readonly shadowedByInstallInstanceId?: string;
  readonly diagnostics: readonly AgentPluginProjectDeclarationDiagnostic[];
}

export type AgentPluginDeclarationCommitOutcome =
  | { readonly status: "not-applicable" }
  | { readonly status: "written"; readonly declarationPath: string }
  | { readonly status: "failed"; readonly message: string };

export type AgentPluginCommitResult = AgentPluginRegistryRow & {
  readonly declarationOutcome: AgentPluginDeclarationCommitOutcome;
};

export interface AgentPluginManagerSnapshot {
  readonly registryRevision: number;
  readonly entries: readonly AgentPluginManagerEntry[];
  readonly declarationDiagnostics: readonly AgentPluginProjectDeclarationDiagnostic[];
}

export interface CommitPreparedAgentPluginRequest {
  readonly prepared: PreparedAgentPluginInstall;
  readonly candidate: AgentPluginInstallCandidate;
  readonly enabled: boolean;
  readonly scope?: AgentPluginRegistryScope;
  readonly target?: AgentPluginInstallTarget;
  readonly replacingInstallInstanceId?: string;
}

export interface AgentPluginManagerHostOptions {
  readonly enabled: boolean;
  readonly now?: () => Date;
  readonly projectResolver?: ProjectScopeResolver;
}

export interface MutateAgentPluginMcpPolicyRequest {
  readonly target: Extract<
    McpConfigMutationTarget,
    { kind: "agent-plugin-overlay" }
  >;
  readonly expectedRevision?: number;
  readonly update: (
    policy: Readonly<AgentPluginMcpPolicyOverlay>,
  ) => AgentPluginMcpPolicyOverlay;
}

export class AgentPluginManagerError extends Error {
  constructor(
    readonly code:
      | "plugins_disabled"
      | "install_conflict"
      | "install_not_found"
      | "update_source_unavailable"
      | "update_candidate_missing"
      | "project_scope_unavailable"
      | "declared_plugin_not_found"
      | "declared_source_unavailable"
      | "declared_name_mismatch"
      | "declared_name_ambiguous"
      | "mcp_scope_mismatch"
      | "mcp_package_changed"
      | "mcp_server_not_found"
      | "rollback_unavailable"
      | "rollback_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AgentPluginManagerError";
  }
}

export class AgentPluginManagerHost {
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentPluginStore,
    private readonly installer: AgentPluginInstaller,
    private readonly options: Readonly<AgentPluginManagerHostOptions>,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<Readonly<AgentPluginRegistry>> {
    this.requireEnabled();
    return this.store.checkForUpdates();
  }

  async getSnapshot(
    projectScope?: Readonly<SessionProjectScope>,
  ): Promise<AgentPluginManagerSnapshot> {
    this.requireEnabled();
    const registry = await this.store.checkForUpdates();
    const entries: AgentPluginManagerEntry[] = Object.values(registry.installs)
      .filter(
        (row) =>
          row.scope.kind === "global" ||
          (projectScope !== undefined &&
            sameProjectScope(row.scope, projectScope)),
      )
      .map((row) => ({
        status: "installed",
        manifestName: row.manifestName,
        scope: row.scope,
        install: row,
        shareability:
          row.scope.kind === "project"
            ? isShareableSource(row.source)
              ? "shareable"
              : "not-shareable"
            : "not-applicable",
        effective: row.enabled,
        diagnostics: [],
      }));
    const effectiveProjectInstalls = new Map(
      entries
        .filter(
          (entry) =>
            entry.install?.enabled && entry.install.scope.kind === "project",
        )
        .map((entry) => [entry.manifestName, entry.install!]),
    );
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.install?.scope.kind !== "global" || !entry.install.enabled)
        continue;
      const projectInstall = effectiveProjectInstalls.get(entry.manifestName);
      if (!projectInstall) continue;
      entries[index] = {
        ...entry,
        effective: false,
        shadowedByInstallInstanceId: projectInstall.installInstanceId,
      };
    }
    let declarationDiagnostics: readonly AgentPluginProjectDeclarationDiagnostic[] =
      [];
    if (projectScope) {
      const target = this.canonicalProjectTarget(projectScope);
      const declarations = await readAgentPluginProjectDeclarations(
        target.scope,
      );
      declarationDiagnostics = declarations.diagnostics;
      for (const declaration of declarations.declarations) {
        const installed = entries.some(
          (entry) =>
            entry.install?.scope.kind === "project" &&
            entry.manifestName === declaration.name &&
            declarationMatchesSource(declaration, entry.install.source),
        );
        if (!installed) {
          entries.push({
            status: "declared",
            manifestName: declaration.name,
            scope: registryScopeForTarget(target),
            declaration,
            shareability: "shareable",
            diagnostics: declarations.diagnostics.filter(
              (diagnostic) => diagnostic.name === declaration.name,
            ),
          });
        }
      }
    }
    entries.sort((left, right) =>
      `${left.manifestName}:${left.status}`.localeCompare(
        `${right.manifestName}:${right.status}`,
      ),
    );
    return {
      registryRevision: registry.revision,
      entries,
      declarationDiagnostics,
    };
  }

  async getManagerSnapshot(
    projectScope?: Readonly<SessionProjectScope>,
    options: { readonly readOnly?: boolean } = {},
  ): Promise<SharedAgentPluginManagerSnapshot> {
    const canonicalScope = projectScope
      ? this.canonicalProjectTarget(projectScope).scope
      : undefined;
    const snapshot = await this.getSnapshot(canonicalScope);
    const rows = await Promise.all(
      snapshot.entries.slice(0, 100).map((entry) =>
        this.toManagerRow(entry).catch(
          (error): AgentPluginManagerRow => ({
            status: "invalid",
            manifestName: entry.manifestName,
            scope: entry.scope.kind,
            ...(entry.scope.kind === "project"
              ? { projectId: entry.scope.projectId }
              : {}),
            source: managerSourceSummary(entry),
            skills: [],
            mcpServers: [],
            hooks: [],
            diagnostics: [
              {
                code: "manager_package_unavailable",
                severity: "error",
                message: boundedMessage(errorMessage(error)),
              },
            ],
            ...(entry.install
              ? {
                  installInstanceId: entry.install.installInstanceId,
                  enabled: entry.install.enabled,
                  currentDigest: entry.install.currentDigest,
                  ...(entry.install.previousDigest
                    ? { previousDigest: entry.install.previousDigest }
                    : {}),
                }
              : {}),
          }),
        ),
      ),
    );
    const diagnostics = snapshot.declarationDiagnostics
      .slice(0, 100)
      .map(toManagerDeclarationDiagnostic);
    const readOnly = options.readOnly === true;
    const projects = (this.options.projectResolver?.listProjects() ?? []).map(
      (project) => ({
        projectId: project.id,
        displayName: project.name,
        availability:
          project.availability.status === "available"
            ? ("available" as const)
            : ("unavailable" as const),
      }),
    );
    return {
      schemaVersion: 1,
      registryRevision: snapshot.registryRevision,
      catalogRevision: snapshot.registryRevision,
      ...(canonicalScope
        ? {
            project: {
              projectId: canonicalScope.projectId,
              displayName: canonicalScope.displayName,
              availability: "available" as const,
            },
          }
        : {}),
      projects,
      rows,
      diagnostics,
      capabilities: {
        canInstall: !readOnly,
        canEnable: !readOnly,
        canInspect: true,
        canReinstall: !readOnly,
        canRollback: !readOnly,
        canUninstall: !readOnly,
        canRemoveData: !readOnly,
        canEditPolicy: !readOnly,
      },
      ...(readOnly ? { readOnlyReason: "Manage plugins in VS Code." } : {}),
    };
  }

  async prepareInstall(
    sourceText: string,
    options: {
      readonly cwd?: string;
      readonly ref?: string;
      readonly target?: AgentPluginInstallTarget;
    } = {},
    signal?: AbortSignal,
  ): Promise<PreparedAgentPluginInstall> {
    this.requireEnabled();
    const target = this.canonicalizeTarget(
      options.target ?? { kind: "global" },
    );
    let source = await parseAgentPluginSource(sourceText, options);
    source = await this.annotateProjectSource(source, target);
    const acquired = await this.installer.acquire(source, signal);
    const shareability = shareabilityForSource(acquired.provenance, target);
    const declarationRevision =
      target.kind === "project" && shareability === "shareable"
        ? (await readAgentPluginProjectDeclarations(target.scope)).revision
        : undefined;
    return {
      acquired,
      candidates: acquired.candidates,
      target,
      shareability,
      ...(declarationRevision ? { declarationRevision } : {}),
    };
  }

  async prepareDeclaredInstall(
    scope: Readonly<SessionProjectScope>,
    manifestName: string,
    signal?: AbortSignal,
  ): Promise<PreparedAgentPluginInstall> {
    this.requireEnabled();
    const target = this.canonicalProjectTarget(scope);
    const snapshot = await readAgentPluginProjectDeclarations(target.scope);
    const declaration = snapshot.declarations.find(
      (candidate) => candidate.name === manifestName,
    );
    if (!declaration) {
      throw new AgentPluginManagerError(
        "declared_plugin_not_found",
        `No Agent Plugin declaration named '${manifestName}' exists in this project.`,
      );
    }
    const resolved = await resolveAgentPluginProjectDeclaration(
      target.scope,
      declaration,
    );
    if (resolved.status === "unavailable") {
      throw new AgentPluginManagerError(
        "declared_source_unavailable",
        resolved.diagnostic.message,
      );
    }
    const acquired = await this.installer.acquire(resolved.source, signal);
    const candidates = acquired.candidates.filter(
      (candidate) => candidate.snapshot.manifest?.name === manifestName,
    );
    if (candidates.length !== 1) {
      await acquired.cleanup();
      throw new AgentPluginManagerError(
        candidates.length === 0
          ? "declared_name_mismatch"
          : "declared_name_ambiguous",
        candidates.length === 0
          ? `Declared plugin '${manifestName}' was not found in the acquired source.`
          : `Declared plugin '${manifestName}' matched more than one package in the acquired source.`,
      );
    }
    return {
      acquired,
      candidates,
      target,
      expectedManifestName: manifestName,
      declarationToWrite: declaration,
      declarationRevision: snapshot.revision,
      shareability: "shareable",
    };
  }

  async prepareUpdate(
    installInstanceId: string,
    signal?: AbortSignal,
  ): Promise<PreparedAgentPluginInstall> {
    this.requireEnabled();
    const registry = await this.store.checkForUpdates();
    const row = registry.installs[installInstanceId];
    if (!row) {
      throw new AgentPluginManagerError(
        "install_not_found",
        `No installed plugin matched '${installInstanceId}'.`,
      );
    }
    const target = this.targetForRow(row);
    const source = await sourceFromProvenance(row.source, target);
    if (!source) {
      throw new AgentPluginManagerError(
        "update_source_unavailable",
        "This local plugin source path was intentionally not persisted. Run /plugin install <source> again to review a replacement.",
      );
    }
    const acquired = await this.installer.acquire(source, signal);
    const candidatePath = row.source.candidatePath ?? ".";
    const candidates = acquired.candidates.filter(
      (candidate) => candidate.relativePath === candidatePath,
    );
    if (candidates.length === 0) {
      await acquired.cleanup();
      throw new AgentPluginManagerError(
        "update_candidate_missing",
        `The recorded plugin candidate '${candidatePath}' is no longer present at the source.`,
      );
    }
    return {
      acquired,
      candidates,
      target,
      expectedManifestName: row.manifestName,
      shareability: shareabilityForSource(acquired.provenance, target),
      ...(target.kind === "project" && isShareableSource(acquired.provenance)
        ? {
            declarationRevision: (
              await readAgentPluginProjectDeclarations(target.scope)
            ).revision,
          }
        : {}),
    };
  }

  async commitPrepared(
    request: Readonly<CommitPreparedAgentPluginRequest>,
  ): Promise<AgentPluginCommitResult> {
    this.requireEnabled();
    const manifest = requireManifest(request.candidate);
    const expectedManifestName = request.prepared.expectedManifestName;
    if (expectedManifestName && manifest.name !== expectedManifestName) {
      throw new AgentPluginManagerError(
        "declared_name_mismatch",
        `Selected plugin '${manifest.name}' does not match declared plugin '${expectedManifestName}'.`,
      );
    }
    const target = this.canonicalizeTarget(
      request.target ?? request.prepared.target,
    );
    const scope = registryScopeForTarget(target);
    if (request.scope && !sameScope(request.scope, scope)) {
      throw new AgentPluginManagerError(
        "project_scope_unavailable",
        "The requested install scope does not match the prepared plugin target.",
      );
    }
    let registry = await this.store.checkForUpdates();
    const replacing = request.replacingInstallInstanceId
      ? registry.installs[request.replacingInstallInstanceId]
      : undefined;
    if (request.replacingInstallInstanceId && !replacing) {
      throw new AgentPluginManagerError(
        "install_not_found",
        `No installed plugin matched '${request.replacingInstallInstanceId}'.`,
      );
    }
    const conflict = Object.values(registry.installs).find(
      (row) =>
        row.installInstanceId !== replacing?.installInstanceId &&
        row.manifestName === manifest.name &&
        sameScope(row.scope, scope),
    );
    if (conflict) {
      throw new AgentPluginManagerError(
        "install_conflict",
        `Plugin '${manifest.name}' is already installed in this scope as '${conflict.installInstanceId}'. Update or remove it first.`,
      );
    }
    const provenance = withCandidatePath(
      request.prepared.acquired.provenance,
      request.candidate.relativePath,
    );
    const installInstanceId =
      replacing?.installInstanceId ??
      createInstallInstanceId(manifest.name, scope, provenance);
    await this.store.commitPackage({
      installInstanceId,
      stagedDirectory: request.candidate.rootPath,
      expectedDigest: request.candidate.digest,
    });

    const installedAt = replacing?.installedAt ?? this.now().toISOString();
    const updatedAt = this.now().toISOString();
    const row: AgentPluginRegistryRow = {
      installInstanceId,
      scope,
      manifestName: manifest.name,
      ...(manifest.version ? { manifestVersion: manifest.version } : {}),
      manifestSchema: manifest.schema,
      currentDigest: request.candidate.digest,
      ...(replacing?.currentDigest &&
      replacing.currentDigest !== request.candidate.digest
        ? { previousDigest: replacing.currentDigest }
        : replacing?.previousDigest
          ? { previousDigest: replacing.previousDigest }
          : {}),
      source: provenance,
      enabled: request.enabled,
      installedAt,
      updatedAt,
      policy: replacing?.policy ?? {},
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const committed = (
          await this.store.mutateRegistry({
            expectedRevision: registry.revision,
            apply: (latest) => ({
              registry: {
                ...latest,
                installs: { ...latest.installs, [installInstanceId]: row },
              },
              result: row,
            }),
          })
        ).result;
        let declarationOutcome: AgentPluginDeclarationCommitOutcome = {
          status: "not-applicable",
        };
        if (
          target.kind === "project" &&
          request.prepared.shareability === "shareable" &&
          request.prepared.declarationRevision
        ) {
          const declaration =
            request.prepared.declarationToWrite ??
            declarationForInstall(committed);
          if (declaration) {
            try {
              const declarationSnapshot =
                await upsertAgentPluginProjectDeclaration({
                  scope: target.scope,
                  declaration,
                  expectedRevision: request.prepared.declarationRevision,
                });
              declarationOutcome = {
                status: "written",
                declarationPath: declarationSnapshot.declarationPath,
              };
            } catch (error) {
              declarationOutcome = {
                status: "failed",
                message: errorMessage(error),
              };
            }
          }
        }
        return { ...committed, declarationOutcome };
      } catch (error) {
        if (
          !(error instanceof AgentPluginStoreError) ||
          error.code !== "registry_revision_conflict" ||
          attempt === 2
        ) {
          throw error;
        }
        registry = await this.store.checkForUpdates();
        const concurrentConflict = Object.values(registry.installs).find(
          (candidate) =>
            candidate.installInstanceId !== replacing?.installInstanceId &&
            candidate.manifestName === manifest.name &&
            sameScope(candidate.scope, scope),
        );
        if (concurrentConflict) {
          throw new AgentPluginManagerError(
            "install_conflict",
            `Plugin '${manifest.name}' was installed concurrently as '${concurrentConflict.installInstanceId}'.`,
          );
        }
      }
    }
    throw new Error("Agent plugin registry mutation retry exhausted.");
  }

  async setEnabled(installInstanceId: string, enabled: boolean): Promise<void> {
    await this.mutateExisting(installInstanceId, (row) => ({
      ...row,
      enabled,
      updatedAt: this.now().toISOString(),
    }));
  }

  async rollback(installInstanceId: string): Promise<AgentPluginRegistryRow> {
    let rolledBack: AgentPluginRegistryRow | undefined;
    await this.mutateExisting(installInstanceId, async (row) => {
      if (!row.previousDigest) {
        throw new AgentPluginManagerError(
          "rollback_unavailable",
          `Agent Plugin '${row.manifestName}' has no previous generation to restore.`,
        );
      }
      const snapshot = await loadAgentPluginPackage({
        rootPath: this.store.getPackagePath(
          row.installInstanceId,
          row.previousDigest,
        ),
        fileSystem: createNodePluginPackageFileSystem(),
      });
      if (
        !snapshot.valid ||
        snapshot.manifest?.name !== row.manifestName ||
        snapshot.manifest.schema !== row.manifestSchema
      ) {
        throw new AgentPluginManagerError(
          "rollback_invalid",
          "The previous Agent Plugin generation no longer matches the installed plugin authority.",
        );
      }
      rolledBack = {
        ...row,
        currentDigest: row.previousDigest,
        previousDigest: row.currentDigest,
        manifestVersion: snapshot.manifest.version,
        updatedAt: this.now().toISOString(),
      };
      return rolledBack;
    });
    return rolledBack!;
  }

  async removeData(installInstanceId: string): Promise<void> {
    this.requireEnabled();
    const registry = await this.store.checkForUpdates();
    const row = registry.installs[installInstanceId];
    if (!row) {
      throw new AgentPluginManagerError(
        "install_not_found",
        `No installed plugin matched '${installInstanceId}'.`,
      );
    }
    const dataPath =
      row.scope.kind === "global"
        ? this.store.getGlobalDataPath(row.installInstanceId)
        : this.store.getProjectDataPath(
            row.scope.projectId,
            row.installInstanceId,
          );
    await fs.rm(dataPath, { recursive: true, force: true });
  }

  async mutateMcpPolicy(
    request: Readonly<MutateAgentPluginMcpPolicyRequest>,
  ): Promise<AgentPluginRegistryRow> {
    let mutated: AgentPluginRegistryRow | undefined;
    await this.mutateExisting(
      request.target.installInstanceId,
      async (row) => {
        this.assertMcpMutationTarget(row, request.target);
        const servers = await this.loadCurrentMcpServers(row);
        if (!servers[request.target.declaredServerName]) {
          throw new AgentPluginManagerError(
            "mcp_server_not_found",
            `Plugin MCP server '${request.target.declaredServerName}' no longer exists in the installed package.`,
          );
        }
        const current =
          row.policy.mcp?.[request.target.declaredServerName] ?? {};
        const nextPolicy = request.update(current);
        mutated = {
          ...row,
          updatedAt: this.now().toISOString(),
          policy: {
            ...row.policy,
            mcp: {
              ...row.policy.mcp,
              [request.target.declaredServerName]: nextPolicy,
            },
          },
        };
        return mutated;
      },
      request.expectedRevision,
    );
    return mutated!;
  }

  async remove(installInstanceId: string): Promise<void> {
    this.requireEnabled();
    let registry = await this.store.checkForUpdates();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!registry.installs[installInstanceId]) {
        throw new AgentPluginManagerError(
          "install_not_found",
          `No installed plugin matched '${installInstanceId}'.`,
        );
      }
      try {
        await this.store.mutateRegistry({
          expectedRevision: registry.revision,
          apply: (latest) => {
            const installs = { ...latest.installs };
            delete installs[installInstanceId];
            return { registry: { ...latest, installs }, result: undefined };
          },
        });
        return;
      } catch (error) {
        if (
          !(error instanceof AgentPluginStoreError) ||
          error.code !== "registry_revision_conflict" ||
          attempt === 2
        ) {
          throw error;
        }
        registry = await this.store.checkForUpdates();
      }
    }
  }

  async requestPurge(): Promise<void> {
    this.requireEnabled();
    const registry = await this.store.checkForUpdates();
    await this.store.requestPurge(registry.revision);
  }

  private async mutateExisting(
    installInstanceId: string,
    update: (
      row: AgentPluginRegistryRow,
    ) => AgentPluginRegistryRow | Promise<AgentPluginRegistryRow>,
    expectedRevision?: number,
  ): Promise<void> {
    this.requireEnabled();
    let registry = await this.store.checkForUpdates();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        expectedRevision !== undefined &&
        registry.revision !== expectedRevision
      ) {
        throw new AgentPluginStoreError(
          "registry_revision_conflict",
          `Agent plugin registry revision changed from ${expectedRevision} to ${registry.revision}.`,
        );
      }
      const row = registry.installs[installInstanceId];
      if (!row) {
        throw new AgentPluginManagerError(
          "install_not_found",
          `No installed plugin matched '${installInstanceId}'.`,
        );
      }
      const updated = await update(row);
      try {
        await this.store.mutateRegistry({
          expectedRevision: registry.revision,
          apply: (latest) => ({
            registry: {
              ...latest,
              installs: {
                ...latest.installs,
                [installInstanceId]: updated,
              },
            },
            result: undefined,
          }),
        });
        return;
      } catch (error) {
        if (
          !(error instanceof AgentPluginStoreError) ||
          error.code !== "registry_revision_conflict" ||
          attempt === 2
        ) {
          throw error;
        }
        registry = await this.store.checkForUpdates();
      }
    }
  }

  private assertMcpMutationTarget(
    row: Readonly<AgentPluginRegistryRow>,
    target: Extract<McpConfigMutationTarget, { kind: "agent-plugin-overlay" }>,
  ): void {
    const expectedRuntimeServerName = agentPluginMcpRuntimeServerName(
      row.installInstanceId,
      target.declaredServerName,
    );
    if (target.runtimeServerName !== expectedRuntimeServerName) {
      throw new AgentPluginManagerError(
        "mcp_server_not_found",
        "The plugin MCP runtime identity no longer matches the installed server.",
      );
    }
    if (
      row.scope.kind !== target.scope ||
      (row.scope.kind === "project" &&
        row.scope.projectId !== target.projectId) ||
      row.currentDigest !== target.packageDigest
    ) {
      throw new AgentPluginManagerError(
        row.currentDigest !== target.packageDigest
          ? "mcp_package_changed"
          : "mcp_scope_mismatch",
        row.currentDigest !== target.packageDigest
          ? "The plugin package changed before its MCP policy could be saved."
          : "The requesting project does not own this plugin MCP policy.",
      );
    }
  }

  private async loadCurrentMcpServers(
    row: Readonly<AgentPluginRegistryRow>,
  ): Promise<Readonly<Record<string, AgentPluginMcpServer>>> {
    const snapshot = await loadAgentPluginPackage({
      rootPath: this.store.getPackagePath(
        row.installInstanceId,
        row.currentDigest,
      ),
      fileSystem: createNodePluginPackageFileSystem(),
    });
    if (
      !snapshot.valid ||
      snapshot.manifest?.name !== row.manifestName ||
      snapshot.manifest?.schema !== row.manifestSchema
    ) {
      throw new AgentPluginManagerError(
        "mcp_package_changed",
        "The installed plugin package no longer matches its registry authority.",
      );
    }
    return snapshot.mcp?.servers ?? {};
  }

  private canonicalProjectTarget(
    scope: Readonly<SessionProjectScope>,
  ): Extract<AgentPluginInstallTarget, { kind: "project" }> {
    const target = this.canonicalizeTarget({ kind: "project", scope });
    if (target.kind !== "project") {
      throw new AgentPluginManagerError(
        "project_scope_unavailable",
        "Project plugin target unexpectedly resolved as global.",
      );
    }
    return target;
  }

  private canonicalizeTarget(
    target: Readonly<AgentPluginInstallTarget>,
  ): AgentPluginInstallTarget {
    if (target.kind === "global") return { kind: "global" };
    const resolution = this.options.projectResolver?.resolvePersistedScope(
      target.scope as SessionProjectScope,
    );
    if (resolution) {
      if (resolution.status !== "available") {
        throw new AgentPluginManagerError(
          "project_scope_unavailable",
          `Project '${target.scope.displayName}' is not available for Agent Plugin management.`,
        );
      }
      return { kind: "project", scope: resolution.scope };
    }
    if (!target.scope.rootPath) {
      throw new AgentPluginManagerError(
        "project_scope_unavailable",
        `Project '${target.scope.displayName}' has no available local root.`,
      );
    }
    return { kind: "project", scope: { ...target.scope } };
  }

  private targetForRow(
    row: Readonly<AgentPluginRegistryRow>,
  ): AgentPluginInstallTarget {
    if (row.scope.kind === "global") return { kind: "global" };
    return this.canonicalizeTarget({
      kind: "project",
      scope: {
        schemaVersion: 1,
        kind: "project",
        projectId: row.scope.projectId,
        workspaceFolderUri: row.scope.workspaceFolderUri,
        displayName: row.manifestName,
      },
    });
  }

  private async annotateProjectSource(
    source: Readonly<AgentPluginSource>,
    target: Readonly<AgentPluginInstallTarget>,
  ): Promise<AgentPluginSource> {
    if (target.kind !== "project" || source.kind !== "local-directory") {
      return source;
    }
    const rootPath = target.scope.rootPath;
    if (!rootPath) return source;
    const [realRoot, realSource] = await Promise.all([
      fs.realpath(rootPath),
      fs.realpath(source.path),
    ]);
    if (!isPathWithin(realSource, realRoot)) return source;
    const relative = path
      .relative(realRoot, realSource)
      .split(path.sep)
      .join("/");
    if (!relative || relative.startsWith("../")) return source;
    return { ...source, workspaceRelativePath: relative };
  }

  private async toManagerRow(
    entry: Readonly<AgentPluginManagerEntry>,
  ): Promise<AgentPluginManagerRow> {
    if (!entry.install) {
      return {
        status: "declared",
        manifestName: entry.manifestName,
        scope: entry.scope.kind,
        ...(entry.scope.kind === "project"
          ? { projectId: entry.scope.projectId }
          : {}),
        source: managerSourceSummary(entry),
        skills: [],
        mcpServers: [],
        hooks: [],
        diagnostics: entry.diagnostics
          .slice(0, 50)
          .map(toManagerDeclarationDiagnostic),
      };
    }
    const row = entry.install;
    const packageSnapshot = await loadAgentPluginPackage({
      rootPath: this.store.getPackagePath(
        row.installInstanceId,
        row.currentDigest,
      ),
      fileSystem: createNodePluginPackageFileSystem(),
    });
    const diagnostics: AgentPluginManagerDiagnostic[] =
      packageSnapshot.diagnostics.slice(0, 50).map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: boundedMessage(diagnostic.message),
        ...(diagnostic.componentName
          ? { componentName: diagnostic.componentName }
          : {}),
      }));
    const hasErrors = diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    );
    const status: AgentPluginManagerRow["status"] = !packageSnapshot.valid
      ? "invalid"
      : hasErrors
        ? "partially-loaded"
        : !row.enabled
          ? "disabled"
          : entry.effective === false
            ? "shadowed"
            : "enabled";
    return {
      status,
      manifestName: row.manifestName,
      ...(row.manifestVersion ? { manifestVersion: row.manifestVersion } : {}),
      ...(packageSnapshot.manifest?.description
        ? { description: boundedMessage(packageSnapshot.manifest.description) }
        : {}),
      ...(packageSnapshot.manifest?.author?.name
        ? { author: boundedMessage(packageSnapshot.manifest.author.name) }
        : {}),
      ...(packageSnapshot.manifest?.license
        ? { license: boundedMessage(packageSnapshot.manifest.license) }
        : {}),
      installInstanceId: row.installInstanceId,
      enabled: row.enabled,
      scope: row.scope.kind,
      ...(row.scope.kind === "project"
        ? { projectId: row.scope.projectId }
        : {}),
      source: managerSourceSummary(entry),
      currentDigest: row.currentDigest,
      ...(row.previousDigest ? { previousDigest: row.previousDigest } : {}),
      ...(entry.shadowedByInstallInstanceId
        ? { shadowedByInstallInstanceId: entry.shadowedByInstallInstanceId }
        : {}),
      skills: packageSnapshot.skills.slice(0, 100).map((skill) => ({
        name: skill.name,
        description: boundedMessage(skill.metadata.description),
        ...(skill.metadata.compatibility
          ? { compatibility: boundedMessage(skill.metadata.compatibility) }
          : {}),
        ...(skill.metadata.allowedTools
          ? { allowedTools: boundedMessage(skill.metadata.allowedTools) }
          : {}),
      })),
      mcpServers: Object.entries(packageSnapshot.mcp?.servers ?? {})
        .slice(0, 100)
        .map(([name, server]) => toManagerMcpSummary(name, server, row)),
      hooks: packageSnapshot.hooks
        .flatMap((source) =>
          Object.entries(source.hooks).flatMap(([event, groups]) =>
            (groups ?? []).flatMap((group) =>
              group.hooks.map((handler) => ({
                event,
                ...(group.matcher
                  ? { matcher: boundedMessage(group.matcher) }
                  : {}),
                ...(handler.type === "command"
                  ? { command: boundedMessage(handler.command) }
                  : {}),
                handlerType: handler.type,
                async: handler.type === "command" && handler.async === true,
                sourceRelativePath: source.sourceRelativePath,
              })),
            ),
          ),
        )
        .slice(0, 100),
      diagnostics,
    };
  }

  private requireEnabled(): void {
    if (!this.options.enabled) {
      throw new AgentPluginManagerError(
        "plugins_disabled",
        "Agent Plugins support is currently available only in AgentLink development builds on macOS and Linux.",
      );
    }
  }
}

function managerSourceSummary(
  entry: Readonly<AgentPluginManagerEntry>,
): AgentPluginManagerSourceSummary {
  if (!entry.install) {
    const declaration = entry.declaration;
    return declaration && "git" in declaration.source
      ? {
          kind: "git",
          label: safeRemoteLabel(declaration.source.git),
          shareability: entry.shareability,
        }
      : {
          kind: "workspace-directory",
          label:
            declaration && "path" in declaration.source
              ? declaration.source.path
              : "Declared source",
          shareability: entry.shareability,
        };
  }
  const source = entry.install.source;
  if (source.kind === "git") {
    return {
      kind: source.kind,
      label: `${safeRemoteLabel(source.remote)} @ ${source.commit.slice(0, 12)}`,
      shareability: entry.shareability,
    };
  }
  if (source.kind === "workspace-directory") {
    return {
      kind: source.kind,
      label: source.path,
      shareability: entry.shareability,
    };
  }
  if (source.kind === "remote-archive") {
    return {
      kind: source.kind,
      label: safeRemoteLabel(source.url),
      shareability: entry.shareability,
    };
  }
  return {
    kind: source.kind,
    label: source.label,
    shareability: entry.shareability,
  };
}

function toManagerMcpSummary(
  name: string,
  server: Readonly<AgentPluginMcpServer>,
  row: Readonly<AgentPluginRegistryRow>,
): AgentPluginManagerMcpSummary {
  const policy = row.policy.mcp?.[name] ?? {};
  return server.type === "stdio"
    ? {
        name,
        type: server.type,
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        disabled: policy.disabled ?? false,
        toolPolicy: policy.toolPolicy ?? "ask",
        toolDisclosure: policy.toolDisclosure ?? "auto",
        ...(policy.allowedTools
          ? { allowedTools: [...policy.allowedTools] }
          : {}),
        supportsParallelToolCalls: policy.supportsParallelToolCalls ?? false,
      }
    : {
        name,
        type: server.type,
        url: safeRemoteLabel(server.url),
        headerNames: Object.keys(server.headers ?? {}).sort(),
        disabled: policy.disabled ?? false,
        toolPolicy: policy.toolPolicy ?? "ask",
        toolDisclosure: policy.toolDisclosure ?? "auto",
        ...(policy.allowedTools
          ? { allowedTools: [...policy.allowedTools] }
          : {}),
        supportsParallelToolCalls: policy.supportsParallelToolCalls ?? false,
      };
}

function toManagerDeclarationDiagnostic(
  diagnostic: Readonly<AgentPluginProjectDeclarationDiagnostic>,
): AgentPluginManagerDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: boundedMessage(diagnostic.message),
    ...(diagnostic.name ? { componentName: diagnostic.name } : {}),
  };
}

function safeRemoteLabel(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return boundedMessage(value.replace(/^[^@\s]+@/u, ""));
  }
}

function boundedMessage(value: string, maxLength = 1_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function requireManifest(
  candidate: AgentPluginInstallCandidate,
): AgentPluginManifest {
  if (!candidate.snapshot.valid || !candidate.snapshot.manifest) {
    throw new AgentPluginManagerError(
      "update_candidate_missing",
      "The selected plugin candidate is not valid.",
    );
  }
  return candidate.snapshot.manifest;
}

function withCandidatePath(
  source: AgentPluginSourceProvenance,
  candidatePath: string,
): AgentPluginSourceProvenance {
  const normalizedCandidate = candidatePath === "." ? undefined : candidatePath;
  return {
    ...source,
    ...(normalizedCandidate ? { candidatePath: normalizedCandidate } : {}),
  };
}

async function sourceFromProvenance(
  source: AgentPluginSourceProvenance,
  target: Readonly<AgentPluginInstallTarget>,
): Promise<AgentPluginSource | undefined> {
  if (source.kind === "git") {
    return {
      kind: "git",
      remote: source.remote,
      display: source.remote,
      ...(target.kind === "project" ? { commit: source.commit } : {}),
      ...(source.ref ? { ref: source.ref } : {}),
    };
  }
  if (source.kind === "workspace-directory" && target.kind === "project") {
    const resolved = await resolveAgentPluginProjectDeclaration(target.scope, {
      name: "source",
      source: { path: source.path },
    });
    return resolved.status === "available" ? resolved.source : undefined;
  }
  if (source.kind === "remote-archive") {
    return {
      kind: "remote",
      url: source.url,
      display: source.url,
      hint: "archive",
    };
  }
  return undefined;
}

function declarationForInstall(
  row: Readonly<AgentPluginRegistryRow>,
): AgentPluginProjectDeclaration | undefined {
  if (row.source.kind === "git") {
    return {
      name: row.manifestName,
      source: { git: row.source.remote, commit: row.source.commit },
    };
  }
  if (row.source.kind === "workspace-directory") {
    return {
      name: row.manifestName,
      source: { path: row.source.path },
    };
  }
  return undefined;
}

function declarationMatchesSource(
  declaration: Readonly<AgentPluginProjectDeclaration>,
  source: Readonly<AgentPluginSourceProvenance>,
): boolean {
  return "git" in declaration.source
    ? source.kind === "git" &&
        source.remote === declaration.source.git &&
        source.commit === declaration.source.commit
    : source.kind === "workspace-directory" &&
        source.path === declaration.source.path;
}

function isShareableSource(
  source: Readonly<AgentPluginSourceProvenance>,
): boolean {
  return source.kind === "git" || source.kind === "workspace-directory";
}

function shareabilityForSource(
  source: Readonly<AgentPluginSourceProvenance>,
  target: Readonly<AgentPluginInstallTarget>,
): PreparedAgentPluginInstall["shareability"] {
  if (target.kind === "global") return "not-applicable";
  return isShareableSource(source) ? "shareable" : "not-shareable";
}

function registryScopeForTarget(
  target: Readonly<AgentPluginInstallTarget>,
): AgentPluginRegistryScope {
  return target.kind === "global"
    ? { kind: "global" }
    : {
        kind: "project",
        projectId: target.scope.projectId,
        workspaceFolderUri: target.scope.workspaceFolderUri,
      };
}

function sameProjectScope(
  scope: Readonly<AgentPluginRegistryScope>,
  project: Readonly<SessionProjectScope>,
): boolean {
  return (
    scope.kind === "project" &&
    scope.projectId === project.projectId &&
    scope.workspaceFolderUri === project.workspaceFolderUri
  );
}

function createInstallInstanceId(
  manifestName: string,
  scope: AgentPluginRegistryScope,
  source: AgentPluginSourceProvenance,
): string {
  const prefix = manifestName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .slice(0, 80);
  const identity = createHash("sha256")
    .update(JSON.stringify({ scope, source: sourceIdentity(source) }))
    .digest("hex")
    .slice(0, 16);
  return `${prefix || "plugin"}-${identity}`;
}

function sourceIdentity(source: Readonly<AgentPluginSourceProvenance>): object {
  const candidatePath = source.candidatePath;
  if (source.kind === "git") {
    return {
      kind: source.kind,
      remote: source.remote,
      ref: source.ref,
      candidatePath,
    };
  }
  if (source.kind === "workspace-directory") {
    return { kind: source.kind, path: source.path, candidatePath };
  }
  if (source.kind === "remote-archive") {
    return { kind: source.kind, url: source.url, candidatePath };
  }
  return { kind: source.kind, label: source.label, candidatePath };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameScope(
  left: AgentPluginRegistryScope,
  right: AgentPluginRegistryScope,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "project" &&
        left.projectId === right.projectId &&
        left.workspaceFolderUri === right.workspaceFolderUri))
  );
}

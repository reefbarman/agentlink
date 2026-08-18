import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createHash, randomUUID } from "node:crypto";

import { execFile } from "node:child_process";
import { parseStrictJson } from "../core/agentPlugins/strictJson.js";
import { promisify } from "node:util";
import { sleep } from "../util/sleep.js";

export const AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION = 1 as const;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const INSTALL_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const DEFAULT_LOCK_WAIT_MS = 20_000;
const DEFAULT_LOCK_RETRY_MS = 50;
const execFileAsync = promisify(execFile);

export interface AgentPluginGlobalScope {
  readonly kind: "global";
}

export interface AgentPluginProjectScope {
  readonly kind: "project";
  readonly projectId: string;
  readonly workspaceFolderUri: string;
}

export type AgentPluginRegistryScope =
  | AgentPluginGlobalScope
  | AgentPluginProjectScope;

export interface AgentPluginLocalDirectorySource {
  readonly kind: "local-directory";
  /** Sanitized display label only. Absolute source paths are never persisted. */
  readonly label: string;
  readonly sourceDigest: string;
  readonly candidatePath?: string;
}

export interface AgentPluginWorkspaceDirectorySource {
  readonly kind: "workspace-directory";
  /** POSIX relative path resolved against the row's owning workspace folder. */
  readonly path: string;
  readonly sourceDigest: string;
  readonly candidatePath?: string;
}

export interface AgentPluginLocalArchiveSource {
  readonly kind: "local-archive";
  /** Sanitized display label only. Absolute source paths are never persisted. */
  readonly label: string;
  readonly sourceDigest: string;
  readonly candidatePath?: string;
}

export interface AgentPluginRemoteArchiveSource {
  readonly kind: "remote-archive";
  /** Credential-free HTTP(S) URL used for an explicit manual update. */
  readonly url: string;
  readonly sourceDigest: string;
  readonly candidatePath?: string;
}

export interface AgentPluginGitSource {
  readonly kind: "git";
  /** Credential-free HTTPS, SSH, or SCP-style remote. */
  readonly remote: string;
  readonly commit: string;
  readonly ref?: string;
  readonly candidatePath?: string;
}

export type AgentPluginSourceProvenance =
  | AgentPluginLocalDirectorySource
  | AgentPluginWorkspaceDirectorySource
  | AgentPluginLocalArchiveSource
  | AgentPluginRemoteArchiveSource
  | AgentPluginGitSource;

export interface AgentPluginMcpPolicyOverlay {
  readonly disabled?: boolean;
  readonly toolPolicy?: "ask" | "allow";
  readonly allowedTools?: readonly string[];
  readonly toolDisclosure?: "inline" | "deferred" | "auto";
  readonly supportsParallelToolCalls?: boolean;
}

export interface AgentPluginPolicyOverlay {
  readonly disabledSkillIds?: readonly string[];
  readonly mcp?: Readonly<Record<string, AgentPluginMcpPolicyOverlay>>;
}

export interface AgentPluginRegistryRow {
  readonly installInstanceId: string;
  readonly scope: AgentPluginRegistryScope;
  readonly manifestName: string;
  readonly manifestVersion?: string;
  readonly manifestSchema: string;
  readonly currentDigest: string;
  readonly previousDigest?: string;
  readonly source: AgentPluginSourceProvenance;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly policy: AgentPluginPolicyOverlay;
}

export interface AgentPluginLiveHostMarker {
  readonly token: string;
  readonly pid: number;
  readonly processStartFingerprint: string;
  readonly createdAt: string;
}

export interface AgentPluginRegistry {
  readonly schemaVersion: typeof AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION;
  readonly revision: number;
  readonly installs: Readonly<Record<string, AgentPluginRegistryRow>>;
  readonly liveHosts: Readonly<Record<string, AgentPluginLiveHostMarker>>;
  readonly purgeRequestedAt?: string;
}

export interface AgentPluginRegistryInvalidation {
  readonly previousRevision: number;
  readonly revision: number;
  readonly source: "local-mutation" | "filesystem";
}

export interface AgentPluginDisposable {
  dispose(): void;
}

export type ProcessInstanceInspection =
  | { readonly status: "alive"; readonly processStartFingerprint: string }
  | { readonly status: "dead" }
  | { readonly status: "unverifiable"; readonly reason: string };

export interface ProcessInstanceInspector {
  inspect(pid: number): Promise<ProcessInstanceInspection>;
  current(): Promise<{
    readonly pid: number;
    readonly processStartFingerprint: string;
  }>;
}

interface AgentPluginRegistryLockRecord {
  readonly token: string;
  readonly pid: number;
  readonly processStartFingerprint: string;
  readonly createdAt: string;
}

export interface AgentPluginRegistryWatcher {
  close(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface AgentPluginStoreOptions {
  readonly rootPath: string;
  readonly processInspector?: ProcessInstanceInspector;
  readonly now?: () => Date;
  readonly randomToken?: () => string;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly renameStagedPackage?: (
    source: string,
    destination: string,
  ) => Promise<void>;
  readonly watchRegistryDirectory?: (
    directory: string,
    listener: () => void,
  ) => AgentPluginRegistryWatcher;
}

export interface AgentPluginRegistryMutationRequest<T> {
  readonly expectedRevision: number;
  readonly apply: (registry: Readonly<AgentPluginRegistry>) => {
    readonly registry: AgentPluginRegistry;
    readonly result: T;
  };
}

export interface CommitAgentPluginPackageRequest {
  readonly installInstanceId: string;
  readonly stagedDirectory: string;
  readonly expectedDigest: string;
}

export interface CommitAgentPluginPackageResult {
  readonly digest: string;
  readonly packagePath: string;
  readonly reused: boolean;
}

export class AgentPluginStoreError extends Error {
  constructor(
    readonly code:
      | "registry_corrupt"
      | "registry_schema_unsupported"
      | "registry_revision_conflict"
      | "registry_lock_busy"
      | "registry_lock_unverifiable"
      | "registry_lock_corrupt"
      | "package_corrupt"
      | "package_digest_mismatch"
      | "invalid_install_instance_id"
      | "unsupported_platform",
    message: string,
  ) {
    super(message);
    this.name = "AgentPluginStoreError";
  }
}

export class AgentPluginStore {
  readonly registryPath: string;
  readonly lockPath: string;
  readonly packagesPath: string;
  readonly globalDataPath: string;
  readonly projectDataPath: string;

  private readonly processInspector: ProcessInstanceInspector;
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly listeners = new Set<
    (event: AgentPluginRegistryInvalidation) => void
  >();
  private hostMarker: AgentPluginLiveHostMarker | undefined;
  private watcher: AgentPluginRegistryWatcher | undefined;
  private observedRevision = 0;
  private refreshPromise: Promise<AgentPluginRegistry> | undefined;

  constructor(private readonly options: Readonly<AgentPluginStoreOptions>) {
    this.registryPath = path.join(options.rootPath, "registry.json");
    this.lockPath = path.join(options.rootPath, "registry.lock");
    this.packagesPath = path.join(options.rootPath, "packages");
    const agentLinkRoot = path.dirname(options.rootPath);
    this.globalDataPath = path.join(agentLinkRoot, "plugin-data", "global");
    this.projectDataPath = path.join(agentLinkRoot, "plugin-data", "projects");
    this.processInspector =
      options.processInspector ?? createNodeProcessInstanceInspector();
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? randomUUID;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.platform = options.platform ?? process.platform;
  }

  subscribe(
    listener: (event: AgentPluginRegistryInvalidation) => void,
  ): AgentPluginDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async initializeHost(): Promise<Readonly<AgentPluginRegistry>> {
    this.requireSupportedPlatform();
    if (this.hostMarker) return this.readRegistry();
    const currentProcess = await this.processInspector.current();
    const marker: AgentPluginLiveHostMarker = {
      token: this.randomToken(),
      pid: currentProcess.pid,
      processStartFingerprint: currentProcess.processStartFingerprint,
      createdAt: this.now().toISOString(),
    };
    const registry = await this.withRegistryLock(async () => {
      let latest = await this.readRegistryFile();
      latest = await this.removeProvablyStaleHostMarkers(latest);
      if (
        latest.purgeRequestedAt &&
        Object.keys(latest.liveHosts).length === 0
      ) {
        await this.purgeUnreferencedPackages(latest);
        latest = { ...latest, purgeRequestedAt: undefined };
      }
      const next = incrementRegistry(latest, {
        ...latest,
        liveHosts: { ...latest.liveHosts, [marker.token]: marker },
      });
      await this.writeRegistry(next);
      return next;
    });
    this.hostMarker = marker;
    this.observeRevision(registry.revision, "local-mutation");
    this.startWatcher();
    return registry;
  }

  async dispose(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    const marker = this.hostMarker;
    this.hostMarker = undefined;
    if (!marker) return;
    try {
      const next = await this.withRegistryLock(async () => {
        const latest = await this.readRegistryFile();
        if (latest.liveHosts[marker.token]?.token !== marker.token)
          return latest;
        const liveHosts = { ...latest.liveHosts };
        delete liveHosts[marker.token];
        const updated = incrementRegistry(latest, { ...latest, liveHosts });
        await this.writeRegistry(updated);
        return updated;
      });
      this.observeRevision(next.revision, "local-mutation");
    } catch {
      // Disposal is best effort. Token matching prevents removing another host.
    }
  }

  async readRegistry(): Promise<Readonly<AgentPluginRegistry>> {
    this.requireSupportedPlatform();
    const registry = await this.readRegistryFile();
    this.observeRevision(registry.revision, "filesystem");
    return registry;
  }

  async checkForUpdates(): Promise<Readonly<AgentPluginRegistry>> {
    this.refreshPromise ??= this.readRegistry().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async mutateRegistry<T>(
    request: Readonly<AgentPluginRegistryMutationRequest<T>>,
  ): Promise<{ readonly registry: AgentPluginRegistry; readonly result: T }> {
    this.requireSupportedPlatform();
    const committed = await this.withRegistryLock(async () => {
      const latest = await this.readRegistryFile();
      if (latest.revision !== request.expectedRevision) {
        throw new AgentPluginStoreError(
          "registry_revision_conflict",
          `Agent plugin registry revision changed from ${request.expectedRevision} to ${latest.revision}.`,
        );
      }
      const applied = request.apply(latest);
      const candidate = incrementRegistry(latest, applied.registry);
      const validated = validateAgentPluginRegistry(candidate);
      await this.writeRegistry(validated);
      return { registry: validated, result: applied.result };
    });
    this.observeRevision(committed.registry.revision, "local-mutation");
    return committed;
  }

  async commitPackage(
    request: Readonly<CommitAgentPluginPackageRequest>,
  ): Promise<CommitAgentPluginPackageResult> {
    this.requireSupportedPlatform();
    validateInstallInstanceId(request.installInstanceId);
    validateDigest(request.expectedDigest, "expected package digest");
    const stagedDigest = await digestAgentPluginTree(request.stagedDirectory);
    if (stagedDigest !== request.expectedDigest) {
      throw new AgentPluginStoreError(
        "package_digest_mismatch",
        `Staged package digest ${stagedDigest} does not match expected digest ${request.expectedDigest}.`,
      );
    }
    const packagePath = this.getPackagePath(
      request.installInstanceId,
      request.expectedDigest,
    );
    try {
      return await this.publishPackageGeneration(
        request.stagedDirectory,
        packagePath,
        request.expectedDigest,
        this.options.renameStagedPackage ?? fs.rename,
      );
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error;
    }

    await fs.mkdir(path.dirname(packagePath), {
      recursive: true,
      mode: 0o700,
    });
    const transferPath = `${packagePath}.incoming-${this.randomToken()}`;
    try {
      await fs.cp(request.stagedDirectory, transferPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      const copiedDigest = await digestAgentPluginTree(transferPath);
      if (copiedDigest !== request.expectedDigest) {
        throw new AgentPluginStoreError(
          "package_digest_mismatch",
          `Copied package digest ${copiedDigest} does not match expected digest ${request.expectedDigest}.`,
        );
      }
      return await this.publishPackageGeneration(
        transferPath,
        packagePath,
        request.expectedDigest,
        fs.rename,
      );
    } finally {
      await fs
        .rm(transferPath, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  private async publishPackageGeneration(
    preparedDirectory: string,
    packagePath: string,
    expectedDigest: string,
    rename: (source: string, destination: string) => Promise<void>,
  ): Promise<CommitAgentPluginPackageResult> {
    return this.withRegistryLock(async () => {
      try {
        const stat = await fs.lstat(packagePath);
        if (!stat.isDirectory()) {
          throw new AgentPluginStoreError(
            "package_corrupt",
            `Immutable package path is not a directory: ${packagePath}`,
          );
        }
        await verifyExistingPackageGeneration(
          packagePath,
          expectedDigest,
          "Immutable package generation failed digest verification",
        );
        return { digest: expectedDigest, packagePath, reused: true };
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }

      await fs.mkdir(path.dirname(packagePath), {
        recursive: true,
        mode: 0o700,
      });
      try {
        await rename(preparedDirectory, packagePath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        await verifyExistingPackageGeneration(
          packagePath,
          expectedDigest,
          "Concurrent immutable package generation failed digest verification",
        );
        return { digest: expectedDigest, packagePath, reused: true };
      }
      return { digest: expectedDigest, packagePath, reused: false };
    });
  }

  async requestPurge(expectedRevision: number): Promise<AgentPluginRegistry> {
    return (
      await this.mutateRegistry({
        expectedRevision,
        apply: (registry) => ({
          registry: { ...registry, purgeRequestedAt: this.now().toISOString() },
          result: undefined,
        }),
      })
    ).registry;
  }

  getPackagePath(installInstanceId: string, digest: string): string {
    validateInstallInstanceId(installInstanceId);
    validateDigest(digest, "package digest");
    return path.join(this.packagesPath, installInstanceId, digest);
  }

  getGlobalDataPath(installInstanceId: string): string {
    validateInstallInstanceId(installInstanceId);
    return path.join(this.globalDataPath, installInstanceId);
  }

  getProjectDataPath(
    projectIdentityHash: string,
    installInstanceId: string,
  ): string {
    validateInstallInstanceId(projectIdentityHash);
    validateInstallInstanceId(installInstanceId);
    return path.join(
      this.projectDataPath,
      projectIdentityHash,
      installInstanceId,
    );
  }

  private requireSupportedPlatform(): void {
    if (this.platform === "win32") {
      throw new AgentPluginStoreError(
        "unsupported_platform",
        "Agent Plugins v1 loading is unavailable on Windows.",
      );
    }
  }

  private async readRegistryFile(): Promise<AgentPluginRegistry> {
    let source: string;
    try {
      source = await fs.readFile(this.registryPath, "utf8");
    } catch (error) {
      if (isMissingError(error)) return emptyAgentPluginRegistry();
      throw error;
    }
    const document = parseStrictJson(source);
    if (!document.ok || document.duplicateMembers.length > 0) {
      const detail = document.ok
        ? document.duplicateMembers.map((item) => item.message).join("; ")
        : document.error.message;
      throw new AgentPluginStoreError(
        "registry_corrupt",
        `Agent plugin registry is malformed. Close all VS Code windows and repair ${this.registryPath}: ${detail}`,
      );
    }
    return validateAgentPluginRegistry(document.value);
  }

  private async writeRegistry(registry: AgentPluginRegistry): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = path.join(
      path.dirname(this.registryPath),
      `.registry.json.tmp-${process.pid}-${this.randomToken()}`,
    );
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    let ownsTemporaryPath = true;
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await fs.rename(temporaryPath, this.registryPath);
      ownsTemporaryPath = false;
      await fs.chmod(this.registryPath, 0o600);
      await syncDirectory(path.dirname(this.registryPath), this.platform);
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (ownsTemporaryPath)
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.lockPath), {
      recursive: true,
      mode: 0o700,
    });
    const currentProcess = await this.processInspector.current();
    const owner: AgentPluginRegistryLockRecord = {
      token: this.randomToken(),
      pid: currentProcess.pid,
      processStartFingerprint: currentProcess.processStartFingerprint,
      createdAt: this.now().toISOString(),
    };
    const deadline = Date.now() + this.lockWaitMs;
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        let existing: AgentPluginRegistryLockRecord;
        try {
          existing = await this.readLockRecord();
        } catch (readError) {
          if (isMissingError(readError)) continue;
          throw readError;
        }
        const inspection = await this.processInspector.inspect(existing.pid);
        if (inspection.status === "unverifiable") {
          throw new AgentPluginStoreError(
            "registry_lock_unverifiable",
            `Cannot verify the Agent plugin registry lock owner. Close all VS Code windows and retry: ${inspection.reason}`,
          );
        }
        const stale =
          inspection.status === "dead" ||
          inspection.processStartFingerprint !==
            existing.processStartFingerprint;
        if (stale) {
          await this.removeLockIfTokenMatches(existing.token);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new AgentPluginStoreError(
            "registry_lock_busy",
            "Agent plugin registry is busy in another VS Code window.",
          );
        }
        await sleep(this.lockRetryMs);
      }
    }

    try {
      return await operation();
    } finally {
      await this.removeLockIfTokenMatches(owner.token);
    }
  }

  private async readLockRecord(): Promise<AgentPluginRegistryLockRecord> {
    let document: ReturnType<typeof parseStrictJson>;
    try {
      document = parseStrictJson(await fs.readFile(this.lockPath, "utf8"));
    } catch (error) {
      if (isMissingError(error)) throw error;
      throw new AgentPluginStoreError(
        "registry_lock_corrupt",
        `Agent plugin registry lock is unreadable. Close all VS Code windows and repair ${this.lockPath}.`,
      );
    }
    if (!document.ok || document.duplicateMembers.length > 0) {
      throw new AgentPluginStoreError(
        "registry_lock_corrupt",
        `Agent plugin registry lock is invalid. Close all VS Code windows and repair ${this.lockPath}.`,
      );
    }
    const parsed = document.value;
    if (!isRecord(parsed)) {
      throw new AgentPluginStoreError(
        "registry_lock_corrupt",
        `Agent plugin registry lock is invalid. Close all VS Code windows and repair ${this.lockPath}.`,
      );
    }
    const keys = Object.keys(parsed).sort();
    if (
      keys.join("\0") !==
        ["createdAt", "pid", "processStartFingerprint", "token"]
          .sort()
          .join("\0") ||
      typeof parsed.token !== "string" ||
      !parsed.token ||
      !isPositiveInteger(parsed.pid) ||
      typeof parsed.processStartFingerprint !== "string" ||
      !parsed.processStartFingerprint ||
      !isIsoDate(parsed.createdAt)
    ) {
      throw new AgentPluginStoreError(
        "registry_lock_corrupt",
        `Agent plugin registry lock is invalid. Close all VS Code windows and repair ${this.lockPath}.`,
      );
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      processStartFingerprint: parsed.processStartFingerprint,
      createdAt: parsed.createdAt,
    };
  }

  private async removeLockIfTokenMatches(token: string): Promise<void> {
    let current: AgentPluginRegistryLockRecord;
    try {
      current = await this.readLockRecord();
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    if (current.token !== token) return;
    await fs.unlink(this.lockPath).catch((error) => {
      if (!isMissingError(error)) throw error;
    });
  }

  private async removeProvablyStaleHostMarkers(
    registry: AgentPluginRegistry,
  ): Promise<AgentPluginRegistry> {
    const liveHosts = { ...registry.liveHosts };
    let changed = false;
    for (const marker of Object.values(registry.liveHosts)) {
      const inspection = await this.processInspector.inspect(marker.pid);
      if (
        inspection.status === "dead" ||
        (inspection.status === "alive" &&
          inspection.processStartFingerprint !== marker.processStartFingerprint)
      ) {
        delete liveHosts[marker.token];
        changed = true;
      }
    }
    return changed
      ? incrementRegistry(registry, { ...registry, liveHosts })
      : registry;
  }

  private async purgeUnreferencedPackages(
    registry: Readonly<AgentPluginRegistry>,
  ): Promise<void> {
    const referenced = new Set<string>();
    for (const row of Object.values(registry.installs)) {
      referenced.add(`${row.installInstanceId}\0${row.currentDigest}`);
      if (row.previousDigest) {
        referenced.add(`${row.installInstanceId}\0${row.previousDigest}`);
      }
    }
    let installDirectories: string[];
    try {
      installDirectories = await fs.readdir(this.packagesPath);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    for (const installInstanceId of installDirectories) {
      if (!INSTALL_INSTANCE_ID_PATTERN.test(installInstanceId)) continue;
      const installPath = path.join(this.packagesPath, installInstanceId);
      const digests = await fs.readdir(installPath).catch(() => []);
      for (const digest of digests) {
        if (!DIGEST_PATTERN.test(digest)) continue;
        if (referenced.has(`${installInstanceId}\0${digest}`)) continue;
        await fs.rm(path.join(installPath, digest), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private startWatcher(): void {
    if (this.watcher) return;
    const watch = this.options.watchRegistryDirectory;
    if (watch) {
      this.attachWatcher(watch);
      return;
    }
    void import("node:fs").then((nodeFs) => {
      this.attachWatcher((directory, listener) =>
        nodeFs.watch(directory, listener),
      );
    });
  }

  private attachWatcher(
    watch: NonNullable<AgentPluginStoreOptions["watchRegistryDirectory"]>,
  ): void {
    if (this.watcher) return;
    try {
      const watcher = watch(path.dirname(this.registryPath), () => {
        void this.checkForUpdates().catch(() => undefined);
      });
      watcher.once("error", () => {
        if (this.watcher !== watcher) return;
        this.watcher = undefined;
        try {
          watcher.close();
        } catch {
          // Closing a failed watcher is best effort.
        }
      });
      this.watcher = watcher;
    } catch {
      // Focus/stat checks through checkForUpdates remain authoritative.
    }
  }

  private observeRevision(
    revision: number,
    source: AgentPluginRegistryInvalidation["source"],
  ): void {
    if (revision <= this.observedRevision) return;
    const previousRevision = this.observedRevision;
    this.observedRevision = revision;
    for (const listener of this.listeners) {
      listener({ previousRevision, revision, source });
    }
  }
}

export function emptyAgentPluginRegistry(): AgentPluginRegistry {
  return {
    schemaVersion: AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    installs: {},
    liveHosts: {},
  };
}

export function validateAgentPluginRegistry(
  value: unknown,
): AgentPluginRegistry {
  if (!isRecord(value))
    return corruptRegistry("registry root must be an object");
  if (value.schemaVersion !== AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION) {
    if (isPositiveInteger(value.schemaVersion)) {
      throw new AgentPluginStoreError(
        "registry_schema_unsupported",
        `Agent plugin registry schema ${value.schemaVersion} is not supported. Upgrade AgentLink to activate plugins.`,
      );
    }
    return corruptRegistry("schemaVersion must be 1");
  }
  const allowedRootKeys = new Set([
    "schemaVersion",
    "revision",
    "installs",
    "liveHosts",
    "purgeRequestedAt",
  ]);
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))) {
    return corruptRegistry("registry contains unknown root fields");
  }
  if (!isNonNegativeInteger(value.revision)) {
    return corruptRegistry("revision must be a non-negative integer");
  }
  if (!isRecord(value.installs) || !isRecord(value.liveHosts)) {
    return corruptRegistry("installs and liveHosts must be objects");
  }
  const installs: Record<string, AgentPluginRegistryRow> = {};
  for (const [id, row] of Object.entries(value.installs)) {
    validateInstallInstanceId(id);
    installs[id] = validateRegistryRow(id, row);
  }
  const liveHosts: Record<string, AgentPluginLiveHostMarker> = {};
  for (const [token, marker] of Object.entries(value.liveHosts)) {
    if (!isRecord(marker) || marker.token !== token) {
      return corruptRegistry(`live host marker '${token}' is invalid`);
    }
    if (
      typeof marker.token !== "string" ||
      !marker.token ||
      !isPositiveInteger(marker.pid) ||
      typeof marker.processStartFingerprint !== "string" ||
      !marker.processStartFingerprint ||
      !isIsoDate(marker.createdAt)
    ) {
      return corruptRegistry(`live host marker '${token}' is invalid`);
    }
    liveHosts[token] = {
      token,
      pid: marker.pid,
      processStartFingerprint: marker.processStartFingerprint,
      createdAt: marker.createdAt,
    };
  }
  if (
    value.purgeRequestedAt !== undefined &&
    !isIsoDate(value.purgeRequestedAt)
  ) {
    return corruptRegistry("purgeRequestedAt must be an ISO date");
  }
  return {
    schemaVersion: AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION,
    revision: value.revision,
    installs,
    liveHosts,
    ...(value.purgeRequestedAt === undefined
      ? {}
      : { purgeRequestedAt: value.purgeRequestedAt }),
  };
}

export async function digestAgentPluginTree(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.posix.join(
        relativeDirectory,
        entry.name.split(path.sep).join(path.posix.sep),
      );
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`f\0${relativePath}\0`);
        hash.update(await fs.readFile(absolutePath));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relativePath}\0${await fs.readlink(absolutePath)}\0`);
      } else {
        throw new AgentPluginStoreError(
          "package_corrupt",
          `Unsupported special file in Agent plugin package: ${absolutePath}`,
        );
      }
    }
  };
  const stat = await fs.lstat(rootPath);
  if (!stat.isDirectory()) {
    throw new AgentPluginStoreError(
      "package_corrupt",
      `Agent plugin package root is not a directory: ${rootPath}`,
    );
  }
  await walk(rootPath, "");
  return hash.digest("hex");
}

export function createNodeProcessInstanceInspector(): ProcessInstanceInspector {
  const inspect = async (pid: number): Promise<ProcessInstanceInspection> => {
    const alive = probeProcess(pid);
    if (alive === false) return { status: "dead" };
    if (alive === undefined) {
      return {
        status: "unverifiable",
        reason: `permission denied while checking PID ${pid}`,
      };
    }
    try {
      const fingerprint = await readProcessStartFingerprint(pid);
      return { status: "alive", processStartFingerprint: fingerprint };
    } catch (error) {
      const after = probeProcess(pid);
      if (after === false) return { status: "dead" };
      return {
        status: "unverifiable",
        reason: errorMessage(error),
      };
    }
  };
  return {
    inspect,
    async current() {
      const result = await inspect(process.pid);
      if (result.status !== "alive") {
        throw new AgentPluginStoreError(
          "registry_lock_unverifiable",
          "Cannot determine the current extension host process identity.",
        );
      }
      return {
        pid: process.pid,
        processStartFingerprint: result.processStartFingerprint,
      };
    },
  };
}

async function readProcessStartFingerprint(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fieldsAfterCommand = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    if (!startTime) throw new Error(`missing Linux start time for PID ${pid}`);
    return `linux:${startTime}`;
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-o",
      "lstart=",
      "-p",
      String(pid),
    ]);
    const startTime = stdout.trim();
    if (!startTime) throw new Error(`missing macOS start time for PID ${pid}`);
    return `darwin:${startTime}`;
  }
  throw new Error(
    `process start identity is unsupported on ${process.platform}`,
  );
}

function probeProcess(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return undefined;
    return undefined;
  }
}

function validateRegistryRow(
  installInstanceId: string,
  value: unknown,
): AgentPluginRegistryRow {
  if (!isRecord(value) || value.installInstanceId !== installInstanceId) {
    return corruptRegistry(`install row '${installInstanceId}' is invalid`);
  }
  const allowedKeys = new Set([
    "installInstanceId",
    "scope",
    "manifestName",
    "manifestVersion",
    "manifestSchema",
    "currentDigest",
    "previousDigest",
    "source",
    "enabled",
    "installedAt",
    "updatedAt",
    "policy",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return corruptRegistry(
      `install row '${installInstanceId}' has unknown fields`,
    );
  }
  const scope = validateScope(value.scope, installInstanceId);
  if (
    typeof value.manifestName !== "string" ||
    !value.manifestName ||
    (value.manifestVersion !== undefined &&
      typeof value.manifestVersion !== "string") ||
    typeof value.manifestSchema !== "string" ||
    !value.manifestSchema ||
    typeof value.enabled !== "boolean" ||
    !isIsoDate(value.installedAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    return corruptRegistry(
      `install row '${installInstanceId}' has invalid metadata`,
    );
  }
  validateDigest(value.currentDigest, "currentDigest");
  if (value.previousDigest !== undefined) {
    validateDigest(value.previousDigest, "previousDigest");
  }
  const source = validateSource(value.source, installInstanceId);
  const policy = validatePolicy(value.policy, installInstanceId);
  return {
    installInstanceId,
    scope,
    manifestName: value.manifestName,
    ...(value.manifestVersion === undefined
      ? {}
      : { manifestVersion: value.manifestVersion }),
    manifestSchema: value.manifestSchema,
    currentDigest: value.currentDigest,
    ...(value.previousDigest === undefined
      ? {}
      : { previousDigest: value.previousDigest }),
    source,
    enabled: value.enabled,
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
    policy,
  };
}

function validateScope(
  value: unknown,
  rowId: string,
): AgentPluginRegistryScope {
  if (
    !isRecord(value) ||
    (value.kind !== "global" && value.kind !== "project")
  ) {
    return corruptRegistry(`install row '${rowId}' has invalid scope`);
  }
  const expectedKeys =
    value.kind === "global"
      ? ["kind"]
      : ["kind", "projectId", "workspaceFolderUri"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")) {
    return corruptRegistry(`install row '${rowId}' has invalid scope fields`);
  }
  if (value.kind === "global") return { kind: "global" };
  if (
    typeof value.projectId !== "string" ||
    !value.projectId ||
    typeof value.workspaceFolderUri !== "string" ||
    !value.workspaceFolderUri
  ) {
    return corruptRegistry(`install row '${rowId}' has invalid project scope`);
  }
  return {
    kind: "project",
    projectId: value.projectId,
    workspaceFolderUri: value.workspaceFolderUri,
  };
}

function validateSource(
  value: unknown,
  rowId: string,
): AgentPluginSourceProvenance {
  if (!isRecord(value)) {
    return corruptRegistry(
      `install row '${rowId}' has invalid source provenance`,
    );
  }
  const candidatePath = validateCandidatePath(value.candidatePath, rowId);
  if (value.kind === "workspace-directory") {
    requireExactKeys(
      value,
      [
        "kind",
        "path",
        "sourceDigest",
        ...(candidatePath ? ["candidatePath"] : []),
      ],
      rowId,
    );
    if (
      typeof value.path !== "string" ||
      !isSafeRelativePath(value.path) ||
      typeof value.sourceDigest !== "string"
    ) {
      return corruptRegistry(
        `install row '${rowId}' has invalid workspace source provenance`,
      );
    }
    validateDigest(value.sourceDigest, "sourceDigest");
    return {
      kind: "workspace-directory",
      path: value.path,
      sourceDigest: value.sourceDigest,
      ...(candidatePath ? { candidatePath } : {}),
    };
  }
  if (value.kind === "local-directory" || value.kind === "local-archive") {
    requireExactKeys(
      value,
      [
        "kind",
        "label",
        "sourceDigest",
        ...(candidatePath ? ["candidatePath"] : []),
      ],
      rowId,
    );
    if (
      typeof value.label !== "string" ||
      !value.label ||
      path.isAbsolute(value.label) ||
      value.label.includes("/") ||
      value.label.includes("\\") ||
      typeof value.sourceDigest !== "string"
    ) {
      return corruptRegistry(
        `install row '${rowId}' has invalid source provenance`,
      );
    }
    validateDigest(value.sourceDigest, "sourceDigest");
    return {
      kind: value.kind,
      label: value.label,
      sourceDigest: value.sourceDigest,
      ...(candidatePath ? { candidatePath } : {}),
    };
  }
  if (value.kind === "remote-archive") {
    requireExactKeys(
      value,
      [
        "kind",
        "url",
        "sourceDigest",
        ...(candidatePath ? ["candidatePath"] : []),
      ],
      rowId,
    );
    if (
      typeof value.url !== "string" ||
      !isSafePersistedHttpUrl(value.url) ||
      typeof value.sourceDigest !== "string"
    ) {
      return corruptRegistry(
        `install row '${rowId}' has invalid remote archive provenance`,
      );
    }
    validateDigest(value.sourceDigest, "sourceDigest");
    return {
      kind: "remote-archive",
      url: value.url,
      sourceDigest: value.sourceDigest,
      ...(candidatePath ? { candidatePath } : {}),
    };
  }
  if (value.kind === "git") {
    requireExactKeys(
      value,
      [
        "kind",
        "remote",
        "commit",
        ...(value.ref === undefined ? [] : ["ref"]),
        ...(candidatePath ? ["candidatePath"] : []),
      ],
      rowId,
    );
    if (
      typeof value.remote !== "string" ||
      !isSafePersistedGitRemote(value.remote) ||
      typeof value.commit !== "string" ||
      !/^[a-f0-9]{40,64}$/u.test(value.commit) ||
      (value.ref !== undefined &&
        (typeof value.ref !== "string" || !isSafeGitRef(value.ref)))
    ) {
      return corruptRegistry(
        `install row '${rowId}' has invalid Git provenance`,
      );
    }
    return {
      kind: "git",
      remote: value.remote,
      commit: value.commit,
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
      ...(candidatePath ? { candidatePath } : {}),
    };
  }
  return corruptRegistry(
    `install row '${rowId}' has unknown source provenance`,
  );
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  rowId: string,
): void {
  if (
    Object.keys(value).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    corruptRegistry(`install row '${rowId}' has invalid source fields`);
  }
}

function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    value !== "." &&
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => Boolean(segment) && segment !== "." && segment !== "..",
      )
  );
}

function validateCandidatePath(
  value: unknown,
  rowId: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return corruptRegistry(`install row '${rowId}' has invalid candidate path`);
  }
  return value;
}

function isSafePersistedHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function isSafePersistedGitRemote(value: string): boolean {
  if (
    hasControlCharacter(value) ||
    value.startsWith("-") ||
    /\s/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.hash || parsed.password) return false;
    if (parsed.protocol === "ssh:") return true;
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username
    );
  } catch {
    return /^(?![A-Za-z]:[\\/])(?:[^@\s/:]+@)?[^\s/:]+:[^\s]+$/u.test(value);
  }
}

function isSafeGitRef(value: string): boolean {
  return (
    value.length <= 255 &&
    !hasControlCharacter(value) &&
    !/\s/u.test(value) &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{")
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function validatePolicy(
  value: unknown,
  rowId: string,
): AgentPluginPolicyOverlay {
  if (!isRecord(value)) {
    return corruptRegistry(`install row '${rowId}' has invalid policy overlay`);
  }
  if (
    Object.keys(value).some(
      (key) => key !== "disabledSkillIds" && key !== "mcp",
    )
  ) {
    return corruptRegistry(`install row '${rowId}' has unknown policy fields`);
  }
  if (
    value.disabledSkillIds !== undefined &&
    (!Array.isArray(value.disabledSkillIds) ||
      !value.disabledSkillIds.every((item) => typeof item === "string"))
  ) {
    return corruptRegistry(
      `install row '${rowId}' has invalid disabledSkillIds`,
    );
  }
  if (value.mcp !== undefined && !isRecord(value.mcp)) {
    return corruptRegistry(`install row '${rowId}' has invalid MCP policy`);
  }
  const mcp: Record<string, AgentPluginMcpPolicyOverlay> | undefined =
    value.mcp === undefined ? undefined : {};
  for (const [serverName, serverPolicy] of Object.entries(value.mcp ?? {})) {
    if (!serverName || !isRecord(serverPolicy)) {
      return corruptRegistry(`install row '${rowId}' has invalid MCP policy`);
    }
    const allowedKeys = new Set([
      "disabled",
      "toolPolicy",
      "allowedTools",
      "toolDisclosure",
      "supportsParallelToolCalls",
    ]);
    if (Object.keys(serverPolicy).some((key) => !allowedKeys.has(key))) {
      return corruptRegistry(
        `install row '${rowId}' has unknown MCP policy fields`,
      );
    }
    if (
      (serverPolicy.disabled !== undefined &&
        typeof serverPolicy.disabled !== "boolean") ||
      (serverPolicy.toolPolicy !== undefined &&
        serverPolicy.toolPolicy !== "ask" &&
        serverPolicy.toolPolicy !== "allow") ||
      (serverPolicy.allowedTools !== undefined &&
        (!Array.isArray(serverPolicy.allowedTools) ||
          !serverPolicy.allowedTools.every(
            (item) => typeof item === "string" && item.length > 0,
          ))) ||
      (serverPolicy.toolDisclosure !== undefined &&
        serverPolicy.toolDisclosure !== "inline" &&
        serverPolicy.toolDisclosure !== "deferred" &&
        serverPolicy.toolDisclosure !== "auto") ||
      (serverPolicy.supportsParallelToolCalls !== undefined &&
        typeof serverPolicy.supportsParallelToolCalls !== "boolean")
    ) {
      return corruptRegistry(`install row '${rowId}' has invalid MCP policy`);
    }
    mcp![serverName] = {
      ...(serverPolicy.disabled === undefined
        ? {}
        : { disabled: serverPolicy.disabled }),
      ...(serverPolicy.toolPolicy === undefined
        ? {}
        : { toolPolicy: serverPolicy.toolPolicy }),
      ...(serverPolicy.allowedTools === undefined
        ? {}
        : { allowedTools: [...serverPolicy.allowedTools] as string[] }),
      ...(serverPolicy.toolDisclosure === undefined
        ? {}
        : { toolDisclosure: serverPolicy.toolDisclosure }),
      ...(serverPolicy.supportsParallelToolCalls === undefined
        ? {}
        : {
            supportsParallelToolCalls: serverPolicy.supportsParallelToolCalls,
          }),
    };
  }
  return {
    ...(value.disabledSkillIds === undefined
      ? {}
      : { disabledSkillIds: [...value.disabledSkillIds] as string[] }),
    ...(mcp === undefined ? {} : { mcp }),
  };
}

function incrementRegistry(
  previous: Readonly<AgentPluginRegistry>,
  candidate: Readonly<AgentPluginRegistry>,
): AgentPluginRegistry {
  return {
    ...candidate,
    schemaVersion: AGENT_PLUGIN_REGISTRY_SCHEMA_VERSION,
    revision: previous.revision + 1,
  };
}

function validateInstallInstanceId(value: string): void {
  if (!INSTALL_INSTANCE_ID_PATTERN.test(value)) {
    throw new AgentPluginStoreError(
      "invalid_install_instance_id",
      `Invalid Agent plugin install-instance ID '${value}'.`,
    );
  }
}

function validateDigest(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    corruptRegistry(`${field} must be a lowercase SHA-256 digest`);
  }
}

function corruptRegistry(message: string): never {
  throw new AgentPluginStoreError(
    "registry_corrupt",
    `Agent plugin registry is corrupt: ${message}. Close all VS Code windows and repair the registry before retrying.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "");
}

function isCrossDeviceError(error: unknown): boolean {
  return errorCode(error) === "EXDEV";
}

async function verifyExistingPackageGeneration(
  packagePath: string,
  expectedDigest: string,
  message: string,
): Promise<void> {
  const existingDigest = await digestAgentPluginTree(packagePath);
  if (existingDigest !== expectedDigest) {
    throw new AgentPluginStoreError(
      "package_corrupt",
      `${message}: ${packagePath}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncDirectory(
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(directory, "r");
  } catch (error) {
    if (
      platform === "win32" &&
      ["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(errorCode(error) ?? "")
    ) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

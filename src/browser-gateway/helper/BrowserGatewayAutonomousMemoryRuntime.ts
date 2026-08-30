import type {
  ManageMemoryToolRequest,
  MemoryActivityRequest,
  RecallMemoryToolRequest,
} from "@agentlink/protocol/autonomous-memory";
import type {
  MemoryInspectionProvider,
  MemoryToolProvider,
} from "../../core/capabilities/memory.js";
import {
  getSharedMemoryConfigPath,
  getSharedMemoryStoreRoot,
} from "../../storage/retrieval/sharedMemoryStorePaths.js";

import { AutonomousMemoryToolProvider } from "../../storage/retrieval/AutonomousMemoryToolProvider.js";
import type { BrowserGatewayMemoryRuntimeDescriptor } from "../protocol.js";
import type { MemoryHealthSnapshot } from "@agentlink/protocol/autonomous-memory";
import type { SharedMemoryConfigSnapshot } from "../../storage/retrieval/sharedMemoryConfig.js";
import { SharedMemoryConfigStore } from "../../storage/retrieval/sharedMemoryConfig.js";
import { isSharedMemoryMigrationPending } from "../../storage/retrieval/sharedMemoryMigrationState.js";

export type BrowserGatewayMemoryRuntimeReason =
  | "disabled"
  | "config_invalid"
  | "config_unreadable"
  | "migration_pending";

export interface BrowserGatewayMemoryRuntimeResolution {
  mode: BrowserGatewayMemoryRuntimeDescriptor["mode"];
  retrievalStoreRoot: string;
  reason?: BrowserGatewayMemoryRuntimeReason;
}

interface DisposableMemoryToolProvider
  extends MemoryToolProvider, MemoryInspectionProvider {
  dispose(): Promise<void>;
}

export interface BrowserGatewayAutonomousMemoryRuntimeOptions {
  homeDir?: string;
  configStore?: Pick<SharedMemoryConfigStore, "read">;
  isMigrationPending?: () => Promise<boolean>;
  createProvider?: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => DisposableMemoryToolProvider;
}

export class BrowserGatewayAutonomousMemoryRuntime implements DisposableMemoryToolProvider {
  private readonly retrievalStoreRoot: string;
  private readonly configStore: Pick<SharedMemoryConfigStore, "read">;
  private readonly isMigrationPending: () => Promise<boolean>;
  private resolution: BrowserGatewayMemoryRuntimeResolution;
  private provider: DisposableMemoryToolProvider | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly createProvider: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => DisposableMemoryToolProvider;

  constructor(options: BrowserGatewayAutonomousMemoryRuntimeOptions = {}) {
    this.retrievalStoreRoot = getSharedMemoryStoreRoot(options.homeDir);
    this.configStore =
      options.configStore ??
      new SharedMemoryConfigStore(getSharedMemoryConfigPath(options.homeDir));
    this.isMigrationPending =
      options.isMigrationPending ??
      (() => isSharedMemoryMigrationPending(options.homeDir));
    this.resolution = {
      mode: "off",
      retrievalStoreRoot: this.retrievalStoreRoot,
      reason: "disabled",
    };
    this.createProvider =
      options.createProvider ??
      ((descriptor) =>
        new AutonomousMemoryToolProvider({
          root: descriptor.retrievalStoreRoot,
          getMode: () => this.resolution.mode,
        }));
  }

  getResolution(): BrowserGatewayMemoryRuntimeResolution {
    return { ...this.resolution };
  }

  async manage(request: ManageMemoryToolRequest) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).manage(request),
    );
  }

  async recall(request: RecallMemoryToolRequest) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).recall(request),
    );
  }

  async health(): Promise<MemoryHealthSnapshot> {
    return await this.runExclusive(async () => {
      await this.refreshResolution();
      if (this.resolution.mode !== "autonomous") {
        return unavailableHealth(this.resolution.reason);
      }
      return await (await this.requireProvider()).health();
    });
  }

  async activity(request: MemoryActivityRequest) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).activity(request),
    );
  }

  async query(...args: Parameters<MemoryInspectionProvider["query"]>) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).query(...args),
    );
  }

  async detail(...args: Parameters<MemoryInspectionProvider["detail"]>) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).detail(...args),
    );
  }

  async manageAsUser(
    ...args: Parameters<MemoryInspectionProvider["manageAsUser"]>
  ) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).manageAsUser(...args),
    );
  }

  async clearScope(
    ...args: Parameters<MemoryInspectionProvider["clearScope"]>
  ) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).clearScope(...args),
    );
  }

  async exportArchive(
    ...args: Parameters<MemoryInspectionProvider["exportArchive"]>
  ) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).exportArchive(...args),
    );
  }

  async importArchive(
    ...args: Parameters<MemoryInspectionProvider["importArchive"]>
  ) {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).importArchive(...args),
    );
  }

  async dispose(): Promise<void> {
    await this.runExclusive(async () => {
      const provider = this.provider;
      this.provider = undefined;
      if (provider) await provider.dispose();
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshResolution(): Promise<void> {
    const snapshot = await this.configStore.read();
    const next = (await this.isMigrationPending())
      ? {
          mode: "off" as const,
          retrievalStoreRoot: this.retrievalStoreRoot,
          reason: "migration_pending" as const,
        }
      : resolveBrowserGatewayMemoryRuntime(snapshot, this.retrievalStoreRoot);
    if (this.provider && next.mode !== "autonomous") {
      await this.provider.dispose();
      this.provider = undefined;
    }
    this.resolution = next;
  }

  private async requireProvider(): Promise<DisposableMemoryToolProvider> {
    await this.refreshResolution();
    if (this.resolution.mode !== "autonomous") {
      throw new Error(
        `Autonomous memory is unavailable in Browser Ask Agent: ${this.resolution.reason ?? "disabled"}.`,
      );
    }
    this.provider ??= this.createProvider({
      mode: "autonomous",
      retrievalStoreRoot: this.retrievalStoreRoot,
    });
    return this.provider;
  }
}

export function resolveBrowserGatewayMemoryRuntime(
  snapshot: SharedMemoryConfigSnapshot,
  retrievalStoreRoot: string,
): BrowserGatewayMemoryRuntimeResolution {
  if (snapshot.mode !== "autonomous") {
    return {
      mode: "off",
      retrievalStoreRoot,
      reason: snapshot.reason ?? "disabled",
    };
  }
  return { mode: "autonomous", retrievalStoreRoot };
}

function unavailableHealth(
  reason: BrowserGatewayMemoryRuntimeResolution["reason"],
): MemoryHealthSnapshot {
  return {
    status: "unavailable",
    retrieval: "unavailable",
    crud: false,
    dedupe: false,
    conflict: false,
    auditUndo: false,
    recordCount: 0,
    activeRecordCount: 0,
    auditEventCount: 0,
    reason: reason ?? "disabled",
  };
}

import type {
  DerivedSessionInspection,
  DerivedSessionRecallRequest,
  DerivedSessionRecallResult,
  DerivedSessionScope,
  PublishDerivedSessionRequest,
} from "../../core/session/DerivedSessionRetrievalService.js";
import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { LanceDbRetrievalRepository } from "../../storage/retrieval/LanceDbRetrievalRepository.js";
import { isSharedMemoryMigrationPending } from "../../storage/retrieval/sharedMemoryMigrationState.js";
import { getSharedMemoryStoreRoot } from "../../storage/retrieval/sharedMemoryStorePaths.js";
import type { BrowserGatewayMemoryRuntimeDescriptor } from "../protocol.js";
import {
  migrateBrowserGatewayAskAgentMemory,
  type BrowserGatewayAskAgentMemoryMigrationResult,
} from "./browserGatewayAskAgentMemoryMigration.js";

export interface BrowserGatewayDerivedSessionRuntimeResolution {
  status: "ready" | "unavailable";
  retrievalStoreRoot: string;
  reason?: "migration-failed" | "migration-pending";
  detail?: string;
  migration?: BrowserGatewayAskAgentMemoryMigrationResult;
}

export interface BrowserGatewayDerivedSessionProvider {
  initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult>;
  publish(request: PublishDerivedSessionRequest): Promise<void>;
  recall(
    request: DerivedSessionRecallRequest,
  ): Promise<DerivedSessionRecallResult[]>;
  deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }): Promise<"deleted" | "stale_source" | "not_found">;
  clearScope(request: {
    scope: DerivedSessionScope;
    surface?: string;
  }): Promise<{ sourcesDeleted: number; recordsRemoved: number }>;
  inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }): Promise<DerivedSessionInspection>;
  dispose(): Promise<void>;
}

export interface BrowserGatewayDerivedSessionRuntimeOptions {
  homeDir?: string;
  isMigrationPending?: () => Promise<boolean>;
  createProvider?: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => BrowserGatewayDerivedSessionProvider;
}

export class BrowserGatewayDerivedSessionRuntime implements BrowserGatewayDerivedSessionProvider {
  private readonly retrievalStoreRoot: string;
  private resolution: BrowserGatewayDerivedSessionRuntimeResolution;
  private provider: BrowserGatewayDerivedSessionProvider | undefined;
  private initialization:
    | Promise<BrowserGatewayAskAgentMemoryMigrationResult>
    | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly isMigrationPending: () => Promise<boolean>;
  private readonly createProvider: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => BrowserGatewayDerivedSessionProvider;

  constructor(options: BrowserGatewayDerivedSessionRuntimeOptions = {}) {
    this.retrievalStoreRoot = getSharedMemoryStoreRoot(options.homeDir);
    this.resolution = {
      status: "ready",
      retrievalStoreRoot: this.retrievalStoreRoot,
    };
    this.isMigrationPending =
      options.isMigrationPending ??
      (() => isSharedMemoryMigrationPending(options.homeDir));
    this.createProvider =
      options.createProvider ??
      ((descriptor) => new LanceDbDerivedSessionProvider(descriptor));
  }

  getResolution(): BrowserGatewayDerivedSessionRuntimeResolution {
    return structuredClone(this.resolution);
  }

  async initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
    return await this.runExclusive(() => this.ensureInitialized());
  }

  async publish(request: PublishDerivedSessionRequest): Promise<void> {
    await this.runExclusive(async () =>
      (await this.requireProvider()).publish(request),
    );
  }

  async recall(
    request: DerivedSessionRecallRequest,
  ): Promise<DerivedSessionRecallResult[]> {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).recall(request),
    );
  }

  async deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }): Promise<"deleted" | "stale_source" | "not_found"> {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).deleteSession(request),
    );
  }

  async clearScope(request: {
    scope: DerivedSessionScope;
    surface?: string;
  }): Promise<{ sourcesDeleted: number; recordsRemoved: number }> {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).clearScope(request),
    );
  }

  async inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }): Promise<DerivedSessionInspection> {
    return await this.runExclusive(async () =>
      (await this.requireProvider()).inspect(request),
    );
  }

  async dispose(): Promise<void> {
    await this.runExclusive(async () => {
      const provider = this.provider;
      this.provider = undefined;
      this.initialization = undefined;
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

  private async ensureInitialized(): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
    if (await this.isMigrationPending()) {
      this.resolution = {
        status: "unavailable",
        retrievalStoreRoot: this.retrievalStoreRoot,
        reason: "migration-pending",
      };
      throw new Error(
        "Derived session retrieval is unavailable while shared memory migration is running.",
      );
    }
    if (
      this.resolution.reason === "migration-failed" ||
      this.resolution.reason === "migration-pending"
    ) {
      const failedProvider = this.provider;
      this.provider = undefined;
      this.initialization = undefined;
      this.resolution = {
        status: "ready",
        retrievalStoreRoot: this.retrievalStoreRoot,
      };
      if (failedProvider) await failedProvider.dispose();
    }
    this.provider ??= this.createProvider({
      mode: "off",
      retrievalStoreRoot: this.retrievalStoreRoot,
    });
    if (!this.initialization) {
      const provider = this.provider;
      this.initialization = provider
        .initialize()
        .then((migration) => {
          this.resolution = {
            status: "ready",
            retrievalStoreRoot: this.retrievalStoreRoot,
            migration,
          };
          if (migration.status === "missing") {
            this.initialization = undefined;
          }
          return migration;
        })
        .catch((error) => {
          this.initialization = undefined;
          this.resolution = {
            status: "unavailable",
            retrievalStoreRoot: this.retrievalStoreRoot,
            reason: "migration-failed",
            detail: error instanceof Error ? error.message : String(error),
          };
          throw error;
        });
    }
    return await this.initialization;
  }

  private async requireProvider(): Promise<BrowserGatewayDerivedSessionProvider> {
    await this.ensureInitialized();
    return this.provider!;
  }
}

class LanceDbDerivedSessionProvider implements BrowserGatewayDerivedSessionProvider {
  private readonly repository: LanceDbRetrievalRepository;
  private readonly service: DerivedSessionRetrievalService;
  private migration:
    | Promise<BrowserGatewayAskAgentMemoryMigrationResult>
    | undefined;

  constructor(descriptor: BrowserGatewayMemoryRuntimeDescriptor) {
    this.repository = new LanceDbRetrievalRepository({
      root: descriptor.retrievalStoreRoot,
    });
    this.service = new DerivedSessionRetrievalService(this.repository);
  }

  initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
    this.migration ??= migrateBrowserGatewayAskAgentMemory({
      service: this.service,
    }).then((result) => {
      if (result.status === "missing") this.migration = undefined;
      return result;
    });
    return this.migration;
  }

  async publish(request: PublishDerivedSessionRequest): Promise<void> {
    const outcome = await this.service.upsert(request);
    if (outcome.status !== "published") {
      throw new Error(
        `Derived session publication was not committed: ${outcome.status}`,
      );
    }
  }

  async recall(request: DerivedSessionRecallRequest) {
    return await this.service.recall(request);
  }

  async deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }) {
    return await this.service.deleteSession(request);
  }

  async clearScope(request: { scope: DerivedSessionScope; surface?: string }) {
    return await this.service.clearScope(request);
  }

  async inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }) {
    return await this.service.inspect(request);
  }

  async dispose(): Promise<void> {
    await this.repository.close();
  }
}
